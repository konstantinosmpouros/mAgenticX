"""Agent discovery / registry.

Builds ``AGENT_REGISTRY`` — slug → :class:`~schemas.AgentDefinition` — from two
sources, hybrid during the migration to declarative agents:

1. **Python-class agents** (legacy) — subclasses of ``LangGraphAgent`` /
   ``DeepAgent`` reachable from the ``langgraph_agents`` / ``deep_agents``
   packages. Discovered at import.
2. **Declarative (YAML) agents** — ``<global_root>/agents/<slug>/agent.yaml``
   parsed into an :class:`~runtime.abstractions.agent_spec.AgentSpec` and served
   by a shared :class:`~runtime.abstractions.yaml_agent.YamlDeepAgent`. A YAML
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
from runtime.abstractions import AgentSpec, DeepAgent, LangGraphAgent, YamlDeepAgent
from runtime.filesystem import layout
from runtime.tools.registry import is_known_native_tool
from utils.declarative import manifest_from_spec
from core.settings import settings
from core.logging import get_logger
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
            spec=spec,
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


# ---------------------------------------------------------------------------
# User-authored agents — resolved per request, never registered
# ---------------------------------------------------------------------------
# A user's agents live in their own workspace, so they cannot go in
# AGENT_REGISTRY: that dict is process-global and keyed by slug alone, so two
# users owning the same slug would collide and one user's definition would be
# reachable by another. They are resolved on demand and memoised by
# (user_id, slug) together with the manifest's mtime — an edit to agent.yaml
# invalidates the entry naturally, with no explicit cache-busting to forget.
_USER_AGENT_CACHE: Dict[tuple[str, str], tuple[float, AgentDefinition]] = {}


def _load_user_agent(user_id: str, slug: str) -> Optional[AgentDefinition]:
    """Parse + validate one user-authored agent from their workspace.

    Returns ``None`` when the folder or manifest is absent, or when the spec is
    invalid — an unusable definition must read as "no such agent" (a 404) rather
    than take the request down with a 500.
    """
    try:
        agent_dir = layout.user_custom_agent_dir(user_id, slug)
    except ValueError:
        # Illegal path segment in user_id/slug — treat as not found, never as a
        # path to probe.
        return None
    manifest_path = agent_dir / "agent.yaml"
    if not manifest_path.is_file():
        return None

    try:
        mtime = manifest_path.stat().st_mtime
    except OSError:
        return None

    cached = _USER_AGENT_CACHE.get((user_id, slug))
    if cached is not None and cached[0] == mtime:
        return cached[1]

    try:
        raw = yaml.safe_load(manifest_path.read_text(encoding="utf-8")) or {}
        spec = AgentSpec.model_validate(raw)
        if spec.slug != slug:
            raise ValueError(
                f"Agent slug {spec.slug!r} does not match its folder name {slug!r}."
            )
        ref_errors = spec.reference_errors(
            is_known_model=_is_known_model,
            is_known_native_tool=is_known_native_tool,
        )
        if ref_errors:
            raise ValueError("; ".join(ref_errors))
    except Exception:
        logger.error(
            "user_agent_invalid",
            "Skipping invalid user-authored agent",
            agent_dir=str(agent_dir),
            exc_info=True,
        )
        return None

    definition = AgentDefinition(
        slug=spec.slug,
        manifest=manifest_from_spec(spec),
        factory=(lambda cfg, s=spec, sd=agent_dir: YamlDeepAgent(s, sd, config=cfg)),
        spec=spec,
    )
    _USER_AGENT_CACHE[(user_id, slug)] = (mtime, definition)
    return definition


def resolve_agent_definition(
    slug: str, owner_user_id: Optional[str] = None
) -> Optional[AgentDefinition]:
    """The single lookup for "give me this agent".

    ``owner_user_id`` comes from the run context and is set by the bridge from
    the agents table, which is the authority on ownership:

    * ``None`` → a platform agent; served from ``AGENT_REGISTRY``.
    * set      → that user's own agent, loaded from their workspace.

    The two namespaces are disjoint lookups, so a user-authored agent can never
    shadow a platform one regardless of what they named it.
    """
    if owner_user_id:
        return _load_user_agent(owner_user_id, slug)
    return AGENT_REGISTRY.get(slug)


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
