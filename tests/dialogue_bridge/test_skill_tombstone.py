"""Removing a skill leaves a tombstone until the removal reaches the volume.

Deleting a skill deletes it upstream first, then in ``chat_db``. If that second
half fails, the volume no longer has the skill while ``chat_db`` still lists it —
and that state is indistinguishable from *the volume lost this skill and needs it
written back*. Acting on the wrong reading resurrects skills the user deleted.

``user_skill_pool.deleted_at`` is what disambiguates it. These pin the properties
that depend on it, none of which is visible from the HTTP surface alone.
"""
from __future__ import annotations

import httpx
import pytest
import pytest_asyncio

import utils.skills as skills_mod
from core.database import UserAgentSkillTable, UserSkillPoolTable
from schema import SyncInventory
from utils.workspace_sync import build_plan
from sqlalchemy import select
from utils import skill_store
from utils.skills import remove_skill_from_user_pool


# ---------------------------------------------------------------------------
# Minimal upstream stand-ins — the delete is the only call these tests make.
# ---------------------------------------------------------------------------
class _Resp:
    def __init__(self, status_code: int = 204):
        self.status_code = status_code

    def raise_for_status(self):
        if self.status_code >= 400:
            request = httpx.Request("DELETE", "http://agents.test/x")
            raise httpx.HTTPStatusError(
                "boom", request=request, response=httpx.Response(self.status_code, request=request)
            )


class _Client:
    def __init__(self, handler, **_kwargs):
        self._handler = handler

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False

    async def delete(self, url, **kwargs):
        return self._handler(url, kwargs)


@pytest.fixture
def upstream_ok(monkeypatch):
    monkeypatch.setattr(
        skills_mod.httpx, "AsyncClient", lambda **kw: _Client(lambda *_a: _Resp(204), **kw)
    )


@pytest.fixture
def upstream_down(monkeypatch):
    def _boom(*_args, **_kwargs):
        raise httpx.ConnectError("agents service unreachable")

    monkeypatch.setattr(
        skills_mod.httpx, "AsyncClient", lambda **kw: _Client(_boom, **kw)
    )


@pytest_asyncio.fixture
async def db(session_factory):
    async with session_factory() as session:
        yield session


async def _seed(db, user_id: str = "u", name: str = "note-taker") -> None:
    await skill_store.store_custom_skill(
        db, user_id, name=name, description="d", files=[{"path": "SKILL.md", "content": "body"}]
    )
    await skill_store.set_agent_skill(db, user_id, "omni", name, enabled=True)
    await db.commit()


async def _pool_rows(db, user_id: str = "u") -> list[UserSkillPoolTable]:
    return list(
        (
            await db.execute(
                select(UserSkillPoolTable).where(UserSkillPoolTable.user_id == user_id)
            )
        )
        .scalars()
        .all()
    )


# ---------------------------------------------------------------------------
# The delete path
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_a_successful_delete_reaps_the_row_entirely(db, upstream_ok):
    await _seed(db)
    await remove_skill_from_user_pool(db=db, user_id="u", skill_name="note-taker")

    # The volume no longer has it either, so nothing is left to protect.
    assert await _pool_rows(db) == []
    assert await skill_store.list_pool(db, "u") == []


@pytest.mark.asyncio
async def test_a_failed_upstream_delete_leaves_a_tombstone_not_a_live_row(db, upstream_down):
    # The case the column exists for: the user's removal must not read as
    # "chat_db has a skill the volume is missing", or it gets written back.
    await _seed(db)
    with pytest.raises(Exception):
        await remove_skill_from_user_pool(db=db, user_id="u", skill_name="note-taker")

    rows = await _pool_rows(db)
    assert len(rows) == 1
    assert rows[0].deleted_at is not None
    # And the user sees it gone immediately, whether or not upstream recovers.
    assert await skill_store.list_pool(db, "u") == []


@pytest.mark.asyncio
async def test_the_removal_drops_assignments_immediately(db, upstream_down):
    # Assignments are read directly rather than through the pool, so leaving
    # them would show a removed skill as still enabled on an agent.
    await _seed(db)
    assert await skill_store.list_agent_skills(db, "u", "omni") == ["note-taker"]

    with pytest.raises(Exception):
        await remove_skill_from_user_pool(db=db, user_id="u", skill_name="note-taker")

    assert await skill_store.list_agent_skills(db, "u", "omni") == []


# ---------------------------------------------------------------------------
# The resurrection paths a tombstone has to close
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_sync_never_writes_a_tombstoned_entry_back(db, upstream_down):
    # The agents service materialises whatever the plan's `write` list names,
    # so a tombstoned entry appearing there is the resurrection itself.
    await _seed(db)
    with pytest.raises(Exception):
        await remove_skill_from_user_pool(db=db, user_id="u", skill_name="note-taker")

    plan = await build_plan(db, "u", SyncInventory())
    assert plan.write_skills == []


@pytest.mark.asyncio
async def test_a_tombstoned_skill_is_not_served_as_content(db, upstream_down):
    # The content outlives the tombstone so a failed delete stays reconcilable,
    # but the user removed it and must not be handed it back.
    await _seed(db)
    with pytest.raises(Exception):
        await remove_skill_from_user_pool(db=db, user_id="u", skill_name="note-taker")

    assert await skill_store.get_custom_skill(db, "u", "note-taker") is None


# ---------------------------------------------------------------------------
# Re-adding
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_re_adding_a_removed_skill_revives_the_same_row(db, upstream_down):
    # (user_id, skill_name) is unique, so a second insert would fail outright.
    await _seed(db)
    with pytest.raises(Exception):
        await remove_skill_from_user_pool(db=db, user_id="u", skill_name="note-taker")

    await skill_store.add_to_pool(db, "u", "note-taker", pool_type="custom")
    await db.commit()

    rows = await _pool_rows(db)
    assert len(rows) == 1
    assert rows[0].deleted_at is None
    assert [p["name"] for p in await skill_store.list_pool(db, "u")] == ["note-taker"]


@pytest.mark.asyncio
async def test_removing_a_skill_we_do_not_hold_still_proxies(db, monkeypatch):
    # A pool that pre-dates this store has no rows to tombstone — exactly the
    # orphan case. The agents service still owns the folder and has to be told
    # to delete it, so bailing out early here would strand the volume copy.
    calls: list[str] = []

    def _record(url, _kwargs):
        calls.append(url)
        return _Resp(204)

    monkeypatch.setattr(
        skills_mod.httpx, "AsyncClient", lambda **kw: _Client(_record, **kw)
    )
    await remove_skill_from_user_pool(db=db, user_id="u", skill_name="never-adopted")

    assert len(calls) == 1
    assert await _pool_rows(db) == []
