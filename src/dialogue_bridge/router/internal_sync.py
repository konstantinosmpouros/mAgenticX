"""Internal (service-to-service) workspace sync — the reconciliation exchange.

Not browser-facing: gated by ``require_internal_caller`` (the shared internal
proxy secret) AND blocked at the nginx edge (``/api/v1/internal/``), so only the
agents service reaching the bridge on the ``backend`` network can call them.
Same trust model as ``internal_memory``.

Two calls per user, in this order:

1. ``POST /sync/{user_id}/inventory`` — the agents service says what its volume
   holds (names and hashes, no bodies); the reply says what to write, what to
   send, and what to remove.
2. ``POST /sync/{user_id}/content`` — the bodies for whatever ``send`` named.

Metadata first is what keeps a no-op pass cheap: the common case is two small
requests and no file content in either direction.

This supersedes ``internal_workspace``, which only ever ran ``chat_db`` →
volume and so could not see content the database had never heard of. Both are
mounted while the agents service moves over; the old one goes with its last
caller.
"""
from fastapi import APIRouter, Depends, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import AgentTable, UserSkillPoolTable, get_db
from core.logging import get_logger, set_context
from core.security.internal_trust import require_internal_caller
from schema import SyncAccepted, SyncContent, SyncInventory, SyncPlan
from utils import workspace_sync

router = APIRouter()
logger = get_logger(__name__)


@router.get(
    "/sync/users",
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(require_internal_caller)],
    summary="Internal: user ids this store holds workspace content for",
)
async def listSyncUsers(db: AsyncSession = Depends(get_db)) -> list[str]:
    """Users we hold something for — **not** the full set to sync.

    The caller unions this with its own enumeration of the volume. A user whose
    content exists only on disk (the orphan a half-failed create leaves) is by
    definition absent here, and syncing only this list would keep them invisible
    forever — which is the bug the exchange exists to fix.

    Tombstoned pool rows count: a pending removal is work the pass still has to
    finish on the volume.
    """
    agent_users = (
        await db.execute(
            select(AgentTable.owner_user_id).where(AgentTable.owner_user_id.isnot(None))
        )
    ).scalars().all()
    pool_users = (
        await db.execute(select(UserSkillPoolTable.user_id))
    ).scalars().all()
    return sorted({u for u in (*agent_users, *pool_users) if u})


@router.post(
    "/sync/{user_id}/inventory",
    response_model=SyncPlan,
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(require_internal_caller)],
    summary="Internal: diff a volume inventory against chat_db",
)
async def planWorkspaceSync(
    user_id: str,
    body: SyncInventory,
    db: AsyncSession = Depends(get_db),
) -> SyncPlan:
    """Answer an inventory with the changes that reconcile the two stores.

    Writes as well as reads: volume-only *assignments* are adopted here rather
    than in a second call, because they are names with no bodies to fetch. The
    plan's ``assignments`` is the merged, authoritative set afterwards.
    """
    set_context(user_id=user_id)
    plan = await workspace_sync.build_plan(db, user_id, body)
    # `get_db` does not commit on close, so the adopted assignments would be
    # discarded without this — the same trap that silently dropped every agent
    # definition when the definition store first shipped.
    await db.commit()
    return plan


@router.post(
    "/sync/{user_id}/content",
    response_model=SyncAccepted,
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(require_internal_caller)],
    summary="Internal: adopt volume-only content into chat_db",
)
async def acceptWorkspaceContent(
    user_id: str,
    body: SyncContent,
    db: AsyncSession = Depends(get_db),
) -> SyncAccepted:
    """Take the bodies a plan asked for.

    Idempotent by name: every write is an upsert keyed on
    ``(user, slug)`` / ``(user, skill_name)``, so a retried pass costs a
    rewrite rather than a duplicate.
    """
    set_context(user_id=user_id)
    counts = await workspace_sync.apply_content(db, user_id, body)
    await db.commit()
    return SyncAccepted(**counts)
