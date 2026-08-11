"""Workspace retention sweeper — TTL erasure of conversation input/output caches.

The sweeper deletes files, so these tests pin its safety envelope as much as
its function: scope confinement (memory/ and loose conversation files are
untouchable), symlink hostility, per-scope disable, and the recent-activity
grace that protects in-flight runs.
"""
from __future__ import annotations

import importlib
import os
import time
from pathlib import Path

HOUR = 3600


def _touch(path: Path, *, age_hours: float) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("x", encoding="utf-8")
    stamp = time.time() - age_hours * HOUR
    os.utime(path, (stamp, stamp))


def _conv_dir(root: Path, user: str = "user-1", agent: str = "agent-1", conv: str = "conv-1") -> Path:
    """A conversation dir in the consolidated layout.

    ``root`` is the *workspaces plane*, so the tree is
    ``<plane>/users/<user>/agents/<agent>/conversations/<conv>``. Conversations
    live under their own parent, which is what lets the sweeper identify one by
    position instead of by not-matching a list of sibling names.
    """
    return root / "users" / user / "agents" / agent / "conversations" / conv


def _retention(agents_service, tmp_root: Path, *, input_ttl=72, output_ttl=168):
    fs = agents_service.main.settings.filesystem
    fs.workspaces_root = tmp_root
    fs.input_ttl_hours = input_ttl
    fs.output_ttl_hours = output_ttl
    return importlib.import_module("runtime.filesystem.retention")


def test_sweep_deletes_only_expired_cache_files(agents_service, tmp_path):
    conv = _conv_dir(tmp_path)
    # Over-TTL cache files → deleted. (Ages sit past TTL but the whole tree
    # must be older than the 30-min activity grace, hence nothing "fresh".)
    _touch(conv / "input" / "old-upload.pdf", age_hours=80)
    _touch(conv / "output" / "nested" / "old-report.docx", age_hours=200)
    # Under-TTL cache files → kept.
    _touch(conv / "input" / "recent-upload.pdf", age_hours=40)
    _touch(conv / "output" / "recent-report.docx", age_hours=40)
    # Out-of-scope files → untouchable regardless of age.
    # conv.parent is `conversations/`; the agent root (memory/, skills/,
    # default_skills/) is one level above and must never be reachable.
    _touch(conv.parent.parent / "memory" / "AGENTS.md", age_hours=999)
    _touch(conv.parent.parent / "default_skills" / "s" / "SKILL.md", age_hours=999)
    _touch(conv / "loose-note.md", age_hours=999)
    _touch(conv / "large_tool_results" / "blob.json", age_hours=999)

    retention = _retention(agents_service, tmp_path)
    stats = retention.sweep_workspace_retention_once()

    assert not (conv / "input" / "old-upload.pdf").exists()
    assert not (conv / "output" / "nested" / "old-report.docx").exists()
    assert not (conv / "output" / "nested").exists()  # empty subdir pruned
    assert (conv / "input" / "recent-upload.pdf").exists()
    assert (conv / "output" / "recent-report.docx").exists()
    assert (conv.parent.parent / "memory" / "AGENTS.md").exists()
    # A new sibling under the agent root is out of scope by position, not by a
    # maintained name denylist — this is the point of the conversations/ parent.
    assert (conv.parent.parent / "default_skills" / "s" / "SKILL.md").exists()
    assert (conv / "loose-note.md").exists()
    assert (conv / "large_tool_results" / "blob.json").exists()
    assert (conv / "input").is_dir()  # scope dirs themselves always survive
    assert stats.files_deleted == 2
    assert stats.dirs_pruned >= 1


def test_zero_ttl_disables_that_scope_only(agents_service, tmp_path):
    conv = _conv_dir(tmp_path)
    _touch(conv / "input" / "ancient.pdf", age_hours=999)
    _touch(conv / "output" / "ancient.docx", age_hours=999)

    retention = _retention(agents_service, tmp_path, input_ttl=0, output_ttl=168)
    retention.sweep_workspace_retention_once()

    assert (conv / "input" / "ancient.pdf").exists()      # scope disabled
    assert not (conv / "output" / "ancient.docx").exists()  # scope active


def test_recent_activity_skips_the_conversation(agents_service, tmp_path):
    conv = _conv_dir(tmp_path)
    _touch(conv / "output" / "expired-mid-run.docx", age_hours=200)
    # A just-written file marks the conversation as active (run in flight).
    _touch(conv / "output" / "being-written-now.tmp", age_hours=0)

    retention = _retention(agents_service, tmp_path)
    stats = retention.sweep_workspace_retention_once()

    assert (conv / "output" / "expired-mid-run.docx").exists()
    assert stats.conversations_skipped_active >= 1


def test_symlinks_are_removed_not_followed(agents_service, tmp_path):
    conv = _conv_dir(tmp_path)
    secret = tmp_path / "outside" / "secret.txt"
    _touch(secret, age_hours=999)
    (conv / "output").mkdir(parents=True, exist_ok=True)
    link = conv / "output" / "sneaky-link"
    link.symlink_to(secret)
    # Age the link itself (lstat mtime) past the activity grace, or the sweep
    # would legitimately defer this conversation to a later pass.
    stamp = time.time() - 2 * HOUR
    os.utime(link, (stamp, stamp), follow_symlinks=False)

    retention = _retention(agents_service, tmp_path)
    stats = retention.sweep_workspace_retention_once()

    assert not link.exists()          # the link itself is gone
    assert secret.exists()            # its target was never touched
    assert stats.symlinks_removed == 1
