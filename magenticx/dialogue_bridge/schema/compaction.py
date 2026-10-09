"""Compaction DTOs (plan 34): the request to compact a conversation or undo it,
what the UI sees of a compaction on an answer, and the agents service's reply
(validated here — the bridge trusts nothing it did not check, from either side)."""
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

from schema.messages import MessageCompactionOut, MessageOut

__all__ = [
    "AgentCompactionResult",
    "AgentCompactionUndoResult",
    "AgentCompactionUsage",
    "CompactConversationIn",
    "CompactConversationOut",
    "MessageCompactionOut",
]


class CompactConversationIn(BaseModel):
    """Compact (or undo the compaction of) the branch ending at this answer."""
    messageId: str = Field(min_length=1, max_length=64)


class CompactConversationOut(BaseModel):
    """``compacted`` with the answer now carrying ``compaction``, or
    ``nothing_to_compact`` (the conversation all fits in the part that is kept)."""
    status: Literal["compacted", "nothing_to_compact"]
    message: Optional[MessageOut] = None


class AgentCompactionUsage(BaseModel):
    """The summary call's spend as the agents service measured it."""
    model_config = ConfigDict(extra="ignore")

    calls: int = Field(0, ge=0)
    input_tokens: int = Field(0, ge=0)
    cached_input_tokens: int = Field(0, ge=0)
    output_tokens: int = Field(0, ge=0)
    reasoning_tokens: int = Field(0, ge=0)
    latency_ms: int = Field(0, ge=0)


class AgentCompactionResult(BaseModel):
    """The agents service's ``POST /agents/{slug}/compact`` reply."""
    model_config = ConfigDict(extra="ignore")

    status: Literal["compacted", "nothing_to_compact", "unsupported"]
    checkpoint_id: Optional[str] = Field(None, max_length=128)
    tokens_before: int = Field(0, ge=0)
    tokens_after: int = Field(0, ge=0)
    freed: int = Field(0, ge=0)
    window: Optional[int] = Field(None, ge=0)
    summarized_messages: int = Field(0, ge=0)
    kept_messages: int = Field(0, ge=0)
    # A summary is a few thousand tokens at most; anything far larger is not one.
    summary: str = Field("", max_length=200_000)
    model: Optional[str] = Field(None, max_length=200)
    usage: AgentCompactionUsage = AgentCompactionUsage()


class AgentCompactionUndoResult(BaseModel):
    """The agents service's ``POST /agents/{slug}/compact/undo`` reply."""
    model_config = ConfigDict(extra="ignore")

    checkpoint_id: str = Field(min_length=1, max_length=128)
