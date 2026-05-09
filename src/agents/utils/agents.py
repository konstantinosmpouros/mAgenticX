import inspect
from typing import Dict, Set

import langgraph_agents
import deep_agents
from runtime import LangGraphAgent, DeepAgent
from core.settings import settings
from observability import get_logger
from schemas import AgentDefinition

logger = get_logger(__name__)

def _normalize_slug(slug: str) -> str:
    """Trim whitespace and lowercase for comparisons."""
    return slug.strip().lower()


def _discover_agents() -> Dict[str, AgentDefinition]:
    """Inspect langgraph_agents and deep_agents exports and register available agent templates."""
    registry: Dict[str, AgentDefinition] = {}
    disabled_slugs: Set[str] = set(settings.registry.disabled_agent_slugs)

    sources = [
        (langgraph_agents, LangGraphAgent),
        (deep_agents, DeepAgent),
    ]

    for module, base_cls in sources:
        for attr_name in dir(module):
            candidate = getattr(module, attr_name, None)
            if not inspect.isclass(candidate):
                continue
            if not issubclass(candidate, base_cls) or candidate is base_cls:
                continue
            slug = getattr(candidate, "name", None)
            if not isinstance(slug, str) or not slug:
                continue
            normalized_slug = _normalize_slug(slug)
            if normalized_slug in disabled_slugs:
                logger.info("agent_registration_skipped", "Agent disabled via DISABLED_AGENT_SLUGS; skipping registration", agent_slug=slug)
                continue
            manifest = candidate.manifest()
            registry[slug] = AgentDefinition(slug=slug, cls=candidate, manifest=manifest)

    logger.info("agent_registry_discovered", "Agent registry discovered", count=len(registry))
    return registry


AGENT_REGISTRY: Dict[str, AgentDefinition] = _discover_agents()
