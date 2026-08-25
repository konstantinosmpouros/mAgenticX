"""Catalog DTOs: what the bridge discovers about this service — agent manifests,
MCP tool manifests, and the in-process registry entry an agent slug resolves to."""
from typing import Any, Callable, Dict, Optional, Type
from dataclasses import dataclass
from pydantic import BaseModel


class AgentManifest(BaseModel):
    """One agent as advertised to the bridge's GET /agents discovery sync."""
    id: str
    slug: str
    name: str
    version: Optional[str] = None
    type: str
    description: str
    icon: str


class ToolManifest(BaseModel):
    """One MCP tool as advertised to the UI tool catalog (GET /tools)."""
    server_id: str = ""
    tool_name: str
    description: str = ""
    parameter_count: int = 0


@dataclass(frozen=True)
class AgentDefinition:
    """A registered agent template. ``cls`` is set for Python-class agents,
    ``factory`` for declarative (YAML) agents; ``build()`` picks whichever is
    present, so callers never branch on the kind."""

    slug: str
    manifest: Dict[str, Any]
    cls: Optional[Type[Any]] = None
    factory: Optional[Callable[..., Any]] = None
    # The parsed AgentSpec for declarative (YAML) agents; None for Python-class
    # agents. Kept opaque (Any) so this DTO module stays decoupled from
    # runtime.abstractions. Used to compute the agent's declared tool set for the
    # per-agent tools endpoint.
    spec: Optional[Any] = None

    def build(self, config: Optional[Dict[str, Any]] = None) -> Any:
        """Instantiate the agent for a run — ``factory(config)`` (YAML) or
        ``cls(config=config)`` (Python class)."""
        if self.factory is not None:
            return self.factory(config)
        if self.cls is not None:
            return self.cls(config=config)
        raise ValueError(f"AgentDefinition {self.slug!r} has neither factory nor cls.")
