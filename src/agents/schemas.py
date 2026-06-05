from typing import Any, Dict, List, Literal, Optional, Type
from pydantic import BaseModel, Field
from dataclasses import dataclass


class Request(BaseModel):
    """Pydantic model for incoming requests: a list of user input dictionaries."""
    messages: List[Dict[str, Any]]
    config: Dict[str, Any]


class AgentResumeRequest(BaseModel):
    """Resume payload for a LangGraph run paused on a HITL interrupt.

    The bridge forwards an approve/reject decision (plus an optional structured
    value or free-form reason) so the agents service can construct a
    ``Command(resume=...)`` against the saved checkpoint.

    ``interrupt_id`` is the LangGraph interrupt's unique id from the
    ``HITL_INTERRUPT`` event the user acted on. When supplied the agents
    service verifies it matches the checkpoint's currently-pending interrupt
    so a stale click (e.g. the user clicked the second card while the first
    was still in flight) can be 409'd instead of resolving the wrong one.
    """
    config: Dict[str, Any]
    thread_id: str
    decision: Literal["approve", "reject"]
    reason: Optional[str] = None
    value: Optional[Any] = None
    interrupt_id: Optional[str] = None


class TitleRequest(BaseModel):
    """Structured payload for generating a conversation title from the first user message."""
    user_input: List[Dict[str, Any]]



class ConversationTitle(BaseModel):
    """Structured LLM response carrying multiple generated title candidates."""
    titles: List[str]


class SuggestionsRequest(BaseModel):
    """Structured payload for generating personalized new-chat suggestions."""
    user_input: List[Dict[str, Any]]


class ConversationSuggestions(BaseModel):
    """Structured LLM response carrying generated new-chat suggestions."""
    suggestions: List[str]


class ReadAloudRequest(BaseModel):
    """Structured payload for generating spoken audio from AI response text."""
    text: str
    voice: Optional[str] = Field(default=None, min_length=1)


class TranscriptionResponse(BaseModel):
    text: str


class RealtimeSessionRequest(BaseModel):
    """SDP offer and session configuration for OpenAI Realtime WebRTC."""
    sdp: str = Field(..., min_length=1)
    model: Optional[str] = Field(default=None, min_length=1)
    voice: Optional[str] = Field(default=None, min_length=1)
    instructions: str = Field(default="", max_length=20000)
    metadata: Dict[str, Any] = Field(default_factory=dict)


class RealtimeSessionResponse(BaseModel):
    sdp: str
    model: str
    voice: str


class AgentManifest(BaseModel):
    id: str
    slug: str
    name: str
    version: Optional[str] = None
    type: str
    description: str
    icon: str


class ToolManifest(BaseModel):
    server_id: str = ""
    tool_name: str
    description: str = ""
    parameter_count: int = 0


@dataclass(frozen=True)
class AgentDefinition:
    slug: str
    cls: Type[Any]
    manifest: Dict[str, Any]
