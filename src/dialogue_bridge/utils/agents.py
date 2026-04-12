import logging
import os
from typing import Any, Dict, Iterable, List, Sequence

import httpx
from fastapi import HTTPException
from observability import log_event
from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql import func

from database import AgentTable


logger = logging.getLogger(__name__)

AGENTS_SERVICE_URL = os.getenv("AGENTS_SERVICE_URL", "http://agents:8003")
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


def build_agent_stream_url(slug: str) -> str:
    """Return the streaming endpoint for a given agent slug."""
    # Normalize base URL to avoid double slashes before attaching slug.
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
    try:
        # Pull the latest agent manifests from the agents service.
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.get(_AGENTS_DISCOVERY_ENDPOINT)
            resp.raise_for_status()
            data = resp.json()
            if isinstance(data, list):
                manifests = data
            else:
                log_event(
                    logger,
                    logging.WARNING,
                    "agents_sync_invalid_payload",
                    "Agents service returned an unexpected discovery payload",
                    payload_type=type(data).__name__,
                )
    except httpx.HTTPError as exc:
        log_event(
            logger,
            logging.WARNING,
            "agents_sync_failed",
            "Failed to refresh agents from service",
            error=str(exc),
        )
        raise HTTPException(503, "Agents service unreachable for agent synchronization.") from exc

    manifest_ids: set[str] = set()
    for manifest in manifests or []:
        # Validate basic manifest fields before attempting an upsert.
        agent_id = manifest.get("id")
        slug = manifest.get("slug") or manifest.get("name") or agent_id
        if not agent_id or not slug:
            log_event(
                logger,
                logging.WARNING,
                "agents_sync_skipped_manifest",
                "Skipping agent manifest missing id or slug",
                manifest=manifest,
            )
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
    log_event(
        logger,
        logging.INFO,
        "agents_sync_completed",
        "Agent synchronization completed",
        active_agents=len(refreshed),
        discovered_manifests=len(manifest_ids),
    )
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
    try:
        # Forward the request to the MCP-backed agents service.
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.get(_AGENTS_TOOLS_ENDPOINT)
            resp.raise_for_status()
    except httpx.HTTPError as exc:
        log_event(
            logger,
            logging.WARNING,
            "tools_fetch_failed",
            "Failed to fetch tools from agents service",
            error=str(exc),
        )
        raise HTTPException(
            status_code=503,
            detail="Agents service unreachable for tools synchronization.",
        ) from exc

    try:
        # Parse JSON payload before validating schema shape.
        payload = resp.json()
    except ValueError as exc:
        log_event(
            logger,
            logging.WARNING,
            "tools_fetch_invalid_payload",
            "Agents service returned invalid JSON for tools",
            error=str(exc),
        )
        raise HTTPException(
            status_code=502,
            detail="Agents service returned invalid JSON for tools.",
        ) from exc

    if not isinstance(payload, list):
        # The UI expects a list of manifests; enforce here for better errors.
        log_event(
            logger,
            logging.WARNING,
            "tools_fetch_invalid_payload",
            "Agents service returned an unexpected tools payload",
            payload_type=type(payload).__name__,
        )
        raise HTTPException(
            status_code=502,
            detail="Agents service returned an unexpected tools payload.",
        )

    return payload
