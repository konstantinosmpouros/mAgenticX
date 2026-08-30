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
            .where(UserSkillPoolTable.user_id == user_id)
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


async def pool_needs_adoption(db: AsyncSession, user_id: str) -> bool:
    """True when we hold no pool for this user yet.

    Only membership is checked. File bodies are adopted lazily when a skill is
    opened (they are the large part of the payload and most are never read), so
    a skill without stored files is a normal state here, not an incomplete
    import — treating it as incomplete would re-run the whole pass on every
    listing.
    """
    found = await db.execute(
        select(UserSkillPoolTable.id).where(UserSkillPoolTable.user_id == user_id).limit(1)
    )
    return found.scalar_one_or_none() is None


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
        # Only overwrite when the caller actually knows better — a plain
        # membership write must not blank out a path adoption already recorded.
        if source_path:
            row.source_path = source_path
        if category:
            row.category = category


async def remove_from_pool(db: AsyncSession, user_id: str, skill_name: str) -> None:
    """Drop the entry, its content, and every assignment that referenced it.

    Assignments go too: leaving them would let a skill the user removed keep
    showing as enabled on an agent, and the next hydrate would try to
    materialise a skill that no longer exists in the pool.
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
    content here, and the caller falls back to the catalogue.
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


async def agent_has_no_assignments(
    db: AsyncSession, user_id: str, agent_slug: str
) -> bool:
    """True when we hold nothing for this (user, agent) — the adoption signal."""
    found = await db.execute(
        select(UserAgentSkillTable.id)
        .where(
            UserAgentSkillTable.user_id == user_id,
            UserAgentSkillTable.agent_slug == agent_slug,
        )
        .limit(1)
    )
    return found.scalar_one_or_none() is None


# ---------------------------------------------------------------------------
# Adoption — one-way import of what already exists on the volume
# ---------------------------------------------------------------------------
async def adopt_pool(
    db: AsyncSession, user_id: str, manifest: List[Dict[str, Any]]
) -> int:
    """Take an upstream pool manifest as ours. Returns how many entries landed.

    Lazy migration: users have pools that pre-date this store, and a boot pass
    would have to be remembered and re-run. Adopting on first read is
    self-healing and disappears once every user has been seen.
    """
    count = 0
    for item in manifest or []:
        name = str(item.get("name") or "").strip()
        if not name:
            continue
        pool_type = POOL_TYPE_GLOBAL if item.get("type") == POOL_TYPE_GLOBAL else POOL_TYPE_CUSTOM
        if pool_type == POOL_TYPE_CUSTOM:
            await store_custom_skill(
                db,
                user_id,
                name=name,
                description=str(item.get("description") or ""),
                category=item.get("category"),
                origin=str(item.get("origin") or "user"),
                created_by_agent=item.get("createdByAgent") or item.get("created_by_agent"),
                files=item.get("files") or None,
            )
        else:
            await add_to_pool(
                db,
                user_id,
                name,
                pool_type=POOL_TYPE_GLOBAL,
                source_path=str(item.get("source_path") or ""),
                category=str(item.get("category") or ""),
            )
        count += 1

    if count:
        logger.info(
            "user_skill_pool_adopted",
            "Adopted a volume-only skill pool into chat_db",
            user_id=user_id,
            count=count,
        )
    return count


async def adopt_agent_skills(
    db: AsyncSession, user_id: str, agent_slug: str, names: List[str]
) -> int:
    for name in names or []:
        await set_agent_skill(db, user_id, agent_slug, name, enabled=True)
    if names:
        logger.info(
            "user_agent_skills_adopted",
            "Adopted volume-only skill assignments into chat_db",
            user_id=user_id,
            agent_slug=agent_slug,
            count=len(names),
        )
    return len(names or [])
