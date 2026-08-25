"""Sharing DTOs: share links, public shared view, PDF export."""
from typing import List, Literal, Optional
from pydantic import BaseModel, Field, field_validator, model_validator
from datetime import datetime
from schema.base import UTCDateTime
from schema.catalog import AgentPublic
from schema.messages import MessageOut


class ConversationShareIn(BaseModel):
    """Create a read-only share snapshot ending at a selected AI message."""
    messageId: str
    mode: Literal["full", "branch", "message"] = "branch"
    branchPath: Optional[list[str]] = None
    expiresAt: Optional[UTCDateTime] = None

    @field_validator("branchPath", mode="before")
    @classmethod
    def _normalize_branch_path(cls, value):
        if value is None:
            return None
        if not isinstance(value, list):
            return None
        normalized = [str(item).strip() for item in value if str(item).strip()]
        return normalized or None

    @model_validator(mode="after")
    def _validate_expiration(self):
        if self.expiresAt is None:
            return self
        expires_at = self.expiresAt.replace(tzinfo=None)
        if expires_at <= datetime.utcnow():
            raise ValueError("Share expiration must be in the future.")
        self.expiresAt = expires_at
        return self


class ConversationPdfExportIn(BaseModel):
    """Export a conversation scope as a transient PDF attachment."""
    messageId: str
    mode: Literal["full", "branch", "message"] = "full"
    branchPath: Optional[list[str]] = None

    @field_validator("branchPath", mode="before")
    @classmethod
    def _normalize_branch_path(cls, value):
        if value is None:
            return None
        if not isinstance(value, list):
            return None
        normalized = [str(item).strip() for item in value if str(item).strip()]
        return normalized or None


class ConversationShareResponse(BaseModel):
    """Owner response for a created share link."""
    id: str
    token: str
    shareUrl: str
    conversationId: str
    messageId: str
    shareMode: Literal["full", "branch", "message"] = "branch"
    title: Optional[str] = None
    isActive: bool = True
    revokedAt: Optional[UTCDateTime] = None
    expiresAt: Optional[UTCDateTime] = None
    createdAt: UTCDateTime


class ConversationShareListItem(BaseModel):
    """Owner-facing shared conversation link record."""
    id: str
    token: str
    shareUrl: str
    conversationId: str
    messageId: Optional[str] = None
    shareMode: Literal["full", "branch", "message"] = "branch"
    title: Optional[str] = None
    isActive: bool
    status: Literal["active", "expired", "revoked"]
    revokedAt: Optional[UTCDateTime] = None
    expiresAt: Optional[UTCDateTime] = None
    createdAt: UTCDateTime


class SharedConversationDetail(BaseModel):
    """Public read-only shared conversation snapshot."""
    token: str
    title: Optional[str] = None
    shareMode: Literal["full", "branch", "message"] = "branch"
    agent: AgentPublic
    messages: List[MessageOut] = Field(default_factory=list)
    expiresAt: Optional[UTCDateTime] = None
    createdAt: UTCDateTime
