"""Reconcile ``chat_db`` against the agents-service volume, in both directions.

Plan 21 made ``chat_db`` the owner of custom agents and custom skills, but left
five separate adoption paths — each with its own trigger, none able to see
content the database has never heard of. That last gap is not theoretical: a
create whose upstream call succeeds and whose persist fails leaves a folder on
the volume with no row, invisible in the UI and impossible to recreate (the
agents service answers a retry with 409).

This module is the single comparison that replaces all of them. The agents
service reports an inventory; here we diff it against what we hold and answer
with three lists:

* **write**  — we have it, the volume does not: materialise it.
* **send**   — the volume has it, we do not: give us the bodies (the orphan case).
* **remove** — we hold a tombstone: finish a deletion that did not land.

The asymmetry that makes the whole thing safe is the tombstone. "We have it, the
volume does not" is ambiguous on its own — it means either *the volume lost it*
or *the user just deleted it and the volume half of the delete succeeded* — and
answering the second case with a write resurrects content the user removed.
Agents carry the marker as ``is_active=False``; pool entries as ``deleted_at``.
"""
from __future__ import annotations

import hashlib
from typing import Dict, Iterable, List, Sequence, Tuple

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import (
    AgentDefinitionFileTable,
    AgentTable,
    UserAgentSkillTable,
    UserSkillFileTable,
    UserSkillPoolTable,
    UserSkillTable,
)
from core.logging import get_logger
from schema import PlanAgent, PlanSkill, SyncContent, SyncInventory, SyncPlan
from utils import skill_store, user_agents

logger = get_logger(__name__)

# The agents service generates `agent.yaml` from the spec and rejects an upload
# of one, so the bridge never stores it. Both sides must therefore leave it out
# of the hash or every comparison mismatches. The agents-side hash helper
# excludes the same name — this pairing is load-bearing.
GENERATED_MANIFEST = "agent.yaml"


def content_hash(files: Iterable[Tuple[str, str]]) -> str:
    """Stable digest of an authored file set.

    Sorted by path and newline-normalised so the two services agree byte for
    byte: an unstable hash does not fail loudly, it just makes every pass
    rewrite every file.
    """
    digest = hashlib.sha256()
    for path, content in sorted(files):
        digest.update(path.encode("utf-8"))
        digest.update(b"\0")
        digest.update((content or "").replace("\r\n", "\n").encode("utf-8"))
        digest.update(b"\0")
    return digest.hexdigest()


async def _agent_files(db: AsyncSession, agent_id: str) -> List[Dict[str, str]]:
    rows = (
        await db.execute(
            select(AgentDefinitionFileTable)
            .where(AgentDefinitionFileTable.agent_id == agent_id)
            .order_by(AgentDefinitionFileTable.path)
        )
    ).scalars().all()
    return [{"path": r.path, "content": r.content} for r in rows]


async def _skill_files(db: AsyncSession, skill_id: str) -> List[Dict[str, str]]:
    rows = (
        await db.execute(
            select(UserSkillFileTable)
            .where(UserSkillFileTable.skill_id == skill_id)
            .order_by(UserSkillFileTable.path)
        )
    ).scalars().all()
    return [{"path": r.path, "content": r.content} for r in rows]


def _hashable(files: Sequence[Dict[str, str]]) -> List[Tuple[str, str]]:
    return [
        (f["path"], f.get("content") or "")
        for f in files
        if f.get("path") and f["path"] != GENERATED_MANIFEST
    ]


async def _plan_agents(
    db: AsyncSession, user_id: str, inventory: SyncInventory, plan: SyncPlan
) -> None:
    """Diff user-authored agent definitions.

    Platform agents are deliberately absent: ``owner_user_id IS NULL`` means the
    definition ships in the agents-service image, so there is nothing here to
    materialise and writing one would shadow the shipped copy.
    """
    on_volume = {a.slug: a.hash for a in inventory.agents}

    rows = (
        await db.execute(
            select(AgentTable).where(AgentTable.owner_user_id == user_id)
        )
    ).scalars().all()

    for row in rows:
        present = row.slug in on_volume
        if not row.is_active:
            # Deleted. The row survives only because `conversations.agent_id`
            # cascades; it must never be materialised again.
            if present:
                plan.remove_agents.append(row.slug)
            continue
        if not row.definition_spec:
            # A row that pre-dates the definition store. The volume is the only
            # place its content exists, so ask for it rather than writing an
            # empty folder over it.
            if present:
                plan.send_agents.append(row.slug)
            continue
        files = await _agent_files(db, row.id)
        if not present or on_volume[row.slug] != content_hash(_hashable(files)):
            plan.write_agents.append(
                PlanAgent(slug=row.slug, spec=row.definition_spec or {}, files=files)
            )

    known = {row.slug for row in rows}
    for slug in on_volume:
        if slug not in known:
            # The orphan: a create whose persist failed. Nothing in chat_db has
            # ever heard of it, and no read path can reach it.
            plan.send_agents.append(slug)


async def _plan_skills(
    db: AsyncSession, user_id: str, inventory: SyncInventory, plan: SyncPlan
) -> None:
    on_volume = {s.name: s for s in inventory.skills}

    pool = (
        await db.execute(
            select(UserSkillPoolTable).where(UserSkillPoolTable.user_id == user_id)
        )
    ).scalars().all()
    customs = {
        row.name: row
        for row in (
            await db.execute(
                select(UserSkillTable).where(UserSkillTable.user_id == user_id)
            )
        ).scalars().all()
    }

    for entry in pool:
        name = entry.skill_name
        present = name in on_volume
        if entry.deleted_at is not None:
            if present:
                plan.remove_skills.append(name)
            continue
        if entry.type == skill_store.POOL_TYPE_GLOBAL:
            # No per-user content — the catalogue owns it. Membership is the
            # only thing to materialise, so presence is the whole comparison.
            if not present:
                plan.write_skills.append(PlanSkill(name=name, type="global"))
            continue

        skill = customs.get(name)
        files = await _skill_files(db, skill.id) if skill is not None else []
        if not files:
            if present:
                # A name we hold with no content behind it, and the volume has
                # the files: fetch them rather than writing an empty folder.
                plan.send_skills.append(name)
            else:
                # No content here, no folder there — the skill exists nowhere.
                # The entry can only ever 404, so drop it. This is the state the
                # read-triggered stale-prune used to clean up, and doing it here
                # is strictly better: that path only fired if somebody happened
                # to open the skill.
                await skill_store.reap_pool_entry(db, user_id, name)
                logger.info(
                    "workspace_sync_dangling_entry_reaped",
                    "Dropped a pool entry with no content on either side",
                    user_id=user_id,
                    skill_name=name,
                )
            continue
        if not present or on_volume[name].hash != content_hash(_hashable(files)):
            plan.write_skills.append(
                PlanSkill(
                    name=name,
                    type="custom",
                    description=(skill.description if skill else "") or "",
                    category=skill.category if skill else None,
                    origin=(skill.origin if skill else "user") or "user",
                    createdByAgent=skill.created_by_agent if skill else None,
                    files=files,
                )
            )

    known = {entry.skill_name for entry in pool}
    for name in on_volume:
        if name not in known:
            plan.send_skills.append(name)


async def _reconcile_assignments(
    db: AsyncSession, user_id: str, inventory: SyncInventory, plan: SyncPlan
) -> int:
    """Adopt volume-only assignments and return the authoritative map.

    Assignments are just names, so they need no second round trip — adopting
    them here is what keeps the exchange at two calls. Tombstoned skills are
    skipped: re-adding an assignment for a removed skill would show it as still
    enabled on the agent.
    """
    removed = await skill_store.tombstoned_names(db, user_id)
    adopted = 0
    for agent_slug, names in (inventory.assignments or {}).items():
        held = set(await skill_store.list_agent_skills(db, user_id, agent_slug))
        for name in names:
            if name in held or name in removed:
                continue
            await skill_store.set_agent_skill(
                db, user_id, agent_slug, name, enabled=True
            )
            adopted += 1

    rows = (
        await db.execute(
            select(UserAgentSkillTable).where(UserAgentSkillTable.user_id == user_id)
        )
    ).scalars().all()
    merged: Dict[str, List[str]] = {}
    for row in rows:
        merged.setdefault(row.agent_slug, []).append(row.skill_name)
    plan.assignments = {k: sorted(v) for k, v in merged.items()}
    return adopted


async def build_plan(
    db: AsyncSession, user_id: str, inventory: SyncInventory
) -> SyncPlan:
    """Compare one user's volume inventory against ``chat_db``."""
    plan = SyncPlan()
    await _plan_agents(db, user_id, inventory, plan)
    await _plan_skills(db, user_id, inventory, plan)
    adopted = await _reconcile_assignments(db, user_id, inventory, plan)

    logger.info(
        "workspace_sync_planned",
        "Built a workspace sync plan",
        user_id=user_id,
        write_count=len(plan.write_agents) + len(plan.write_skills),
        send_count=len(plan.send_agents) + len(plan.send_skills),
        remove_count=len(plan.remove_agents) + len(plan.remove_skills),
        assignments_adopted=adopted,
    )
    return plan


async def apply_content(
    db: AsyncSession, user_id: str, content: SyncContent
) -> Dict[str, int]:
    """Adopt bodies the volume sent for objects we had no content for."""
    agents = 0
    for item in content.agents:
        if await user_agents.adopt_definition(
            db, user_id, slug=item.slug, spec=item.spec, files=item.files
        ):
            agents += 1

    removed = await skill_store.tombstoned_names(db, user_id)
    skills = 0
    for item in content.skills:
        if item.name in removed:
            # Removed while the exchange was in flight. Adopting now would
            # revive it, and the next pass would then have to delete it again.
            continue
        await skill_store.store_custom_skill(
            db,
            user_id,
            name=item.name,
            description=item.description,
            category=item.category,
            origin=item.origin,
            created_by_agent=item.createdByAgent,
            files=item.files,
        )
        skills += 1

    logger.info(
        "workspace_sync_content_adopted",
        "Adopted volume-only content into chat_db",
        user_id=user_id,
        agent_count=agents,
        skill_count=skills,
    )
    return {"agents": agents, "skills": skills}


__all__ = ["build_plan", "apply_content", "content_hash", "GENERATED_MANIFEST"]
