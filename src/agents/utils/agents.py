from schemas import AgentDefinition
from blueprints import LangGraphAgent
import langgraph_agents
from typing import Any, Dict, Optional
import inspect
from fastapi import HTTPException, status

def _discover_agents() -> Dict[str, AgentDefinition]:
    """Inspect langgraph_agents exports and register available agent templates."""
    registry: Dict[str, AgentDefinition] = {}
    for attr_name in dir(langgraph_agents):
        candidate = getattr(langgraph_agents, attr_name, None)
        if not inspect.isclass(candidate):
            continue
        if not issubclass(candidate, LangGraphAgent) or candidate is LangGraphAgent:
            continue
        slug = getattr(candidate, "name", None)
        if not isinstance(slug, str) or not slug:
            continue
        manifest = candidate.manifest()
        registry[slug] = AgentDefinition(slug=slug, cls=candidate, manifest=manifest)
    return registry


AGENT_REGISTRY: Dict[str, AgentDefinition] = _discover_agents()


def _instantiate_agent(definition: AgentDefinition, *, config: Optional[Dict[str, Any]]) -> LangGraphAgent:
    """Instantiate an agent template, wrapping errors into HTTPExceptions."""
    try:
        return definition.cls(config=config)
    except Exception as exc:  # noqa: BLE001
        detail = f"Failed to initialise agent '{definition.slug}': {exc}"
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=detail) from exc

