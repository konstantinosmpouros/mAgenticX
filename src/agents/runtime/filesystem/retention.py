"""TTL retention sweeper for conversation ``input/`` and ``output/`` caches.

Both directories hold *copies* of DB-owned data — ``input/`` is bridge-seeded
from message-attachment blobs before each run, and presented ``output/`` files
are read back at run finalize and persisted as generated-attachment blobs
(see ``provisioner.seed_input_files`` / ``read_output_files``). Erasing them
after a TTL therefore never loses user data; it only trims the on-disk cache.
Everything else in the workspace (``memory/``, ``skills/``, offload dirs,
loose ``/conversation/`` files) is deliberately out of scope.

Security posture — this module deletes files, so it is written defensively:

* **Containment**: every swept conversation directory must ``realpath``-resolve
  under the filesystem root; anything else is refused and logged as a security
  event (a mount/symlink trick, not a normal state).
* **Symlinks are never followed**: entries are inspected with ``lstat``
  semantics. A symlink found inside ``input/``/``output/`` is deleted *as a
  link* and logged loudly — the agent's tools cannot create symlinks, so one
  appearing is itself a signal.
* **Bounded passes**: each sweep stops after ``_MAX_DELETES_PER_PASS`` deletes
  or ``_MAX_PASS_SECONDS`` wall-clock, whichever comes first, so a pathological
  tree degrades to "slower cleanup", never to an unbounded IO storm. The walk
  runs in a worker thread; the event loop is never blocked.
* **Activity grace**: a conversation whose ``input``/``output`` tree shows a
  recent write (any entry mtime within ``_ACTIVITY_GRACE_SECONDS``) is skipped
  for this pass, so a *running* inference never has files reaped mid-write. A
  read of an over-TTL file racing the sweeper remains possible and acceptable:
  the filesystem tool surfaces a clean file-not-found to the model.

Log lines carry counts/bytes only — never file names or contents at INFO.
"""
from __future__ import annotations

import asyncio
import os
import random
import time
from dataclasses import dataclass, field
from pathlib import Path

from core.settings import settings
from observability import get_logger

logger = get_logger(__name__)

# Directories under an agent root that are NOT conversation dirs.
_NON_CONVERSATION_DIRS = {"memory", "skills"}
# Per-pass safety budgets (hardcoded on purpose — not worth config surface).
_MAX_DELETES_PER_PASS = 10_000
_MAX_PASS_SECONDS = 30.0
# Skip conversations with filesystem activity newer than this (a run in flight).
_ACTIVITY_GRACE_SECONDS = 30 * 60


@dataclass(slots=True)
class SweepStats:
    """Counters for one sweep pass — the unit the log line reports."""

    files_deleted: int = 0
    bytes_freed: int = 0
    dirs_pruned: int = 0
    symlinks_removed: int = 0
    containment_refusals: int = 0
    conversations_skipped_active: int = 0
    budget_exhausted: bool = False
    errors: int = 0
    scopes: dict = field(default_factory=dict)


def _iter_scope_dirs(root: Path):
    """Yield every ``(scope, conversation_dir/scope)`` pair under the root.

    Layout: ``<root>/<user_id>/agents/<agent_slug>/<conversation_id>/{input,output}``.
    Walked with ``scandir`` and ``follow_symlinks=False`` at every level — a
    symlinked directory anywhere on the path is simply not descended into.
    """
    try:
        user_entries = list(os.scandir(root))
    except FileNotFoundError:
        return
    for user_entry in user_entries:
        if not user_entry.is_dir(follow_symlinks=False):
            continue
        agents_dir = Path(user_entry.path) / "agents"
        try:
            agent_entries = list(os.scandir(agents_dir))
        except FileNotFoundError:
            continue
        for agent_entry in agent_entries:
            if not agent_entry.is_dir(follow_symlinks=False):
                continue
            try:
                conv_entries = list(os.scandir(agent_entry.path))
            except FileNotFoundError:
                continue
            for conv_entry in conv_entries:
                if not conv_entry.is_dir(follow_symlinks=False):
                    continue
                if conv_entry.name in _NON_CONVERSATION_DIRS:
                    continue
                for scope in ("input", "output"):
                    scope_dir = Path(conv_entry.path) / scope
                    if scope_dir.is_dir():
                        yield scope, scope_dir


def _tree_has_recent_activity(scope_dir: Path, *, now: float) -> bool:
    """True when any FILE under ``scope_dir`` was modified within the grace
    window — the cheap proxy for "a run is actively writing here". Directory
    mtimes are deliberately ignored: they change on entry add/remove (e.g. a
    subdir just materialized, or our own prior deletions), which says nothing
    about in-flight file writes and would defer sweeps forever."""
    stack = [scope_dir]
    while stack:
        current = stack.pop()
        try:
            entries = list(os.scandir(current))
        except FileNotFoundError:
            continue
        for entry in entries:
            if entry.is_dir(follow_symlinks=False):
                stack.append(Path(entry.path))
                continue
            try:
                st = entry.stat(follow_symlinks=False)
            except FileNotFoundError:
                continue
            if (now - st.st_mtime) < _ACTIVITY_GRACE_SECONDS:
                return True
    return False


def _sweep_scope_dir(
    scope_dir: Path,
    *,
    ttl_seconds: float,
    now: float,
    deadline: float,
    stats: SweepStats,
) -> None:
    """Delete over-TTL files under one ``input/`` or ``output/`` dir, then prune
    empty subdirectories (the scope dir itself always survives)."""
    stack = [scope_dir]
    subdirs: list[Path] = []
    while stack:
        if stats.files_deleted >= _MAX_DELETES_PER_PASS or time.monotonic() > deadline:
            stats.budget_exhausted = True
            return
        current = stack.pop()
        try:
            entries = list(os.scandir(current))
        except FileNotFoundError:
            continue
        for entry in entries:
            entry_path = Path(entry.path)
            try:
                if entry.is_symlink():
                    # Filesystem tools can't create these; treat as hostile.
                    entry_path.unlink(missing_ok=True)
                    stats.symlinks_removed += 1
                    logger.warning(
                        "workspace_retention_symlink_removed",
                        "Removed unexpected symlink from a conversation cache dir",
                        scope_dir=str(scope_dir),
                    )
                    continue
                if entry.is_dir(follow_symlinks=False):
                    stack.append(entry_path)
                    subdirs.append(entry_path)
                    continue
                st = entry.stat(follow_symlinks=False)
                if (now - st.st_mtime) > ttl_seconds:
                    entry_path.unlink(missing_ok=True)
                    stats.files_deleted += 1
                    stats.bytes_freed += st.st_size
            except OSError:
                stats.errors += 1
    # Deepest-first so nested empty chains collapse in one pass.
    for subdir in sorted(subdirs, key=lambda p: len(p.parts), reverse=True):
        try:
            subdir.rmdir()  # only succeeds when empty — exactly what we want
            stats.dirs_pruned += 1
        except OSError:
            continue


def sweep_workspace_retention_once() -> SweepStats:
    """One synchronous sweep pass over every conversation's cache dirs.

    Pure filesystem code (no awaits) so tests can call it directly and the
    async loop can push it onto a worker thread.
    """
    cfg = settings.filesystem
    ttls = {
        "input": cfg.input_ttl_hours * 3600,
        "output": cfg.output_ttl_hours * 3600,
    }
    stats = SweepStats(scopes={k: bool(v) for k, v in ttls.items()})
    root = cfg.user_root
    try:
        real_root = root.resolve(strict=True)
    except (FileNotFoundError, OSError):
        return stats  # nothing provisioned yet — clean no-op
    now = time.time()
    deadline = time.monotonic() + _MAX_PASS_SECONDS

    for scope, scope_dir in _iter_scope_dirs(real_root):
        ttl = ttls[scope]
        if ttl <= 0:
            continue
        if stats.budget_exhausted:
            break
        # Containment: the scope dir must resolve under the filesystem root.
        try:
            resolved = scope_dir.resolve(strict=True)
        except (FileNotFoundError, OSError):
            continue
        if not resolved.is_relative_to(real_root):
            stats.containment_refusals += 1
            logger.error(
                "workspace_retention_containment_refused",
                "Conversation cache dir escapes the filesystem root — refusing to sweep it",
                failure_reason="retention_containment",
            )
            continue
        if _tree_has_recent_activity(resolved, now=now):
            stats.conversations_skipped_active += 1
            continue
        _sweep_scope_dir(resolved, ttl_seconds=ttl, now=now, deadline=deadline, stats=stats)

    return stats


async def run_workspace_retention_loop() -> None:
    """The lifespan-owned background loop: sweep, log, sleep (jittered), repeat.

    Cancellation-safe: ``asyncio.CancelledError`` propagates out of ``sleep``
    so shutdown is immediate. Any other exception is logged and the loop keeps
    going — retention must never take the service down.
    """
    cfg = settings.filesystem
    if cfg.input_ttl_hours == 0 and cfg.output_ttl_hours == 0:
        logger.warning(
            "workspace_retention_disabled",
            "Workspace retention is fully disabled (both TTLs are 0) — "
            "conversation input/output caches will grow unbounded",
        )
        return
    for scope, hours in (("input", cfg.input_ttl_hours), ("output", cfg.output_ttl_hours)):
        if hours == 0:
            logger.warning(
                "workspace_retention_scope_disabled",
                f"Workspace retention for {scope}/ is disabled (TTL 0)",
            )
    logger.info(
        "workspace_retention_started",
        "Workspace retention sweeper started",
        input_ttl_hours=cfg.input_ttl_hours,
        output_ttl_hours=cfg.output_ttl_hours,
        interval_minutes=cfg.retention_sweep_interval_minutes,
    )
    while True:
        try:
            stats = await asyncio.to_thread(sweep_workspace_retention_once)
            if stats.files_deleted or stats.symlinks_removed or stats.containment_refusals:
                logger.info(
                    "workspace_retention_sweep",
                    "Workspace retention sweep completed",
                    files_deleted=stats.files_deleted,
                    bytes_freed=stats.bytes_freed,
                    dirs_pruned=stats.dirs_pruned,
                    symlinks_removed=stats.symlinks_removed,
                    containment_refusals=stats.containment_refusals,
                    skipped_active=stats.conversations_skipped_active,
                    budget_exhausted=stats.budget_exhausted,
                    errors=stats.errors,
                )
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.error(
                "workspace_retention_sweep_failed",
                "Workspace retention sweep pass failed; will retry next interval",
                exc_info=True,
            )
        interval = cfg.retention_sweep_interval_minutes * 60
        await asyncio.sleep(interval * random.uniform(0.9, 1.1))
