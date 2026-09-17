"""Workspace search DTOs."""
from typing import Literal, Optional
from pydantic import BaseModel
from schema.base import UTCDateTime


class WorkspaceSearchResult(BaseModel):
    """Flat search result consumed by the sidebar search panel."""
    kind: Literal["conversation", "message", "file", "agent"]
    id: str
    conversationId: Optional[str] = None
    agentId: Optional[str] = None
    title: str
    subtitle: Optional[str] = None
    snippet: Optional[str] = None
    updatedAt: Optional[UTCDateTime] = None
