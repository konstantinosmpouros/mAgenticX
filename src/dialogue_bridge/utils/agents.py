from typing import Any, Dict, Iterable, List, Sequence

import httpx
from fastapi import HTTPException, status
from observability import get_context, get_logger
from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql import func

from core.configs import settings
from core.tls import get_httpx_verify
from core.database import AgentTable
from core.proxy import internal_service_headers
from core.error_handling import upstream_error_handler


logger = get_logger(__name__)

AGENTS_SERVICE_URL = settings.upstream.agents_service_url
_AGENTS_DISCOVERY_ENDPOINT = f"{AGENTS_SERVICE_URL.rstrip('/')}/agents"
_AGENTS_TOOLS_ENDPOINT = f"{AGENTS_SERVICE_URL.rstrip('/')}/tools"
_AGENT_CACHE: Dict[str, AgentTable] = {}


def prime_agent_cache(agents: Iterable[AgentTable]) -> None:
    """Store active agents for fast validation lookups."""
    global _AGENT_CACHE
    # Keep only active agents so downstream validators skip disabled ones.
    _AGENT_CACHE = {agent.id: agent for agent in agents if getattr(agent, "is_active", True)}


def get_cached_agents() -> List[AgentTable]:
    """Return cached active agents; empty list if cache not yet primed."""
    # Return a list copy to avoid callers mutating the internal cache.
    return list(_AGENT_CACHE.values())


def build_agent_stream_url(agent: AgentTable) -> str:
    """Return the streaming endpoint for a given agent slug."""
    # Normalize base URL to avoid double slashes before attaching slug.
    if agent is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Agent metadata unavailable for this conversation",
        )
    
    slug = getattr(agent, "slug", None)
    if not slug:
        logger.error(
            "agent_stream_url_missing_slug",
            "Agent stream URL could not be built because slug is missing",
            agent_id=getattr(agent, "id", None),
            failure_reason="agent_slug_missing",
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Agent configuration is incomplete. Please try another agent or try again later.",
        )
    return f"{AGENTS_SERVICE_URL.rstrip('/')}/agents/{slug}/stream"


async def _load_active_agents(db: AsyncSession) -> List[AgentTable]:
    # Query all active agents so we can refresh the in-memory cache.
    result = await db.execute(select(AgentTable).where(AgentTable.is_active == True))  # noqa: E712
    return list(result.scalars().all())


async def sync_agents_with_service(db: AsyncSession) -> List[AgentTable]:
    """
    Discover agents from the agents service, upsert them into the database, and
    toggle their active status. If the agents service is unreachable, surface a 503.
    """
    manifests: Sequence[Dict[str, Any]] | None = None
    timeout = httpx.Timeout(connect=10.0, read=30.0, write=30.0, pool=10.0)
    request_id = get_context().get("request_id")
    upstream_headers = internal_service_headers(request_id)
    try:
        # Pull the latest agent manifests from the agents service.
        async with httpx.AsyncClient(timeout=timeout, verify=get_httpx_verify()) as client:
            resp = await upstream_error_handler.run_with_retries(
                logger,
                lambda: client.get(_AGENTS_DISCOVERY_ENDPOINT, headers=upstream_headers),
                upstream_service="agents",
                operation="agent_sync",
            )
            resp.raise_for_status()
    except httpx.HTTPStatusError as exc:
        upstream_error_handler.raise_http_error(
            logger,
            exc,
            event="agents_sync_failed",
            message="Agents service returned an HTTP error during agent synchronization",
            public_detail="Agent service could not refresh the available agents. Please try again.",
            upstream_service="agents",
            operation="agent_sync",
        )
    except httpx.RequestError as exc:
        upstream_error_handler.raise_request_error(
            logger,
            exc,
            event="agents_sync_unreachable",
            message="Failed to reach agents service during agent synchronization",
            public_detail="Agent service is temporarily unavailable. Please try again shortly.",
            upstream_service="agents",
            operation="agent_sync",
        )

    try:
        data = resp.json()
    except ValueError as exc:
        upstream_error_handler.raise_invalid_response(
            logger,
            exc,
            event="agents_sync_invalid_json",
            message="Agents service returned invalid JSON during agent synchronization",
            public_detail="Agent service returned an unexpected response. Please try again.",
            upstream_service="agents",
            operation="agent_sync",
        )

    if isinstance(data, list):
        manifests = data
    else:
        upstream_error_handler.raise_invalid_response(
            logger,
            event="agents_sync_invalid_payload",
            message="Agents service returned an unexpected discovery payload",
            public_detail="Agent service returned an unexpected response. Please try again.",
            upstream_service="agents",
            operation="agent_sync",
            payload_type=type(data).__name__,
        )

    manifest_ids: set[str] = set()
    for manifest in manifests or []:
        # Validate basic manifest fields before attempting an upsert.
        agent_id = manifest.get("id")
        slug = manifest.get("slug") or manifest.get("name") or agent_id
        if not agent_id or not slug:
            logger.warning("agents_sync_skipped_manifest", "Skipping agent manifest missing id or slug", upstream_service="agents", manifest_keys=sorted(manifest.keys()) if isinstance(manifest, dict) else None)
            continue
        manifest_ids.add(str(agent_id))

        # Upsert each manifest to keep DB rows aligned with the remote service.
        stmt = (
            insert(AgentTable)
            .values(
                id=str(agent_id),
                slug=str(slug),
                name=manifest.get("name") or str(agent_id),
                description=manifest.get("description") or "",
                icon=manifest.get("icon") or "",
                version=manifest.get("version"),
                is_active=True,
            )
            .on_conflict_do_update(
                index_elements=["id"],
                set_={
                    "slug": str(slug),
                    "name": manifest.get("name") or str(agent_id),
                    "description": manifest.get("description") or "",
                    "icon": manifest.get("icon") or "",
                    "version": manifest.get("version"),
                    "is_active": True,
                    "updated_at": func.now(),  # type: ignore[name-defined]
                },
            )
        )
        await db.execute(stmt)

    if manifest_ids:
        # Deactivate any DB agents not present in the latest manifest list.
        await db.execute(
            update(AgentTable)
            .where(AgentTable.id.notin_(list(manifest_ids)))
            .values(is_active=False)
        )
    else:
        await db.execute(update(AgentTable).values(is_active=False))

    # Persist changes, refresh cache, and return the new active list.
    await db.commit()
    refreshed = await _load_active_agents(db)
    prime_agent_cache(refreshed)
    logger.info("agents_sync_completed", "Agent synchronization completed", upstream_service="agents", active_agents=len(refreshed), discovered_manifests=len(manifest_ids))
    return refreshed


async def get_agent_by_id(agent_id: str) -> AgentTable | None:
    """Fetch an agent from cache or database without enforcing validation semantics."""
    # Prefer the in-memory cache for constant-time lookups during API calls.
    agent = _AGENT_CACHE.get(agent_id)
    if agent is not None and getattr(agent, "is_active", True):
        return agent
    return None


async def fetch_tools_from_agents_service() -> List[Dict[str, Any]]:
    """Proxy the agents service `/tools` endpoint without caching."""
    timeout = httpx.Timeout(connect=10.0, read=30.0, write=30.0, pool=10.0)
    request_id = get_context().get("request_id")
    upstream_headers = internal_service_headers(request_id)
    try:
        # Forward the request to the MCP-backed agents service.
        async with httpx.AsyncClient(timeout=timeout, verify=get_httpx_verify()) as client:
            resp = await upstream_error_handler.run_with_retries(
                logger,
                lambda: client.get(_AGENTS_TOOLS_ENDPOINT, headers=upstream_headers),
                upstream_service="agents",
                operation="tools_fetch",
            )
            resp.raise_for_status()
    except httpx.HTTPStatusError as exc:
        upstream_error_handler.raise_http_error(
            logger,
            exc,
            event="tools_fetch_failed",
            message="Agents service returned an HTTP error while fetching tools",
            public_detail="Tool catalog could not be refreshed. Please try again.",
            upstream_service="agents",
            operation="tools_fetch",
        )
    except httpx.RequestError as exc:
        upstream_error_handler.raise_request_error(
            logger,
            exc,
            event="tools_fetch_unreachable",
            message="Failed to reach agents service while fetching tools",
            public_detail="Tool catalog is temporarily unavailable. Please try again shortly.",
            upstream_service="agents",
            operation="tools_fetch",
        )

    try:
        # Parse JSON payload before validating schema shape.
        payload = resp.json()
    except ValueError as exc:
        upstream_error_handler.raise_invalid_response(
            logger,
            exc,
            event="tools_fetch_invalid_json",
            message="Agents service returned invalid JSON for tools",
            public_detail="Tool catalog returned an unexpected response. Please try again.",
            upstream_service="agents",
            operation="tools_fetch",
        )

    if not isinstance(payload, list):
        # The UI expects a list of manifests; enforce here for better errors.
        upstream_error_handler.raise_invalid_response(
            logger,
            event="tools_fetch_invalid_payload",
            message="Agents service returned an unexpected tools payload",
            public_detail="Tool catalog returned an unexpected response. Please try again.",
            upstream_service="agents",
            operation="tools_fetch",
            payload_type=type(payload).__name__,
        )

    return payload
