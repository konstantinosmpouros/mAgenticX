"""The one-off move of the old volume trees into Postgres (plan 43, temporary).

TODO(plan 43): remove with ``harness/conversation_files/legacy_volume.py``
once agents v1.21.20 has deployed.

What must hold, because the move ends in deleting user data from the volume:

* the import maps every file to its virtual path, leaves ``input/`` (the
  uploads are in chat_db) and is idempotent — a second run writes nothing;
* it never overwrites a newer row, takes a newer disk copy, and parks another
  agent's different file under ``_migrated/<slug>/`` instead of losing it;
* a tree is deleted only after a verification pass found every file in
  Postgres; a tree with anything unimportable is kept, an orphan (a
  conversation the bridge no longer has) is left alone, a bridge outage
  deletes nothing and asks for a retry — and nothing outside ``users/`` is
  ever touched.

Runs over the in-memory store; ``_stamp``'s one UPDATE is the only SQL here.
"""
from __future__ import annotations

import dataclasses
import os
import time
from types import SimpleNamespace

import httpx
import pytest

pytestmark = pytest.mark.asyncio


@pytest.fixture
def legacy(agents_service, skills_fs, memory_file_store, monkeypatch):
    module = agents_service.legacy_volume
    state = SimpleNamespace(module=module, store=memory_file_store, users=skills_fs.users_root,
                            known=set(), bridge_down=False)

    async def stamp(user_id, conversation_id, path, moment):
        user, entry = memory_file_store.rows[(conversation_id, path)]
        memory_file_store.rows[(conversation_id, path)] = (user, dataclasses.replace(entry, updated_at=moment))

    async def existing(user_id, conversation_ids):
        if state.bridge_down:
            raise httpx.ConnectError("bridge down")
        return {cid for cid in conversation_ids if (user_id, cid) in state.known}

    monkeypatch.setattr(module, "ConversationFileStore", lambda _pool: memory_file_store)
    monkeypatch.setattr(module, "get_memory_pool", lambda: object())
    monkeypatch.setattr(module, "_stamp", stamp)
    monkeypatch.setattr(module, "_existing_conversations", existing)
    return state


def _tree(legacy, user="u1", slug="omni", conversation="c1", files=None):
    root = legacy.users / user / "agents" / slug / "conversations" / conversation
    for relative, data in (files or {}).items():
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    root.mkdir(parents=True, exist_ok=True)
    return root


def _rows(legacy, conversation="c1"):
    return {path: legacy.store.blobs[(user, entry.sha256)]
            for (conv, path), (user, entry) in legacy.store.rows.items() if conv == conversation}


async def test_files_land_on_their_virtual_paths_and_uploads_stay_behind(legacy):
    root = _tree(legacy, files={
        "input/photo.png": b"an upload",
        "output/report.md": b"# Q3",
        "output/charts/q3.png": b"png",
        "large_tool_results/call-1": b"big result",
        "conversation_history/thread-1.md": b"history",
        "notes.md": b"loose",
    })

    await legacy.module.import_conversation("u1", "c1")

    assert _rows(legacy) == {
        "/conversation/output/report.md": b"# Q3",
        "/conversation/output/charts/q3.png": b"png",
        "/large_tool_results/call-1": b"big result",
        "/conversation_history/thread-1.md": b"history",
        "/conversation/notes.md": b"loose",
    }
    assert root.exists()  # a run's import never deletes


async def test_a_second_import_writes_nothing(legacy, monkeypatch):
    _tree(legacy, files={"output/report.md": b"# Q3"})
    await legacy.module.import_conversation("u1", "c1")
    writes = []

    async def record(*args, **kwargs):
        writes.append(args)

    monkeypatch.setattr(legacy.store, "create", record)
    monkeypatch.setattr(legacy.store, "replace", record)

    await legacy.module.import_conversation("u1", "c1")

    assert writes == []


async def test_an_edit_made_after_the_import_is_never_overwritten(legacy):
    _tree(legacy, files={"output/report.md": b"from the volume"})
    await legacy.module.import_conversation("u1", "c1")
    await legacy.store.replace("u1", "c1", "/conversation/output/report.md", b"edited since", agent_slug="omni")

    await legacy.module.import_conversation("u1", "c1")

    assert _rows(legacy)["/conversation/output/report.md"] == b"edited since"


async def test_a_newer_disk_copy_is_taken(legacy):
    """The previous agents task can still write to the volume during a deploy."""
    root = _tree(legacy, files={"output/report.md": b"v1"})
    await legacy.module.import_conversation("u1", "c1")
    (root / "output" / "report.md").write_bytes(b"v2, written by the old task")
    later = time.time() + 60
    os.utime(root / "output" / "report.md", (later, later))

    await legacy.module.import_conversation("u1", "c1")

    assert _rows(legacy)["/conversation/output/report.md"] == b"v2, written by the old task"


async def test_another_agents_different_file_is_kept_aside(legacy):
    _tree(legacy, slug="omni", files={"output/plan.md": b"omni's plan"})
    _tree(legacy, slug="nova", files={"output/plan.md": b"nova's plan"})

    await legacy.module.import_conversation("u1", "c1")

    # Trees are taken in slug order: the first keeps the path, the second is parked.
    assert _rows(legacy) == {
        "/conversation/output/plan.md": b"nova's plan",
        "/conversation/_migrated/omni/output/plan.md": b"omni's plan",
    }


async def test_the_pass_deletes_only_verified_trees_of_live_conversations(legacy, skills_fs):
    legacy.known = {("u1", "c1"), ("u1", "c2")}
    moved = _tree(legacy, conversation="c1", files={"output/a.md": b"a", "input/up.png": b"u"})
    kept = _tree(legacy, conversation="c2", files={"output/b.md": b"b", "output/.hidden": b"cannot be imported"})
    orphan = _tree(legacy, conversation="gone", files={"output/c.md": b"c"})
    other_user = _tree(legacy, user="u2", conversation="c1", files={"output/d.md": b"d"})
    global_file = skills_fs.global_root / "research" / "deep-research" / "SKILL.md"

    assert await legacy.module._migrate_once(legacy.store) is True

    assert not moved.exists()                     # imported, verified, deleted
    assert kept.exists() and _rows(legacy, "c2")  # imported what it could, kept the rest
    assert orphan.exists() and not _rows(legacy, "gone")
    assert other_user.exists()                    # u2's c1 is not u1's c1
    assert global_file.exists()                   # the global plane is another root
    assert _rows(legacy, "c1") == {"/conversation/output/a.md": b"a"}


async def test_a_second_pass_finds_nothing_to_do(legacy):
    legacy.known = {("u1", "c1")}
    _tree(legacy, files={"output/a.md": b"a"})
    await legacy.module._migrate_once(legacy.store)
    before = dict(legacy.store.rows)

    assert await legacy.module._migrate_once(legacy.store) is True
    assert legacy.store.rows == before
    assert not (legacy.users / "u1").exists()  # the emptied folders are pruned


async def test_a_bridge_outage_deletes_nothing_and_asks_for_a_retry(legacy):
    legacy.known = {("u1", "c1")}
    legacy.bridge_down = True
    root = _tree(legacy, files={"output/a.md": b"a"})

    assert await legacy.module._migrate_once(legacy.store) is False
    assert root.exists()


async def test_nothing_is_deleted_when_verification_fails(legacy, monkeypatch):
    legacy.known = {("u1", "c1")}
    root = _tree(legacy, files={"output/a.md": b"a"})
    real_create = legacy.store.create

    async def lost_write(*args, **kwargs):
        await real_create(*args, **kwargs)
        legacy.store.rows.clear()  # the row vanished between import and verification

    monkeypatch.setattr(legacy.store, "create", lost_write)

    await legacy.module._migrate_once(legacy.store)

    assert root.exists()


async def test_a_deleted_conversation_or_account_takes_its_old_trees(legacy):
    conversation = _tree(legacy, conversation="c1", files={"output/a.md": b"a"})
    sibling = _tree(legacy, conversation="c2", files={"output/b.md": b"b"})

    await legacy.module.delete_conversation_trees("u1", "c1")
    assert not conversation.exists() and sibling.exists()

    assert await legacy.module.delete_user_tree("u1") is True
    assert not (legacy.users / "u1").exists()
    assert await legacy.module.delete_user_tree("u1") is False
