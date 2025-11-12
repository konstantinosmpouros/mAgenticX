from typing import Any, Dict, List, Optional, Type
from pydantic import BaseModel
from blueprints import LangGraphAgent
from dataclasses import dataclass


class Request(BaseModel):
    """Pydantic model for incoming requests: a list of user input dictionaries."""
    user_input: List[Dict[str, Any]]
    config: Dict[str, Any]


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
    name: str
    description: str = ""
    input_schema: Dict[str, Any]
    output_schema: Optional[Dict[str, Any]] = None


@dataclass(frozen=True)
class AgentDefinition:
    slug: str
    cls: Type[LangGraphAgent]
    manifest: Dict[str, Any]
