"""Bridge-side skills surface — local reads, proxied writes.

Two different things live behind one module, and the split is the point:

* The **global catalogue** is genuinely remote. The agents service owns it (the
  ``skills_registry/`` directory in its image), so it is fetched over HTTP and
  read-through cached in Redis with a TTL.
* The **user's pool, its content and its per-agent assignments** are owned by
  the agents service too, in ``agent_runtime``. They used to be mirrored into
  ``chat_db`` and kept in step by a 900-second reconciliation pass; that copy
  and that pass are both gone.

So every function here is a proxy, and none of them touches a database. That is
the whole point of the change: with one copy of a skill there is nothing to keep
in step, and the failure mode it removes — the two stores disagreeing about what
a user has — cannot occur.

The trade is that these reads now fail when the agents service is down, where
they used to serve a stale local row. Deliberate: a stale answer about which
skills an agent is running with is worse than no answer.
"""
from __future__ import annotations

from typing import Any, Dict, List

import httpx
from fastapi import HTTPException, status
from core.logging import get_context, get_logger

from core.security.internal_trust import internal_service_headers
from core.settings import settings
from core.security.tls import get_httpx_client_cert, get_httpx_verify
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
        async with httpx.AsyncClient(timeout=timeout, verify=get_httpx_verify(), cert=get_httpx_client_cert()) as client:
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
async def list_user_skills(*, user_id: str) -> List[Dict[str, Any]]:
    """Return the user's pool from the service that owns it.

    Deliberately uncached. The Redis layer existed to avoid a cross-service hop
    for content the bridge also stored; now the hop *is* the read, and caching it
    would reintroduce the bug the cache used to cause — a skill created by the
    ``create_skill`` tool staying invisible in the Skills tab for up to two
    hours.
    """
    return await _fetch_user_pool_upstream(user_id=user_id)


async def get_user_skill_detail(
    *, user_id: str, skill_name: str
) -> Dict[str, Any]:
    """One pool skill with its content, from the service that owns it.

    There used to be a ``chat_db`` branch for custom skills, because the bridge
    kept its own copy of their files. Skills now live in ``agent_runtime`` — the
    agents service is both the writer and the consumer — so a second copy here
    would only be a thing to keep in step, which is the cost this change removes.
    """
    return await _fetch_user_skill_detail_upstream(
        user_id=user_id, skill_name=skill_name
    )


async def _fetch_user_pool_upstream(*, user_id: str) -> List[Dict[str, Any]]:
    """This user's pool, read from the agents service.

    The same direction the Memories tab already reads in: whoever owns the data
    owns the database, and the other side asks over the internal hop.
    """
    timeout = _default_timeout()
    upstream_headers = internal_service_headers(get_context().get("request_id"))
    url = _user_pool_url(user_id)

    try:
        async with httpx.AsyncClient(
            timeout=timeout, verify=get_httpx_verify(), cert=get_httpx_client_cert()
        ) as client:
            resp = await upstream_error_handler.run_with_retries(
                logger,
                lambda: client.get(url, headers=upstream_headers),
                upstream_service="agents",
                operation="user_skills_list",
            )
            resp.raise_for_status()
    except httpx.HTTPStatusError as exc:
        upstream_error_handler.raise_http_error(
            logger,
            exc,
            event="user_skills_list_failed",
            message="Agents service returned an HTTP error listing the skill pool",
            public_detail="Could not load your skills. Please try again.",
            upstream_service="agents",
            operation="user_skills_list",
        )
    except httpx.RequestError as exc:
        upstream_error_handler.raise_request_error(
            logger,
            exc,
            event="user_skills_list_unreachable",
            message="Agents service unreachable while listing the skill pool",
            public_detail="Could not load your skills. Please try again.",
            upstream_service="agents",
            operation="user_skills_list",
        )

    payload = resp.json()
    return payload if isinstance(payload, list) else []


async def _fetch_user_skill_detail_upstream(
    *, user_id: str, skill_name: str
) -> Dict[str, Any]:
    """The agents service's copy — the catalogue's content, or a not-yet-adopted skill."""
    timeout = _default_timeout()
    request_id = get_context().get("request_id")
    upstream_headers = internal_service_headers(request_id)
    url = _user_pool_item_url(user_id, skill_name)

    try:
        async with httpx.AsyncClient(timeout=timeout, verify=get_httpx_verify(), cert=get_httpx_client_cert()) as client:
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


async def add_global_skill_to_user_pool(
    *, user_id: str, skill_name: str
) -> None:
    """Append a global-skill reference to the user's pool.

    409 if already in pool; 404 if not in global. Invalidates the user's
    pool cache so the next GET reflects the new state.
    """
    timeout = _default_timeout()
    request_id = get_context().get("request_id")
    upstream_headers = internal_service_headers(request_id)
    url = _user_pool_global_add_url(user_id, skill_name)

    try:
        async with httpx.AsyncClient(timeout=timeout, verify=get_httpx_verify(), cert=get_httpx_client_cert()) as client:
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



async def create_custom_skill_in_pool(
    *, user_id: str, payload: Dict[str, Any]
) -> Dict[str, Any]:
    """Create a user-owned custom skill in the pool. Returns the new manifest entry."""
    timeout = _default_timeout()
    request_id = get_context().get("request_id")
    upstream_headers = internal_service_headers(request_id)
    url = _user_pool_custom_create_url(user_id)

    try:
        async with httpx.AsyncClient(timeout=timeout, verify=get_httpx_verify(), cert=get_httpx_client_cert()) as client:
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
            if resp.status_code in (
                status.HTTP_400_BAD_REQUEST,
                status.HTTP_422_UNPROCESSABLE_ENTITY,
            ):
                # Structural validation failure upstream — forward the specific
                # reason (bad path / oversized file / disallowed type / etc.) so
                # the UI can show it instead of a generic error.
                detail = "The skill could not be created — check the files and try again."
                try:
                    body = resp.json()
                    if isinstance(body, dict) and isinstance(body.get("detail"), str):
                        detail = body["detail"]
                except ValueError:
                    pass
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail=detail,
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

    body = resp.json()
    if not isinstance(body, dict):
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Agents service returned a malformed create-skill payload.",
        )

    return body


async def remove_skill_from_user_pool(
    *, user_id: str, skill_name: str
) -> None:
    """Remove a skill from the user's pool, cascading via the agents service.

    The agents service deletes the manifest entry, the custom folder (if
    type=custom), and every per-(user, agent) assignment folder.

    Order is tombstone → upstream → reap. The old order called upstream first
    and deleted the rows after, so a failure in between left a **live** pool
    entry for a skill the volume no longer had — a state indistinguishable from
    "the volume lost this skill", which a reconciliation pass would answer by
    writing it back. Marking first also means the removal takes effect for the
    user immediately, whether or not the agents service is reachable.
    """
    timeout = _default_timeout()
    request_id = get_context().get("request_id")
    upstream_headers = internal_service_headers(request_id)
    url = _user_pool_item_url(user_id, skill_name)

    try:
        async with httpx.AsyncClient(timeout=timeout, verify=get_httpx_verify(), cert=get_httpx_client_cert()) as client:
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



# ---------------------------------------------------------------------------
# Per-(user, agent) skill selection
# ---------------------------------------------------------------------------
async def get_user_agent_skills(
    *, user_id: str, agent_id: str
) -> List[str]:
    """The skills assigned to this (user, agent), from the service that owns them.

    Takes an ``agent_id`` and resolves it to a slug, because the browser knows
    agents by id while the agents service addresses them by slug — the one piece
    of translation this proxy still does.
    """
    agent_slug = await _resolve_agent_slug(agent_id)
    timeout = _default_timeout()
    upstream_headers = internal_service_headers(get_context().get("request_id"))
    url = _user_agent_skills_url(agent_slug, user_id)

    try:
        async with httpx.AsyncClient(
            timeout=timeout, verify=get_httpx_verify(), cert=get_httpx_client_cert()
        ) as client:
            resp = await upstream_error_handler.run_with_retries(
                logger,
                lambda: client.get(url, headers=upstream_headers),
                upstream_service="agents",
                operation="user_agent_skills_list",
            )
            resp.raise_for_status()
    except httpx.HTTPStatusError as exc:
        upstream_error_handler.raise_http_error(
            logger,
            exc,
            event="user_agent_skills_list_failed",
            message="Agents service returned an HTTP error listing agent skills",
            public_detail="Could not load this agent's skills. Please try again.",
            upstream_service="agents",
            operation="user_agent_skills_list",
        )
    except httpx.RequestError as exc:
        upstream_error_handler.raise_request_error(
            logger,
            exc,
            event="user_agent_skills_list_unreachable",
            message="Agents service unreachable while listing agent skills",
            public_detail="Could not load this agent's skills. Please try again.",
            upstream_service="agents",
            operation="user_agent_skills_list",
        )

    payload = resp.json()
    return payload if isinstance(payload, list) else []


async def _proxy_skill_mutation(
    *,
    method: str,
    user_id: str,
    agent_id: str,
    skill_name: str,
    event_prefix: str,
    enabled: bool,
) -> None:
    """Shared PUT / DELETE proxy logic — both endpoints differ only in HTTP verb."""
    agent_slug = await _resolve_agent_slug(agent_id)
    url = _user_agent_skill_item_url(agent_slug, user_id, skill_name)
    timeout = _default_timeout()
    request_id = get_context().get("request_id")
    upstream_headers = internal_service_headers(request_id)

    try:
        async with httpx.AsyncClient(timeout=timeout, verify=get_httpx_verify(), cert=get_httpx_client_cert()) as client:
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

    logger.info(
        f"{event_prefix}_completed",
        "User-agent skill mutation completed and persisted",
        user_id=user_id,
        agent_id=agent_id,
        skill_name=skill_name,
    )


async def enable_user_agent_skill(
    *, user_id: str, agent_id: str, skill_name: str
) -> None:
    """Enable a skill for a (user, agent) pair."""
    await _proxy_skill_mutation(
        method="PUT",
        user_id=user_id,
        agent_id=agent_id,
        skill_name=skill_name,
        event_prefix="user_agent_skill_enable",
        enabled=True,
    )


async def disable_user_agent_skill(
    *, user_id: str, agent_id: str, skill_name: str
) -> None:
    """Disable a skill for a (user, agent) pair."""
    await _proxy_skill_mutation(
        method="DELETE",
        user_id=user_id,
        agent_id=agent_id,
        skill_name=skill_name,
        event_prefix="user_agent_skill_disable",
        enabled=False,
    )
