"""Voice DTOs: read-aloud TTS, dictation transcription, and the OpenAI Realtime
WebRTC session negotiation."""
from typing import Any, Dict, Optional
from pydantic import BaseModel, Field


class ReadAloudRequest(BaseModel):
    """Structured payload for generating spoken audio from AI response text."""
    text: str
    voice: Optional[str] = Field(default=None, min_length=1)


class TranscriptionResponse(BaseModel):
    """Speech-to-text transcription payload returned to the bridge."""
    text: str


class RealtimeSessionRequest(BaseModel):
    """SDP offer and session configuration for OpenAI Realtime WebRTC."""
    sdp: str = Field(..., min_length=1)
    model: Optional[str] = Field(default=None, min_length=1)
    voice: Optional[str] = Field(default=None, min_length=1)
    instructions: str = Field(default="", max_length=20000)
    metadata: Dict[str, Any] = Field(default_factory=dict)


class RealtimeSessionResponse(BaseModel):
    """SDP answer plus the resolved model/voice for the negotiated session."""
    sdp: str
    model: str
    voice: str
