"""Usage DTOs for the Settings → Usage tab (plan 33).

Five read-only shapes, one per page of the tab: the Overview (``UsageSummary``),
the conversation list and one conversation, the agent list and one agent. Every
count is a plain integer and every list is capped server-side, so a response is
bounded no matter how much the user has used the platform.

Coverage is explicit rather than implied. Answers from before plan 33 recorded
tokens but no call counts, model time or sub-agent split; the ``detailed*``
fields count only the answers that did, so a ratio (cache hit, time per answer,
calls per answer) divides by the answers that actually report the quantity,
never by all of them.
"""
from datetime import datetime
from typing import List, Literal, Optional

from pydantic import BaseModel, Field


AgentKind = Literal["platform", "custom", "deleted"]


class UsageWindow(BaseModel):
    """Token/message aggregates over one time window (or all time)."""
    inputTokens: int = 0
    outputTokens: int = 0
    totalTokens: int = 0
    aiMessages: int = 0
    cachedInputTokens: int = 0
    reasoningTokens: int = 0
    modelMs: int = 0
    modelCalls: int = 0
    toolCalls: int = 0
    # Answers that recorded call counts and model time (plan 33 onward), and
    # their input tokens — the denominators for every per-answer ratio.
    detailedAnswers: int = 0
    detailedInputTokens: int = 0
    # Plan 41. Cost in micro-USD of the priced calls — a lower bound while
    # unpricedCalls > 0 (calls on a model with no price); calls cut off at the
    # output limit; the answers' time to first text, summed over the answers
    # that measured one (firstTokenAnswers, the average's denominator).
    costMicros: int = 0
    unpricedCalls: int = 0
    truncatedCalls: int = 0
    firstTokenMs: int = 0
    firstTokenAnswers: int = 0


class UsageAgentBreakdown(UsageWindow):
    """One agent's share of the user's usage (keyed by denormalized name)."""
    agentName: str


class UsageDailyPoint(UsageWindow):
    """One UTC day of usage for the activity chart. `date` is YYYY-MM-DD."""
    date: str


class CallMetrics(BaseModel):
    """Plan 41's per-call figures for a set of model calls, summed.

    ``ttftMs`` is the time to first token over the ``ttftCalls`` calls that
    streamed; ``genMs`` / ``genOutputTokens`` their time after it and the output
    tokens it produced (tokens/s = genOutputTokens / genMs * 1000).
    """
    costMicros: int = 0
    unpricedCalls: int = 0
    truncatedCalls: int = 0
    ttftMs: int = 0
    ttftCalls: int = 0
    genMs: int = 0
    genOutputTokens: int = 0


class UsageModelBreakdown(CallMetrics):
    """One model's share of the calls made since usage was split by model."""
    model: str
    calls: int = 0
    inputTokens: int = 0
    cachedInputTokens: int = 0
    outputTokens: int = 0
    modelMs: int = 0


class UsageToolBreakdown(BaseModel):
    """One tool's calls (plan 41): how often it ran and failed, its total wall
    time and the total length of its results — averages are the client's."""
    toolName: str
    calls: int = 0
    errors: int = 0
    durationMs: int = 0
    outputChars: int = 0


class UsageSummary(BaseModel):
    """Workspace-wide usage rollup for one user: all-time totals, recency
    windows (with the week before for comparison), capped agent and model
    rankings, a sparse 30-day daily series (empty days omitted; the client fills
    the gaps) and the counts behind the two drill-in cards."""
    totals: UsageWindow
    conversations: int = 0
    today: UsageWindow
    last7Days: UsageWindow
    previous7Days: UsageWindow = Field(default_factory=UsageWindow)
    last30Days: UsageWindow
    perAgent: List[UsageAgentBreakdown] = Field(default_factory=list)
    perModel: List[UsageModelBreakdown] = Field(default_factory=list)
    # The most-called tools, all time (plan 41).
    perTool: list[UsageToolBreakdown] = Field(default_factory=list)
    daily: List[UsageDailyPoint] = Field(default_factory=list)
    agentCount: int = 0
    nearCompactionCount: int = 0


# ---------------------------------------------------------------------------
# Conversations
# ---------------------------------------------------------------------------
class UsageConversationRow(BaseModel):
    """One conversation's running totals, as the list shows them."""
    id: str
    title: Optional[str] = None
    agentId: Optional[str] = None
    agentName: Optional[str] = None
    agentIcon: Optional[str] = None
    isArchived: bool = False
    answers: int = 0
    inputTokens: int = 0
    cachedInputTokens: int = 0
    outputTokens: int = 0
    totalTokens: int = 0
    modelCalls: int = 0
    toolCalls: int = 0
    modelMs: int = 0
    costMicros: int = 0
    truncatedCalls: int = 0
    contextTokens: Optional[int] = None
    contextWindow: Optional[int] = None
    updatedAt: Optional[datetime] = None


class UsagePrivateAggregate(BaseModel):
    """Private chats, summed — never listed or titled."""
    conversations: int = 0
    answers: int = 0
    totalTokens: int = 0


class UsageConversationPage(BaseModel):
    """A keyset page of the conversation list; `nextCursor` is opaque."""
    items: List[UsageConversationRow] = Field(default_factory=list)
    nextCursor: Optional[str] = None
    private: Optional[UsagePrivateAggregate] = None


class UsageAgentGroup(CallMetrics):
    """Where tokens went inside an answer set: one agent scope × agent × model.

    ``compaction`` is the summary calls that compacted the conversation (plan
    34) — spend of the conversation's main agent, but not its answers.
    """
    scope: Literal["main", "subagent", "compaction"]
    agentId: Optional[str] = None
    agentName: str
    model: Optional[str] = None
    calls: int = 0
    inputTokens: int = 0
    cachedInputTokens: int = 0
    outputTokens: int = 0
    reasoningTokens: int = 0
    modelMs: int = 0


class UsageAnswerPoint(BaseModel):
    """One answer on the conversation's latest branch, oldest first."""
    id: str
    createdAt: datetime
    agentName: Optional[str] = None
    model: Optional[str] = None
    inputTokens: int = 0
    outputTokens: int = 0
    cachedInputTokens: int = 0
    modelCalls: Optional[int] = None
    toolCalls: Optional[int] = None
    modelMs: Optional[int] = None
    contextTokens: Optional[int] = None
    contextWindow: Optional[int] = None
    compactionPercent: Optional[float] = None
    # Plan 41; null on answers from before it was measured.
    costMicros: int | None = None
    unpricedCalls: int | None = None
    truncatedCalls: int | None = None
    firstTokenMs: int | None = None


class UsageConversationDetail(BaseModel):
    """One conversation's analysis: totals over every answer (replaced ones
    included), the main-agent / sub-agent split, and its latest branch."""
    id: str
    title: Optional[str] = None
    isArchived: bool = False
    answers: int = 0
    replaced: int = 0
    inputTokens: int = 0
    cachedInputTokens: int = 0
    outputTokens: int = 0
    totalTokens: int = 0
    modelCalls: int = 0
    toolCalls: int = 0
    modelMs: int = 0
    detailedAnswers: int = 0
    detailedInputTokens: int = 0
    costMicros: int = 0
    unpricedCalls: int = 0
    truncatedCalls: int = 0
    # False when older answers were too many to count calls for on the fly.
    callsComplete: bool = True
    groups: List[UsageAgentGroup] = Field(default_factory=list)
    tools: list[UsageToolBreakdown] = Field(default_factory=list)
    branch: List[UsageAnswerPoint] = Field(default_factory=list)
    branchTruncated: bool = False


# ---------------------------------------------------------------------------
# Agents
# ---------------------------------------------------------------------------
class UsageAgentEntity(BaseModel):
    """An agent as an entity: who it is, plus what it spent in the range."""
    key: str
    agentId: Optional[str] = None
    name: str
    icon: Optional[str] = None
    kind: AgentKind
    engine: Optional[str] = None
    version: Optional[str] = None
    isActive: bool = True
    createdAt: Optional[datetime] = None
    answers: int = 0
    conversations: int = 0
    inputTokens: int = 0
    cachedInputTokens: int = 0
    outputTokens: int = 0
    totalTokens: int = 0
    modelMs: int = 0
    modelCalls: int = 0
    toolCalls: int = 0
    detailedAnswers: int = 0
    detailedInputTokens: int = 0
    costMicros: int = 0
    truncatedCalls: int = 0
    lastUsedAt: Optional[datetime] = None
    subagents: List[str] = Field(default_factory=list)
    models: List[str] = Field(default_factory=list)


class UsageAgentList(BaseModel):
    items: List[UsageAgentEntity] = Field(default_factory=list)


class UsageAgentConversation(BaseModel):
    """A conversation this agent worked in, by what it spent there."""
    id: str
    title: Optional[str] = None
    totalTokens: int = 0
    answers: int = 0


class UsageAgentDetail(BaseModel):
    """One agent's profile: the entity, its totals, where its tokens went,
    its daily trend and its heaviest (non-private) conversations."""
    agent: UsageAgentEntity
    groups: List[UsageAgentGroup] = Field(default_factory=list)
    tools: list[UsageToolBreakdown] = Field(default_factory=list)
    daily: List[UsageDailyPoint] = Field(default_factory=list)
    topConversations: List[UsageAgentConversation] = Field(default_factory=list)
