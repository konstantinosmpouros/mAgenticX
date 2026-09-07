"""The user's skills, owned by ``chat_db``.

Custom skills previously had **no database presence at all**: `SKILL.md` and its
supporting files existed only on the agents-service volume, which has no backup,
so losing it destroyed content no ``pg_dump`` could recover. The pool membership
and per-agent assignments were in the same position — and those are *selections*,
the thing a user notices losing first.

This module is the storage half. ``utils/skills.py`` keeps the upstream calls:
the agents service still validates and writes the folder the runtime reads, and
still owns the global catalogue. What changes is who the **truth** belongs to.

Three shapes live here, and they are deliberately separate tables:

* ``user_skills`` + ``user_skill_files`` — content, for custom skills only.
* ``user_skill_pool`` — membership. An entry may point at a *global* skill,
  which has no per-user files, so the pool cannot simply be "the custom skills".
* ``user_agent_skills`` — tier ③ assignments, keyed by agent **slug** because the
  pairing is meaningful for platform agents too, whose rows are re-synced from
  the service manifest.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql import func

from core.database import (
    UserAgentSkillTable,
    UserSkillFileTable,
    UserSkillPoolTable,
    UserSkillTable,
)
from core.logging import get_logger

logger = get_logger(__name__)

POOL_TYPE_GLOBAL = "global"
POOL_TYPE_CUSTOM = "custom"


# ---------------------------------------------------------------------------
# Pool membership
# ---------------------------------------------------------------------------
async def list_pool(db: AsyncSession, user_id: str) -> List[Dict[str, Any]]:
    """The user's pool as the UI expects it: one entry per skill, custom first.

    Custom entries carry their own metadata; a global entry carries only its
    name, because the catalogue owns everything else about it and duplicating
    that here would go stale the moment the catalogue changed.
    """
    pool = (
        await db.execute(
            select(UserSkillPoolTable)
            .where(
                UserSkillPoolTable.user_id == user_id,
                UserSkillPoolTable.deleted_at.is_(None),
            )
            .order_by(UserSkillPoolTable.skill_name)
        )
    ).scalars().all()
    if not pool:
        return []

    customs = {
        row.name: row
        for row in (
            await db.execute(select(UserSkillTable).where(UserSkillTable.user_id == user_id))
        )
        .scalars()
        .all()
    }

    out: List[Dict[str, Any]] = []
    for entry in pool:
        skill = customs.get(entry.skill_name)
        out.append(
            {
                "name": entry.skill_name,
                "type": entry.type,
                "description": (skill.description if skill else "") or "",
                # `source_path` is required by the client contract and `category`
                # must be a string — a None here fails validation on the way out,
                # which is how the pool listing broke the Skills tab.
                "source_path": entry.source_path or "",
                "category": entry.category or (skill.category if skill else "") or "",
                "origin": (skill.origin if skill else "user") or "user",
                "createdByAgent": skill.created_by_agent if skill else None,
            }
        )
    return out


async def add_to_pool(
    db: AsyncSession,
    user_id: str,
    skill_name: str,
    *,
    pool_type: str,
    source_path: str = "",
    category: str = "",
) -> None:
    """Record pool membership. Idempotent — re-adding is not an error upstream."""
    existing = await db.execute(
        select(UserSkillPoolTable).where(
            UserSkillPoolTable.user_id == user_id,
            UserSkillPoolTable.skill_name == skill_name,
        )
    )
    row = existing.scalar_one_or_none()
    if row is None:
        db.add(
            UserSkillPoolTable(
                user_id=user_id,
                skill_name=skill_name,
                type=pool_type,
                source_path=source_path or "",
                category=category or "",
            )
        )
    else:
        row.type = pool_type
        # Re-adding a name the user previously removed revives the same row
        # rather than inserting a second one — the uniqueness constraint is on
        # (user_id, skill_name) and would reject the insert anyway. This mirrors
        # how a dormant agent row reactivates on a same-slug create.
        row.deleted_at = None
        # Only overwrite when the caller actually knows better — a plain
        # membership write must not blank out a path adoption already recorded.
        if source_path:
            row.source_path = source_path
        if category:
            row.category = category


async def tombstone_pool_entry(
    db: AsyncSession, user_id: str, skill_name: str
) -> bool:
    """Mark the entry removed. Returns False when we hold no such entry.

    The row and the skill's content both survive. If the removal then fails to
    reach the volume, the tombstone is what tells a reconciliation pass to
    *finish* the deletion rather than write the skill back — and the content is
    still here should the removal need undoing.

    Assignments are dropped immediately rather than at reap. They are pure
    selections, and :func:`list_agent_skills` reads them directly rather than
    through the pool, so leaving them would show a skill the user just removed
    as still enabled on an agent.
    """
    row = (
        await db.execute(
            select(UserSkillPoolTable).where(
                UserSkillPoolTable.user_id == user_id,
                UserSkillPoolTable.skill_name == skill_name,
                UserSkillPoolTable.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if row is None:
        return False
    row.deleted_at = func.now()
    await db.execute(
        delete(UserAgentSkillTable).where(
            UserAgentSkillTable.user_id == user_id,
            UserAgentSkillTable.skill_name == skill_name,
        )
    )
    return True


async def reap_pool_entry(db: AsyncSession, user_id: str, skill_name: str) -> None:
    """Hard-delete the entry, its content, and any assignment left behind.

    Two callers, both meaning "there is nothing left on the volume either": the
    second half of a user-initiated delete, and reconciliation dropping an entry
    that has no content on either side. Neither leaves a pending removal for a
    tombstone to protect.
    """
    await db.execute(
        delete(UserSkillPoolTable).where(
            UserSkillPoolTable.user_id == user_id,
            UserSkillPoolTable.skill_name == skill_name,
        )
    )
    await db.execute(
        delete(UserSkillTable).where(
            UserSkillTable.user_id == user_id, UserSkillTable.name == skill_name
        )
    )
    await db.execute(
        delete(UserAgentSkillTable).where(
            UserAgentSkillTable.user_id == user_id,
            UserAgentSkillTable.skill_name == skill_name,
        )
    )


# ---------------------------------------------------------------------------
# Custom skill content
# ---------------------------------------------------------------------------
async def store_custom_skill(
    db: AsyncSession,
    user_id: str,
    *,
    name: str,
    description: str = "",
    category: Optional[str] = None,
    origin: str = "user",
    created_by_agent: Optional[str] = None,
    files: Optional[List[Dict[str, Any]]] = None,
) -> UserSkillTable:
    """Upsert a custom skill and replace its file set.

    Replace, never merge: a save rewrites the whole skill folder upstream, so a
    file the user did not re-send is deleted there. Merging here would leave
    ``chat_db`` holding files the volume no longer has.
    """
    existing = await db.execute(
        select(UserSkillTable).where(
            UserSkillTable.user_id == user_id, UserSkillTable.name == name
        )
    )
    skill = existing.scalar_one_or_none()
    if skill is None:
        skill = UserSkillTable(user_id=user_id, name=name)
        db.add(skill)
        await db.flush()

    skill.description = description or ""
    skill.category = category
    skill.origin = origin or "user"
    skill.created_by_agent = created_by_agent

    await db.execute(
        delete(UserSkillFileTable).where(UserSkillFileTable.skill_id == skill.id)
    )
    for item in files or []:
        path = str(item.get("path") or "").strip()
        if not path:
            continue
        db.add(
            UserSkillFileTable(
                skill_id=skill.id, path=path, content=str(item.get("content") or "")
            )
        )

    await add_to_pool(
        db,
        user_id,
        name,
        pool_type=POOL_TYPE_CUSTOM,
        source_path=f"users/{user_id}/custom/{name}",
        category=category or "",
    )
    return skill


async def get_custom_skill(
    db: AsyncSession, user_id: str, skill_name: str
) -> Optional[Dict[str, Any]]:
    """One custom skill with its files, or None when we do not hold it.

    None is not an error: a pool entry of type ``global`` legitimately has no
    content here, and the caller falls back to the catalogue. A skill whose pool
    entry is tombstoned reads as None too — the content outlives the removal so
    a failed volume delete can still be reconciled, but the user has removed it
    and must not be served it.
    """
    skill = (
        await db.execute(
            select(UserSkillTable).where(
                UserSkillTable.user_id == user_id, UserSkillTable.name == skill_name
            )
        )
    ).scalar_one_or_none()
    if skill is None:
        return None

    files = (
        await db.execute(
            select(UserSkillFileTable)
            .where(UserSkillFileTable.skill_id == skill.id)
            .order_by(UserSkillFileTable.path)
        )
    ).scalars().all()

    # The pool row carries `source_path`, which the response contract requires.
    entry = (
        await db.execute(
            select(UserSkillPoolTable).where(
                UserSkillPoolTable.user_id == user_id,
                UserSkillPoolTable.skill_name == skill_name,
            )
        )
    ).scalar_one_or_none()
    if entry is not None and entry.deleted_at is not None:
        return None

    return {
        "name": skill.name,
        "type": POOL_TYPE_CUSTOM,
        "description": skill.description or "",
        # Required by the client; derived only as a fallback, because a stored
        # value is authoritative and this shape must match what upstream sends.
        "source_path": (entry.source_path if entry else "")
        or f"users/{user_id}/custom/{skill.name}",
        "category": (entry.category if entry else None) or skill.category or "",
        "origin": skill.origin or "user",
        "createdByAgent": skill.created_by_agent,
        # `content` is the SKILL.md body — the preview the card renders. Taken
        # from the stored file rather than duplicated in a column, so the two
        # cannot drift.
        "content": next(
            (f.content for f in files if f.path.upper() == "SKILL.MD"), ""
        ),
        "files": [
            {"path": f.path, "content": f.content, "encoding": "utf-8", "size": len(f.content)}
            for f in files
        ],
    }


# ---------------------------------------------------------------------------
# Tier ③ — assignments
# ---------------------------------------------------------------------------
async def list_agent_skills(db: AsyncSession, user_id: str, agent_slug: str) -> List[str]:
    rows = (
        await db.execute(
            select(UserAgentSkillTable.skill_name)
            .where(
                UserAgentSkillTable.user_id == user_id,
                UserAgentSkillTable.agent_slug == agent_slug,
            )
            .order_by(UserAgentSkillTable.skill_name)
        )
    ).scalars().all()
    return list(rows)


async def set_agent_skill(
    db: AsyncSession, user_id: str, agent_slug: str, skill_name: str, *, enabled: bool
) -> None:
    if not enabled:
        await db.execute(
            delete(UserAgentSkillTable).where(
                UserAgentSkillTable.user_id == user_id,
                UserAgentSkillTable.agent_slug == agent_slug,
                UserAgentSkillTable.skill_name == skill_name,
            )
        )
        return
    existing = await db.execute(
        select(UserAgentSkillTable.id).where(
            UserAgentSkillTable.user_id == user_id,
            UserAgentSkillTable.agent_slug == agent_slug,
            UserAgentSkillTable.skill_name == skill_name,
        )
    )
    if existing.scalar_one_or_none() is None:
        db.add(
            UserAgentSkillTable(
                user_id=user_id, agent_slug=agent_slug, skill_name=skill_name
            )
        )


# ---------------------------------------------------------------------------
# Reconciliation support
# ---------------------------------------------------------------------------
async def tombstoned_names(db: AsyncSession, user_id: str) -> set[str]:
    """Names this user has removed but whose removal may not have landed yet.

    Reconciliation reads the volume, and a removal whose second half failed
    leaves the skill still on it. Without this set, importing that inventory
    would revive exactly the entries the user deleted.
    """
    rows = (
        await db.execute(
            select(UserSkillPoolTable.skill_name).where(
                UserSkillPoolTable.user_id == user_id,
                UserSkillPoolTable.deleted_at.isnot(None),
            )
        )
    ).scalars().all()
    return set(rows)
