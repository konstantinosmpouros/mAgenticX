from schemas import AgentDefinition
from blueprints import LangGraphAgent
import langgraph_agents
from typing import Dict
import inspect


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

