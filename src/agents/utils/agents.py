import inspect
import os
from typing import Dict, Set

import langgraph_agents
from blueprints import LangGraphAgent
from schemas import AgentDefinition


def _normalize_slug(slug: str) -> str:
    """Trim whitespace and lowercase for comparisons."""
    return slug.strip().lower()


def _disabled_slugs_from_env() -> Set[str]:
    """Parse DISABLED_AGENT_SLUGS env var into a normalized set."""
    raw_value = os.getenv("DISABLED_AGENT_SLUGS", "")
    if not raw_value:
        return set()
    parts = [item.strip() for item in raw_value.split(",")]
    return {_normalize_slug(item) for item in parts if item}


def _discover_agents() -> Dict[str, AgentDefinition]:
    """Inspect langgraph_agents exports and register available agent templates."""
    registry: Dict[str, AgentDefinition] = {}
    disabled_slugs = _disabled_slugs_from_env()

    for attr_name in dir(langgraph_agents):
        candidate = getattr(langgraph_agents, attr_name, None)
        if not inspect.isclass(candidate):
            continue
        if not issubclass(candidate, LangGraphAgent) or candidate is LangGraphAgent:
            continue
        slug = getattr(candidate, "name", None)
        if not isinstance(slug, str) or not slug:
            continue
        normalized_slug = _normalize_slug(slug)
        if normalized_slug in disabled_slugs:
            print(f"Agent '{slug}' disabled via DISABLED_AGENT_SLUGS; skipping registration.")
            continue
        manifest = candidate.manifest()
        registry[slug] = AgentDefinition(slug=slug, cls=candidate, manifest=manifest)
    return registry


AGENT_REGISTRY: Dict[str, AgentDefinition] = _discover_agents()

