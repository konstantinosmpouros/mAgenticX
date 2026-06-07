"""Bridge-side wrapper around the agents-service skills registry endpoint.

The agents service owns the source of truth (the `skills_registry/` directory
in its image). The bridge proxies GET requests with the trusted-proxy header
and **caches the result in Redis with a TTL** so the second request inside
the TTL window doesn't hit the agents service at all. Per the design, the
UI never persists skills locally — every page refresh re-hits the bridge,
which is expected to be cheap thanks to the Redis hit.
"""
from __future__ import annotations

from typing import Any, Dict, List

import httpx
from fastapi import HTTPException, status
from observability import get_context, get_logger

from core.proxy import internal_service_headers
from core.settings import settings
from core.tls import get_httpx_verify
from core.error_handling import upstream_error_handler

from utils.agents import get_agent_by_id
from utils.skills_cache import skills_cache

logger = get_logger(__name__)

_AGENTS_BASE_URL = settings.upstream.agents_service_url.rstrip("/")
_AGENTS_SKILLS_ENDPOINT = f"{_AGENTS_BASE_URL}/skills"


def _user_agent_skills_url(agent_slug: str, user_id: str) -> str:
    return f"{_AGENTS_BASE_URL}/agents/{agent_slug}/users/{user_id}/skills"


def _user_agent_skill_item_url(agent_slug: str, user_id: str, skill_name: str) -> str:
    return f"{_user_agent_skills_url(agent_slug, user_id)}/{skill_name}"


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


async def list_skills(*, bypass_cache: bool = False) -> List[Dict[str, Any]]:
    """Return the skills registry, read-through cached in Redis.

    Cache contract:
      - Cache hit → return the cached list, no upstream call.
      - Cache miss → fetch from the agents service, store with TTL, return.
      - ``bypass_cache=True`` → **skip the read**, fetch fresh from the agents
        service, then **upsert** Redis with the new snapshot. This is the
        path the UI's manual "refresh" button takes — it both renews the
        cache for everyone else and gives the clicking user the latest list.
      - Cache write failures are swallowed; we still return the upstream
        result so a Redis outage degrades to "slightly slower" instead of
        breaking the request.

    Returns the raw JSON list (`{name, description, content}` per entry).
    The router validates and converts to the bridge-side ``Skill`` schema.
    """
    if not bypass_cache:
        cached = await skills_cache.get_registry()
        if cached is not None:
            logger.info("skills_list_cache_hit", "Served skills from Redis cache", count=len(cached))
            return cached

    timeout = httpx.Timeout(connect=10.0, read=15.0, write=10.0, pool=10.0)
    request_id = get_context().get("request_id")
    upstream_headers = internal_service_headers(request_id)

    try:
        async with httpx.AsyncClient(timeout=timeout, verify=get_httpx_verify()) as client:
            resp = await upstream_error_handler.run_with_retries(
                logger,
                lambda: client.get(_AGENTS_SKILLS_ENDPOINT, headers=upstream_headers),
                upstream_service="agents",
                operation="skills_list",
            )
            resp.raise_for_status()
    except httpx.HTTPStatusError as exc:
        upstream_error_handler.raise_http_error(
            logger,
            exc,
            event="skills_list_failed",
            message="Agents service returned an HTTP error listing skills",
            public_detail="Skill catalogue is temporarily unavailable. Please try again.",
            upstream_service="agents",
            operation="skills_list",
        )
    except httpx.RequestError as exc:
        upstream_error_handler.raise_request_error(
            logger,
            exc,
            event="skills_list_failed",
            message="Agents service is unreachable while listing skills",
            public_detail="Skill catalogue is temporarily unavailable. Please try again.",
            upstream_service="agents",
            operation="skills_list",
        )

    payload = resp.json()
    if not isinstance(payload, list):
        logger.warning("skills_list_malformed", "Agents service returned non-list payload")
        return []
    # Upsert on both cache-miss and bypass paths — bypass is "the user wants
    # the latest, and now everyone else does too." Same TTL applies either way.
    await skills_cache.set_registry(payload)
    if bypass_cache:
        logger.info("skills_list_bypass_refresh", "Bypassed Redis and re-upserted registry", count=len(payload))
    else:
        logger.info("skills_list_cache_miss", "Fetched skills upstream and cached in Redis", count=len(payload))
    return payload


# ---------------------------------------------------------------------------
# Per-(user, agent) skill selection
# ---------------------------------------------------------------------------
async def get_user_agent_skills(*, user_id: str, agent_id: str) -> List[str]:
    """Return enabled skill names for the (user, agent) pair, read-through cached.

    Cache hit short-circuits the upstream call entirely; cache miss fetches
    the canonical answer from the agents service (which reads its own
    filesystem) and stores it with a short TTL. Mutation endpoints invalidate
    the cache explicitly, so the TTL is just a safety net.
    """
    cached = await skills_cache.get_user_agent_skills(user_id, agent_id)
    if cached is not None:
        logger.info(
            "user_agent_skills_cache_hit",
            "Served per-(user, agent) skills from Redis",
            user_id=user_id,
            agent_id=agent_id,
            count=len(cached),
        )
        return cached

    agent_slug = await _resolve_agent_slug(agent_id)
    timeout = httpx.Timeout(connect=10.0, read=15.0, write=10.0, pool=10.0)
    request_id = get_context().get("request_id")
    upstream_headers = internal_service_headers(request_id)

    try:
        async with httpx.AsyncClient(timeout=timeout, verify=get_httpx_verify()) as client:
            resp = await upstream_error_handler.run_with_retries(
                logger,
                lambda: client.get(
                    _user_agent_skills_url(agent_slug, user_id), headers=upstream_headers
                ),
                upstream_service="agents",
                operation="user_agent_skills_list",
            )
            resp.raise_for_status()
    except httpx.HTTPStatusError as exc:
        upstream_error_handler.raise_http_error(
            logger,
            exc,
            event="user_agent_skills_list_failed",
            message="Agents service returned an HTTP error listing user-agent skills",
            public_detail="Skill selection is temporarily unavailable. Please try again.",
            upstream_service="agents",
            operation="user_agent_skills_list",
        )
    except httpx.RequestError as exc:
        upstream_error_handler.raise_request_error(
            logger,
            exc,
            event="user_agent_skills_list_unreachable",
            message="Agents service is unreachable listing user-agent skills",
            public_detail="Skill selection is temporarily unavailable. Please try again.",
            upstream_service="agents",
            operation="user_agent_skills_list",
        )

    payload = resp.json()
    if not isinstance(payload, list):
        logger.warning(
            "user_agent_skills_malformed",
            "Agents service returned non-list payload for user-agent skills",
        )
        return []
    skills = [str(item) for item in payload]
    await skills_cache.set_user_agent_skills(user_id, agent_id, skills)
    logger.info(
        "user_agent_skills_cache_miss",
        "Fetched per-(user, agent) skills upstream and cached",
        user_id=user_id,
        agent_id=agent_id,
        count=len(skills),
    )
    return skills


async def _proxy_skill_mutation(
    *,
    method: str,
    user_id: str,
    agent_id: str,
    skill_name: str,
    event_prefix: str,
) -> None:
    """Shared PUT / DELETE proxy logic — both endpoints differ only in HTTP verb."""
    agent_slug = await _resolve_agent_slug(agent_id)
    url = _user_agent_skill_item_url(agent_slug, user_id, skill_name)
    timeout = httpx.Timeout(connect=10.0, read=15.0, write=10.0, pool=10.0)
    request_id = get_context().get("request_id")
    upstream_headers = internal_service_headers(request_id)

    try:
        async with httpx.AsyncClient(timeout=timeout, verify=get_httpx_verify()) as client:
            resp = await upstream_error_handler.run_with_retries(
                logger,
                lambda: client.request(method, url, headers=upstream_headers),
                upstream_service="agents",
                operation=event_prefix,
            )
            if resp.status_code == status.HTTP_404_NOT_FOUND:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="Skill not found in the central registry.",
                )
            resp.raise_for_status()
    except HTTPException:
        raise
    except httpx.HTTPStatusError as exc:
        upstream_error_handler.raise_http_error(
            logger,
            exc,
            event=f"{event_prefix}_failed",
            message=f"Agents service returned an HTTP error for {event_prefix}",
            public_detail="Skill selection update failed. Please try again.",
            upstream_service="agents",
            operation=event_prefix,
        )
    except httpx.RequestError as exc:
        upstream_error_handler.raise_request_error(
            logger,
            exc,
            event=f"{event_prefix}_unreachable",
            message=f"Agents service is unreachable for {event_prefix}",
            public_detail="Skill selection update failed. Please try again.",
            upstream_service="agents",
            operation=event_prefix,
        )

    # Authoritative filesystem state just changed — drop the cached selection
    # set so the next GET re-fetches from the agents service. Set semantics
    # are simpler and safer than trying to patch the cached list in place.
    await skills_cache.invalidate_user_agent_skills(user_id, agent_id)
    logger.info(
        f"{event_prefix}_completed",
        "User-agent skill mutation completed and cache invalidated",
        user_id=user_id,
        agent_id=agent_id,
        skill_name=skill_name,
    )


async def enable_user_agent_skill(*, user_id: str, agent_id: str, skill_name: str) -> None:
    """Enable a skill for a (user, agent) pair on the agents service."""
    await _proxy_skill_mutation(
        method="PUT",
        user_id=user_id,
        agent_id=agent_id,
        skill_name=skill_name,
        event_prefix="user_agent_skill_enable",
    )


async def disable_user_agent_skill(*, user_id: str, agent_id: str, skill_name: str) -> None:
    """Disable a skill for a (user, agent) pair on the agents service."""
    await _proxy_skill_mutation(
        method="DELETE",
        user_id=user_id,
        agent_id=agent_id,
        skill_name=skill_name,
        event_prefix="user_agent_skill_disable",
    )
