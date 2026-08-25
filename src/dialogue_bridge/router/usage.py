"""Usage endpoints — workspace-wide token/run analytics for the Settings →
Usage tab. Read-only: aggregates live in ``utils/usage.py``; this router only
validates ownership and returns the rollup."""

from fastapi import APIRouter, Depends, status
from core.logging import get_logger, set_context
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth.session import AuthUser
from core.database import get_db
from schemas import UsageSummary
from utils import compute_usage_summary, validate_userId


router = APIRouter()
logger = get_logger(__name__)


@router.get("/{user_id}/summary", response_model=UsageSummary, status_code=status.HTTP_200_OK)
async def get_usage_summary(
    user_id: str,
    _: AuthUser = Depends(validate_userId),
    db: AsyncSession = Depends(get_db),
):
    """Return the requesting user's usage rollup (totals, windows, per-agent,
    30-day daily series). Scoped strictly to the session-bound user."""
    set_context(user_id=user_id)
    summary = await compute_usage_summary(db, user_id)
    # Log shape only — counts are not sensitive, but keep it lean.
    logger.info(
        "usage_summary_loaded",
        "Computed usage summary",
        ai_messages=summary.totals.aiMessages,
        conversations=summary.conversations,
        agents=len(summary.perAgent),
        daily_points=len(summary.daily),
    )
    return summary
