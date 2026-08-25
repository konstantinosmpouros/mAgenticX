"""Voice DTOs: dictation, read-aloud preview, and realtime voice sessions."""
from typing import Literal, Optional
from pydantic import BaseModel, Field
from schema.conversations import ConversationSummary


class DictationResponse(BaseModel):
    """Speech-to-text transcription payload returned to the UI."""
    text: str


class ReadAloudPreviewRequest(BaseModel):
    """Payload for previewing a read-aloud voice from profile settings."""
    voice: str = Field(default="alloy", min_length=1)
    text: str = Field(default="Hey! I am your AI speaker.", min_length=1, max_length=120)


class RealtimeVoiceSessionIn(BaseModel):
    """Browser SDP offer plus conversation context for a realtime voice session."""
    agentId: str
    conversationId: Optional[str] = None
    sdp: str = Field(..., min_length=1)
    voice: Optional[str] = None
    language: Optional[str] = None


class RealtimeVoiceSessionOut(BaseModel):
    """SDP answer and conversation context for a realtime voice session."""
    sdp: str
    model: str
    voice: str


class RealtimeVoiceConversationEventIn(BaseModel):
    """Persist a completed realtime voice transcript turn into the conversation."""
    conversationId: str
    role: Literal["user", "assistant"]
    transcript: str = Field(..., min_length=1)
    itemId: Optional[str] = None
    responseId: Optional[str] = None
    rawEvent: Optional[dict] = None


class RealtimeVoiceEndIn(BaseModel):
    conversationId: str


class RealtimeVoiceEndOut(BaseModel):
    summary: ConversationSummary
