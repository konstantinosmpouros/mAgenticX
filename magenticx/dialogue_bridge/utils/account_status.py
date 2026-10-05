"""Whether a user's account is scheduled for deletion (plan 32) — reads only.

Asked from many places that have nothing else to do with deletion — signing in,
refreshing and switching accounts (``router.auth``), the scheduler, public share
links — so the question lives here, with no dependencies beyond the model,
rather than in ``utils.account_deletion`` with the purge and its HTTP client.
"""
from __future__ import annotations

from typing import Optional

from sqlalchemy import exists, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql import ColumnElement

from core.database import AccountDeletionTable


def _open_for(user_id) -> ColumnElement[bool]:
    """Rows of an open request: neither cancelled nor finished (the partial index)."""
    return (
        (AccountDeletionTable.user_id == user_id)
        & AccountDeletionTable.cancelled_at.is_(None)
        & AccountDeletionTable.completed_at.is_(None)
    )


def open_deletion_exists_for(user_id_column) -> ColumnElement[bool]:
    """``EXISTS`` clause for queries that must skip users awaiting deletion
    (the scheduler, public share links) — correlated on the given column."""
    return exists().where(_open_for(user_id_column))


async def open_deletion(db: AsyncSession, user_id: str) -> Optional[AccountDeletionTable]:
    """The user's open deletion request, or ``None``."""
    return (await db.execute(select(AccountDeletionTable).where(_open_for(user_id)))).scalar_one_or_none()


def pending_deletion_summary(row: Optional[AccountDeletionTable]) -> Optional[dict]:
    """What the UI is told about a pending deletion: dates only, nothing else."""
    if row is None:
        return None
    return {
        "requestedAt": row.requested_at,
        "scheduledFor": row.scheduled_for,
        "inProgress": row.started_at is not None,
    }
