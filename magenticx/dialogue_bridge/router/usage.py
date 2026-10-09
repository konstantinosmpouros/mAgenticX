"""Usage endpoints — the Settings → Usage tab (plan 33).

Five read-only pages: the Overview, the conversation list and one conversation,
the agent list and one agent. Every route validates that the path user is the
session's user, is rate-limited per user, and returns a typed, bounded payload;
the aggregation lives in ``utils/usage.py``.
"""
from typing import Literal, Optional

from fastapi import APIRouter, Depends, Path, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth.session import AuthUser
from core.database import get_db
from core.logging import get_logger, set_context
from core.security.rate_limit import usage_analytics_rate_limit
from schema import (
    UsageAgentDetail,
    UsageAgentList,
    UsageConversationDetail,
    UsageConversationPage,
    UsageSummary,
)
from utils import (
    compute_usage_summary,
    get_usage_agent,
    get_usage_conversation,
    list_usage_agents,
    list_usage_conversations,
    validate_userId,
)


router = APIRouter()
logger = get_logger(__name__)

RangeKey = Literal["7d", "30d", "90d", "all"]


@router.get("/{user_id}/summary", response_model=UsageSummary, status_code=status.HTTP_200_OK)
async def get_usage_summary(
    user_id: str,
    _: AuthUser = Depends(validate_userId),
    # After auth on purpose: the bucket is keyed on the path's {user_id}, so it
    # must only ever count requests that user actually made.
    __: None = Depends(usage_analytics_rate_limit),
    db: AsyncSession = Depends(get_db),
):
    """The Overview: totals, windows, agent and model rankings, daily series."""
    set_context(user_id=user_id)
    summary = await compute_usage_summary(db, user_id)
    logger.info(
        "usage_summary_loaded",
        "Computed usage summary",
        ai_messages=summary.totals.aiMessages,
        conversations=summary.conversations,
        agents=len(summary.perAgent),
        models=len(summary.perModel),
        daily_points=len(summary.daily),
    )
    return summary


@router.get("/{user_id}/conversations", response_model=UsageConversationPage, status_code=status.HTTP_200_OK)
async def get_usage_conversations(
    user_id: str,
    sort: Literal["tokens", "recent", "context"] = Query("tokens"),
    range_key: RangeKey = Query("30d", alias="range"),
    agent_id: Optional[str] = Query(None, alias="agentId", max_length=128),
    q: Optional[str] = Query(None, max_length=100),
    cursor: Optional[str] = Query(None, max_length=512),
    limit: int = Query(25, ge=1, le=50),
    _: AuthUser = Depends(validate_userId),
    # After auth on purpose: the bucket is keyed on the path's {user_id}, so it
    # must only ever count requests that user actually made.
    __: None = Depends(usage_analytics_rate_limit),
    db: AsyncSession = Depends(get_db),
):
    """One page of the caller's conversations ranked by spend, recency or fill."""
    set_context(user_id=user_id)
    page = await list_usage_conversations(
        db, user_id, sort=sort, range_key=range_key, agent_id=agent_id,
        query=(q or "").strip() or None, cursor=cursor, limit=limit,
    )
    logger.info("usage_conversations_loaded", "Listed usage conversations",
                sort=sort, range=range_key, items=len(page.items), has_more=page.nextCursor is not None)
    return page


@router.get(
    "/{user_id}/conversations/{conversation_id}",
    response_model=UsageConversationDetail,
    status_code=status.HTTP_200_OK,
)
async def get_usage_conversation_detail(
    user_id: str,
    conversation_id: str = Path(..., max_length=64),
    _: AuthUser = Depends(validate_userId),
    # After auth on purpose: the bucket is keyed on the path's {user_id}, so it
    # must only ever count requests that user actually made.
    __: None = Depends(usage_analytics_rate_limit),
    db: AsyncSession = Depends(get_db),
):
    """One conversation's analysis; 404 unless it is the caller's and not private."""
    set_context(user_id=user_id, conversation_id=conversation_id)
    detail = await get_usage_conversation(db, user_id, conversation_id)
    logger.info("usage_conversation_loaded", "Loaded usage for one conversation",
                answers=detail.answers, groups=len(detail.groups), calls_complete=detail.callsComplete)
    return detail


@router.get("/{user_id}/agents", response_model=UsageAgentList, status_code=status.HTTP_200_OK)
async def get_usage_agents(
    user_id: str,
    range_key: RangeKey = Query("30d", alias="range"),
    kind: Literal["all", "platform", "custom", "deleted"] = Query("all"),
    _: AuthUser = Depends(validate_userId),
    # After auth on purpose: the bucket is keyed on the path's {user_id}, so it
    # must only ever count requests that user actually made.
    __: None = Depends(usage_analytics_rate_limit),
    db: AsyncSession = Depends(get_db),
):
    """Every agent the caller has worked with, as an entity, over the range."""
    set_context(user_id=user_id)
    agents = await list_usage_agents(db, user_id, range_key=range_key, kind=kind)
    logger.info("usage_agents_loaded", "Listed usage agents", range=range_key, kind=kind, items=len(agents.items))
    return agents


@router.get("/{user_id}/agents/{agent_key}", response_model=UsageAgentDetail, status_code=status.HTTP_200_OK)
async def get_usage_agent_detail(
    user_id: str,
    agent_key: str = Path(..., max_length=210),
    range_key: RangeKey = Query("30d", alias="range"),
    _: AuthUser = Depends(validate_userId),
    # After auth on purpose: the bucket is keyed on the path's {user_id}, so it
    # must only ever count requests that user actually made.
    __: None = Depends(usage_analytics_rate_limit),
    db: AsyncSession = Depends(get_db),
):
    """One agent's profile; ``agent_key`` is its id, or ``name:<label>`` once deleted."""
    set_context(user_id=user_id)
    detail = await get_usage_agent(db, user_id, agent_key, range_key=range_key)
    logger.info("usage_agent_loaded", "Loaded usage for one agent",
                range=range_key, kind=detail.agent.kind, groups=len(detail.groups))
    return detail
