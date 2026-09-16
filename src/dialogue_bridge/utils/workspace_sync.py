"""Reconcile ``chat_db`` against the agents-service volume, in both directions.

Plan 21 made ``chat_db`` the owner of custom agents, but left five separate
adoption paths — each with its own trigger, none able to see
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
)
from core.logging import get_logger
from schema import PlanAgent, SyncContent, SyncInventory, SyncPlan
from utils import user_agents

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


async def build_plan(
    db: AsyncSession, user_id: str, inventory: SyncInventory
) -> SyncPlan:
    """Compare one user's volume inventory against ``chat_db``."""
    plan = SyncPlan()
    await _plan_agents(db, user_id, inventory, plan)

    logger.info(
        "workspace_sync_planned",
        "Built a workspace sync plan",
        user_id=user_id,
        write_count=len(plan.write_agents),
        send_count=len(plan.send_agents),
        remove_count=len(plan.remove_agents),
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

    logger.info(
        "workspace_sync_content_adopted",
        "Adopted volume-only agent definitions into chat_db",
        user_id=user_id,
        agent_count=agents,
    )
    return {"agents": agents}


__all__ = ["GENERATED_MANIFEST", "apply_content", "build_plan", "content_hash"]
