"""Bridge-side proxy to the agents-service memory-inspector endpoints.

The agents service owns the per-(user, agent) memory tree on its filesystem
volume; the bridge proxies list / detail / delete with the trusted-proxy header
and mTLS, translating the catalog agent UUID into the agents-service slug. No
Redis caching here — the inspector is low-traffic and a delete must reflect
immediately. Writes are not exposed: the agent owns memory creation via the
`remember` tool; the user can only inspect and delete.
"""
from __future__ import annotations

from typing import Any, Dict, List

import httpx
from fastapi import HTTPException, status
from observability import get_context, get_logger

from core.error_handling import upstream_error_handler
from core.security.internal_trust import internal_service_headers
from core.security.tls import get_httpx_client_cert, get_httpx_verify
from core.settings import settings
from utils.agents import get_agent_by_id

logger = get_logger(__name__)

_AGENTS_BASE_URL = settings.upstream.agents_service_url.rstrip("/")


def _memories_url(agent_slug: str, user_id: str) -> str:
    return f"{_AGENTS_BASE_URL}/agents/{agent_slug}/users/{user_id}/memories"


def _memory_item_url(agent_slug: str, user_id: str, name: str) -> str:
    return f"{_memories_url(agent_slug, user_id)}/{name}"


def _default_timeout() -> httpx.Timeout:
    return settings.http.skills_timeout


async def _resolve_agent_slug(agent_id: str) -> str:
    """Translate the catalog UUID into the slug the agents service expects."""
    agent = await get_agent_by_id(agent_id)
    if agent is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Agent not found or not active.",
        )
    slug = getattr(agent, "slug", None)
    if not slug:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Agent configuration is incomplete (missing slug).",
        )
    return slug


async def list_agent_memories(*, user_id: str, agent_id: str) -> List[Dict[str, Any]]:
    """Return this (user, agent)'s saved memories (metadata only), sorted by name."""
    agent_slug = await _resolve_agent_slug(agent_id)
    headers = internal_service_headers(get_context().get("request_id"))
    try:
        async with httpx.AsyncClient(
            timeout=_default_timeout(), verify=get_httpx_verify(), cert=get_httpx_client_cert()
        ) as client:
            resp = await upstream_error_handler.run_with_retries(
                logger,
                lambda: client.get(_memories_url(agent_slug, user_id), headers=headers),
                upstream_service="agents",
                operation="user_agent_memories_list",
            )
            resp.raise_for_status()
    except httpx.HTTPStatusError as exc:
        upstream_error_handler.raise_http_error(
            logger, exc,
            event="user_agent_memories_list_failed",
            message="Agents service returned an HTTP error listing memories",
            public_detail="Memories are temporarily unavailable. Please try again.",
            upstream_service="agents", operation="user_agent_memories_list",
        )
    except httpx.RequestError as exc:
        upstream_error_handler.raise_request_error(
            logger, exc,
            event="user_agent_memories_list_unreachable",
            message="Agents service is unreachable listing memories",
            public_detail="Memories are temporarily unavailable. Please try again.",
            upstream_service="agents", operation="user_agent_memories_list",
        )

    payload = resp.json()
    if not isinstance(payload, list):
        logger.warning(
            "user_agent_memories_malformed",
            "Agents service returned a non-list payload for memories",
        )
        return []
    return payload


async def get_agent_memory_detail(*, user_id: str, agent_id: str, name: str) -> Dict[str, Any]:
    """Return one saved memory with its full content (click-to-preview)."""
    agent_slug = await _resolve_agent_slug(agent_id)
    headers = internal_service_headers(get_context().get("request_id"))
    try:
        async with httpx.AsyncClient(
            timeout=_default_timeout(), verify=get_httpx_verify(), cert=get_httpx_client_cert()
        ) as client:
            resp = await upstream_error_handler.run_with_retries(
                logger,
                lambda: client.get(_memory_item_url(agent_slug, user_id, name), headers=headers),
                upstream_service="agents",
                operation="user_agent_memory_detail",
            )
            if resp.status_code == status.HTTP_404_NOT_FOUND:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Memory not found.")
            resp.raise_for_status()
    except HTTPException:
        raise
    except httpx.HTTPStatusError as exc:
        upstream_error_handler.raise_http_error(
            logger, exc,
            event="user_agent_memory_detail_failed",
            message="Agents service returned an HTTP error reading a memory",
            public_detail="That memory is temporarily unavailable. Please try again.",
            upstream_service="agents", operation="user_agent_memory_detail",
        )
    except httpx.RequestError as exc:
        upstream_error_handler.raise_request_error(
            logger, exc,
            event="user_agent_memory_detail_unreachable",
            message="Agents service is unreachable reading a memory",
            public_detail="That memory is temporarily unavailable. Please try again.",
            upstream_service="agents", operation="user_agent_memory_detail",
        )
    return resp.json()


async def delete_agent_memory(*, user_id: str, agent_id: str, name: str) -> None:
    """Delete one memory (removes its yml + AGENTS.md row upstream). Idempotent."""
    agent_slug = await _resolve_agent_slug(agent_id)
    url = _memory_item_url(agent_slug, user_id, name)
    headers = internal_service_headers(get_context().get("request_id"))
    try:
        async with httpx.AsyncClient(
            timeout=_default_timeout(), verify=get_httpx_verify(), cert=get_httpx_client_cert()
        ) as client:
            resp = await upstream_error_handler.run_with_retries(
                logger,
                lambda: client.request("DELETE", url, headers=headers),
                upstream_service="agents",
                operation="user_agent_memory_delete",
            )
            resp.raise_for_status()
    except httpx.HTTPStatusError as exc:
        upstream_error_handler.raise_http_error(
            logger, exc,
            event="user_agent_memory_delete_failed",
            message="Agents service returned an HTTP error deleting a memory",
            public_detail="Could not delete that memory. Please try again.",
            upstream_service="agents", operation="user_agent_memory_delete",
        )
    except httpx.RequestError as exc:
        upstream_error_handler.raise_request_error(
            logger, exc,
            event="user_agent_memory_delete_unreachable",
            message="Agents service is unreachable deleting a memory",
            public_detail="Could not delete that memory. Please try again.",
            upstream_service="agents", operation="user_agent_memory_delete",
        )
