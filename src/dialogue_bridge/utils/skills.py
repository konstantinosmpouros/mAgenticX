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
_AGENTS_GLOBAL_SKILLS_ENDPOINT = f"{_AGENTS_BASE_URL}/skills/global"


def _user_pool_url(user_id: str) -> str:
    return f"{_AGENTS_BASE_URL}/users/{user_id}/skills"


def _user_pool_item_url(user_id: str, skill_name: str) -> str:
    return f"{_user_pool_url(user_id)}/{skill_name}"


def _user_pool_global_add_url(user_id: str, skill_name: str) -> str:
    return f"{_user_pool_url(user_id)}/global/{skill_name}"


def _user_pool_custom_create_url(user_id: str) -> str:
    return f"{_user_pool_url(user_id)}/custom"


def _user_agent_skills_url(agent_slug: str, user_id: str) -> str:
    return f"{_AGENTS_BASE_URL}/agents/{agent_slug}/users/{user_id}/skills"


def _user_agent_skill_item_url(agent_slug: str, user_id: str, skill_name: str) -> str:
    return f"{_user_agent_skills_url(agent_slug, user_id)}/{skill_name}"


def _default_timeout() -> httpx.Timeout:
    return httpx.Timeout(connect=10.0, read=15.0, write=10.0, pool=10.0)


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
        cached = await skills_cache.get_global()
        if cached is not None:
            logger.info("skills_list_cache_hit", "Served global skills from Redis cache", count=len(cached))
            return cached

    timeout = _default_timeout()
    request_id = get_context().get("request_id")
    upstream_headers = internal_service_headers(request_id)
    # Forward bypass_cache so the agents service rebuilds its in-memory
    # manifest before responding (catches admin volume edits without an
    # agents-service restart).
    params = {"bypass_cache": "true"} if bypass_cache else None

    try:
        async with httpx.AsyncClient(timeout=timeout, verify=get_httpx_verify()) as client:
            resp = await upstream_error_handler.run_with_retries(
                logger,
                lambda: client.get(
                    _AGENTS_GLOBAL_SKILLS_ENDPOINT,
                    headers=upstream_headers,
                    params=params,
                ),
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
    await skills_cache.set_global(payload)
    if bypass_cache:
        logger.info("skills_list_bypass_refresh", "Bypassed Redis and re-upserted global catalog", count=len(payload))
    else:
        logger.info("skills_list_cache_miss", "Fetched global skills upstream and cached in Redis", count=len(payload))
    return payload


# ---------------------------------------------------------------------------
# Per-user skill pool
# ---------------------------------------------------------------------------
async def list_user_skills(*, user_id: str, bypass_cache: bool = False) -> List[Dict[str, Any]]:
    """Return the user's pool manifest, read-through cached in Redis.

    Cache contract mirrors :func:`list_skills` — bypass forces an upstream
    fetch AND re-upserts Redis.
    """
    if not bypass_cache:
        cached = await skills_cache.get_user_registry(user_id)
        if cached is not None:
            logger.info(
                "user_skills_cache_hit",
                "Served user pool from Redis cache",
                user_id=user_id,
                count=len(cached),
            )
            return cached

    timeout = _default_timeout()
    request_id = get_context().get("request_id")
    upstream_headers = internal_service_headers(request_id)

    try:
        async with httpx.AsyncClient(timeout=timeout, verify=get_httpx_verify()) as client:
            resp = await upstream_error_handler.run_with_retries(
                logger,
                lambda: client.get(_user_pool_url(user_id), headers=upstream_headers),
                upstream_service="agents",
                operation="user_skills_list",
            )
            resp.raise_for_status()
    except httpx.HTTPStatusError as exc:
        upstream_error_handler.raise_http_error(
            logger,
            exc,
            event="user_skills_list_failed",
            message="Agents service returned an HTTP error listing user pool",
            public_detail="Your skill pool is temporarily unavailable. Please try again.",
            upstream_service="agents",
            operation="user_skills_list",
        )
    except httpx.RequestError as exc:
        upstream_error_handler.raise_request_error(
            logger,
            exc,
            event="user_skills_list_unreachable",
            message="Agents service is unreachable listing user pool",
            public_detail="Your skill pool is temporarily unavailable. Please try again.",
            upstream_service="agents",
            operation="user_skills_list",
        )

    payload = resp.json()
    if not isinstance(payload, list):
        logger.warning("user_skills_list_malformed", "Agents service returned non-list payload")
        return []
    await skills_cache.set_user_registry(user_id, payload)
    return payload


async def get_user_skill_detail(*, user_id: str, skill_name: str) -> Dict[str, Any]:
    """Fetch one user-pool skill with its SKILL.md content. No caching."""
    timeout = _default_timeout()
    request_id = get_context().get("request_id")
    upstream_headers = internal_service_headers(request_id)
    url = _user_pool_item_url(user_id, skill_name)

    try:
        async with httpx.AsyncClient(timeout=timeout, verify=get_httpx_verify()) as client:
            resp = await upstream_error_handler.run_with_retries(
                logger,
                lambda: client.get(url, headers=upstream_headers),
                upstream_service="agents",
                operation="user_skill_detail",
            )
            if resp.status_code == status.HTTP_404_NOT_FOUND:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="Skill not in your pool.",
                )
            resp.raise_for_status()
    except HTTPException:
        raise
    except httpx.HTTPStatusError as exc:
        upstream_error_handler.raise_http_error(
            logger,
            exc,
            event="user_skill_detail_failed",
            message="Agents service returned an HTTP error fetching skill detail",
            public_detail="Could not load the skill. Please try again.",
            upstream_service="agents",
            operation="user_skill_detail",
        )
    except httpx.RequestError as exc:
        upstream_error_handler.raise_request_error(
            logger,
            exc,
            event="user_skill_detail_unreachable",
            message="Agents service is unreachable fetching skill detail",
            public_detail="Could not load the skill. Please try again.",
            upstream_service="agents",
            operation="user_skill_detail",
        )
    payload = resp.json()
    if not isinstance(payload, dict):
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Agents service returned a malformed skill detail payload.",
        )
    return payload


async def add_global_skill_to_user_pool(*, user_id: str, skill_name: str) -> None:
    """Append a global-skill reference to the user's pool.

    409 if already in pool; 404 if not in global. Invalidates the user's
    pool cache so the next GET reflects the new state.
    """
    timeout = _default_timeout()
    request_id = get_context().get("request_id")
    upstream_headers = internal_service_headers(request_id)
    url = _user_pool_global_add_url(user_id, skill_name)

    try:
        async with httpx.AsyncClient(timeout=timeout, verify=get_httpx_verify()) as client:
            resp = await upstream_error_handler.run_with_retries(
                logger,
                lambda: client.post(url, headers=upstream_headers),
                upstream_service="agents",
                operation="user_skill_add_global",
            )
            if resp.status_code == status.HTTP_404_NOT_FOUND:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="Skill not in the global catalog.",
                )
            if resp.status_code == status.HTTP_409_CONFLICT:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="Skill is already in your pool.",
                )
            resp.raise_for_status()
    except HTTPException:
        raise
    except httpx.HTTPStatusError as exc:
        upstream_error_handler.raise_http_error(
            logger,
            exc,
            event="user_skill_add_global_failed",
            message="Agents service returned an HTTP error adding global to pool",
            public_detail="Could not add the skill. Please try again.",
            upstream_service="agents",
            operation="user_skill_add_global",
        )
    except httpx.RequestError as exc:
        upstream_error_handler.raise_request_error(
            logger,
            exc,
            event="user_skill_add_global_unreachable",
            message="Agents service is unreachable adding global to pool",
            public_detail="Could not add the skill. Please try again.",
            upstream_service="agents",
            operation="user_skill_add_global",
        )

    await skills_cache.invalidate_user_registry(user_id)


async def create_custom_skill_in_pool(
    *, user_id: str, payload: Dict[str, Any]
) -> Dict[str, Any]:
    """Create a user-owned custom skill in the pool. Returns the new manifest entry."""
    timeout = _default_timeout()
    request_id = get_context().get("request_id")
    upstream_headers = internal_service_headers(request_id)
    url = _user_pool_custom_create_url(user_id)

    try:
        async with httpx.AsyncClient(timeout=timeout, verify=get_httpx_verify()) as client:
            resp = await upstream_error_handler.run_with_retries(
                logger,
                lambda: client.post(url, headers=upstream_headers, json=payload),
                upstream_service="agents",
                operation="user_skill_create_custom",
            )
            if resp.status_code == status.HTTP_409_CONFLICT:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="A skill with that name already exists in your pool or in the global catalog.",
                )
            resp.raise_for_status()
    except HTTPException:
        raise
    except httpx.HTTPStatusError as exc:
        upstream_error_handler.raise_http_error(
            logger,
            exc,
            event="user_skill_create_custom_failed",
            message="Agents service returned an HTTP error creating custom skill",
            public_detail="Could not create the skill. Please try again.",
            upstream_service="agents",
            operation="user_skill_create_custom",
        )
    except httpx.RequestError as exc:
        upstream_error_handler.raise_request_error(
            logger,
            exc,
            event="user_skill_create_custom_unreachable",
            message="Agents service is unreachable creating custom skill",
            public_detail="Could not create the skill. Please try again.",
            upstream_service="agents",
            operation="user_skill_create_custom",
        )

    await skills_cache.invalidate_user_registry(user_id)
    body = resp.json()
    if not isinstance(body, dict):
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Agents service returned a malformed create-skill payload.",
        )
    return body


async def remove_skill_from_user_pool(*, user_id: str, skill_name: str) -> None:
    """Remove a skill from the user's pool, cascading via the agents service.

    The agents service deletes the manifest entry, the custom folder (if
    type=custom), and every per-(user, agent) assignment folder. We mirror
    the cascade in the bridge cache: pool invalidate + every per-agent key
    for this user.
    """
    timeout = _default_timeout()
    request_id = get_context().get("request_id")
    upstream_headers = internal_service_headers(request_id)
    url = _user_pool_item_url(user_id, skill_name)

    try:
        async with httpx.AsyncClient(timeout=timeout, verify=get_httpx_verify()) as client:
            resp = await upstream_error_handler.run_with_retries(
                logger,
                lambda: client.delete(url, headers=upstream_headers),
                upstream_service="agents",
                operation="user_skill_remove",
            )
            resp.raise_for_status()
    except httpx.HTTPStatusError as exc:
        upstream_error_handler.raise_http_error(
            logger,
            exc,
            event="user_skill_remove_failed",
            message="Agents service returned an HTTP error removing skill from pool",
            public_detail="Could not remove the skill. Please try again.",
            upstream_service="agents",
            operation="user_skill_remove",
        )
    except httpx.RequestError as exc:
        upstream_error_handler.raise_request_error(
            logger,
            exc,
            event="user_skill_remove_unreachable",
            message="Agents service is unreachable removing skill from pool",
            public_detail="Could not remove the skill. Please try again.",
            upstream_service="agents",
            operation="user_skill_remove",
        )

    await skills_cache.invalidate_user_registry(user_id)
    await skills_cache.invalidate_all_user_agent_keys(user_id)


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
                    detail="Skill not in your pool — add it first from the global catalog or create a custom one.",
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
