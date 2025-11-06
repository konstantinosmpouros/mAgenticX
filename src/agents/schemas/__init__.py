from typing import Any, Dict, List, Optional, Type
from pydantic import BaseModel
from blueprints import LangGraphAgent
from dataclasses import dataclass


class Request(BaseModel):
    """Pydantic model for incoming requests: a list of user input dictionaries."""
    user_input: List[Dict[str, Any]]
    config: Optional[Dict[str, Any]] = None


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


@dataclass(frozen=True)
class AgentDefinition:
    slug: str
    cls: Type[LangGraphAgent]
    manifest: Dict[str, Any]