"""Usage-summary DTOs (Settings, Usage tab)."""
from typing import List
from pydantic import BaseModel, Field


class UsageWindow(BaseModel):
    """Token/message aggregates over one time window (or all time)."""
    inputTokens: int = 0
    outputTokens: int = 0
    totalTokens: int = 0
    aiMessages: int = 0


class UsageAgentBreakdown(UsageWindow):
    """One agent's share of the user's usage (keyed by denormalized name)."""
    agentName: str


class UsageDailyPoint(UsageWindow):
    """One UTC day of usage for the activity chart. `date` is YYYY-MM-DD."""
    date: str


class UsageSummary(BaseModel):
    """Workspace-wide usage rollup for one user: all-time totals, recency
    windows, a capped per-agent ranking, and a sparse 30-day daily series
    (days with no activity are omitted; the client fills the gaps)."""
    totals: UsageWindow
    conversations: int = 0
    today: UsageWindow
    last7Days: UsageWindow
    last30Days: UsageWindow
    perAgent: List[UsageAgentBreakdown] = Field(default_factory=list)
    daily: List[UsageDailyPoint] = Field(default_factory=list)
