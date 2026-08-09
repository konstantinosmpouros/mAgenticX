"""Agent discovery / registry.

Builds ``AGENT_REGISTRY`` — slug → :class:`~schemas.AgentDefinition` — from two
sources, hybrid during the migration to declarative agents:

1. **Python-class agents** (legacy) — subclasses of ``LangGraphAgent`` /
   ``DeepAgent`` reachable from the ``langgraph_agents`` / ``deep_agents``
   packages. Discovered at import.
2. **Declarative (YAML) agents** — ``<global_root>/agents/<slug>/agent.yaml``
   parsed into an :class:`~runtime.declarative.agent_spec.AgentSpec` and served
   by a shared :class:`~runtime.declarative.yaml_agent.YamlDeepAgent`. A YAML
   agent **overrides** a
   Python-class agent with the same slug (the migration direction).

The registry is **refreshable**, not frozen at import: the global volume is
seeded during the service lifespan (after import), so :func:`refresh_registry`
must be called once the seed is in place to pick up the built-in YAML agents.
It mutates ``AGENT_REGISTRY`` **in place** so modules that did
``from utils.agents import AGENT_REGISTRY`` observe the update.
"""
import inspect
from pathlib import Path
from typing import Dict, Optional, Set

import yaml

import langgraph_agents
import deep_agents
from runtime import LangGraphAgent, DeepAgent
from runtime.tools.registry import is_known_native_tool
from runtime.declarative import AgentSpec, YamlDeepAgent, manifest_from_spec
from core.settings import settings
from observability import get_logger
from schemas import AgentDefinition

logger = get_logger(__name__)


def _normalize_slug(slug: str) -> str:
    """Trim whitespace and lowercase for comparisons."""
    return slug.strip().lower()


def _is_known_model(model_id: str) -> bool:
    """Provisional model allowlist. A real ``MODEL_REGISTRY`` (with context
    windows + pricing) lands later; for now accept any ``provider:model`` id so
    specs validate structurally without blocking on an unbuilt registry."""
    return isinstance(model_id, str) and ":" in model_id


def _discover_python_agents() -> Dict[str, AgentDefinition]:
    """Legacy path: register Python-class agent templates."""
    registry: Dict[str, AgentDefinition] = {}
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
            registry[slug] = AgentDefinition(
                slug=slug,
                manifest=candidate.manifest(),
                cls=candidate,
                # Wrap the class so `build()` is uniform with YAML agents.
                factory=(lambda cfg, c=candidate: c(config=cfg)),
            )
    return registry


def _scan_yaml_agents(root: Path) -> Dict[str, AgentDefinition]:
    """Discover declarative agents under ``<root>/agents/<slug>/agent.yaml``.

    Each is validated structurally (``AgentSpec``) and referentially (models +
    native tools); an invalid spec is logged and skipped, never fatal — one bad
    folder must not take down discovery.
    """
    registry: Dict[str, AgentDefinition] = {}
    agents_dir = Path(root) / "agents"
    if not agents_dir.is_dir():
        return registry

    for entry in sorted(agents_dir.iterdir()):
        manifest_path = entry / "agent.yaml"
        if not manifest_path.is_file():
            continue
        try:
            raw = yaml.safe_load(manifest_path.read_text(encoding="utf-8")) or {}
            spec = AgentSpec.model_validate(raw)
            ref_errors = spec.reference_errors(
                is_known_model=_is_known_model,
                is_known_native_tool=is_known_native_tool,
            )
            if ref_errors:
                raise ValueError("; ".join(ref_errors))
        except Exception:
            logger.error(
                "yaml_agent_invalid",
                "Skipping invalid declarative agent",
                agent_dir=str(entry),
                exc_info=True,
            )
            continue

        registry[spec.slug] = AgentDefinition(
            slug=spec.slug,
            manifest=manifest_from_spec(spec),
            factory=(lambda cfg, s=spec, sd=entry: YamlDeepAgent(s, sd, config=cfg)),
        )
    return registry


def _build_registry() -> Dict[str, AgentDefinition]:
    """Merge Python-class + global YAML agents, YAML winning on slug collision,
    then drop any slug in ``DISABLED_AGENT_SLUGS``."""
    disabled: Set[str] = set(settings.registry.disabled_agent_slugs)
    registry = _discover_python_agents()
    yaml_agents = _scan_yaml_agents(settings.filesystem.global_root)
    for slug, definition in yaml_agents.items():
        if slug in registry:
            logger.info(
                "agent_yaml_overrides_python",
                "Declarative agent overrides the Python-class agent of the same slug",
                agent_slug=slug,
            )
        registry[slug] = definition

    for slug in list(registry):
        if _normalize_slug(slug) in disabled:
            registry.pop(slug)
            logger.info(
                "agent_registration_skipped",
                "Agent disabled via DISABLED_AGENT_SLUGS; skipping registration",
                agent_slug=slug,
            )

    logger.info(
        "agent_registry_discovered",
        "Agent registry discovered",
        count=len(registry),
        python_count=len(_discover_python_agents()),
        yaml_count=len(yaml_agents),
    )
    return registry


AGENT_REGISTRY: Dict[str, AgentDefinition] = _build_registry()


def refresh_registry() -> Dict[str, AgentDefinition]:
    """Re-scan sources and update ``AGENT_REGISTRY`` **in place**.

    Called from the service lifespan after the global volume is seeded, so the
    built-in YAML agents (invisible at import time, before the seed) become
    available. Mutating in place keeps existing ``AGENT_REGISTRY`` references
    valid."""
    fresh = _build_registry()
    AGENT_REGISTRY.clear()
    AGENT_REGISTRY.update(fresh)
    return AGENT_REGISTRY
