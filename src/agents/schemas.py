from typing import Any, Dict, List, Optional, Type
from pydantic import BaseModel
from dataclasses import dataclass


class Request(BaseModel):
    """Pydantic model for incoming requests: a list of user input dictionaries."""
    messages: List[Dict[str, Any]]
    config: Dict[str, Any]


class TitleRequest(BaseModel):
    """Structured payload for generating a conversation title from the first user message."""
    user_input: List[Dict[str, Any]]



class ConversationTitle(BaseModel):
    """Structured LLM response carrying only the generated title."""
    title: str


class TranscriptionResponse(BaseModel):
    text: str


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
