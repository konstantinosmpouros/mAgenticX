"""Bridge-side skills surface — local reads, proxied writes.

Two different things live behind one module, and the split is the point:

* The **catalogue** is the remote skill sources (plan 30), indexed by the agents
  service into ``agent_runtime``. The bridge forwards a search and an Add; only
  the agents service ever reaches a remote source.
* The **user's pool, its content and its per-agent assignments** are owned by
  the agents service too, in ``agent_runtime``. They used to be mirrored into
  ``chat_db`` and kept in step by a 900-second reconciliation pass; that copy
  and that pass are both gone.

Every function here is a proxy, and none of them touches a database. That is
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

logger = get_logger(__name__)

_AGENTS_BASE_URL = settings.upstream.agents_service_url.rstrip("/")
_AGENTS_CATALOGUE_SEARCH_ENDPOINT = f"{_AGENTS_BASE_URL}/skills/catalogue/search"


def _user_pool_url(user_id: str) -> str:
    return f"{_AGENTS_BASE_URL}/users/{user_id}/skills"


def _user_pool_item_url(user_id: str, skill_name: str) -> str:
    return f"{_user_pool_url(user_id)}/{skill_name}"


def _user_pool_custom_create_url(user_id: str) -> str:
    return f"{_user_pool_url(user_id)}/custom"


def _user_pool_remote_add_url(user_id: str, source_id: str, skill_id: str) -> str:
    return f"{_user_pool_url(user_id)}/remote/{source_id}/{skill_id}"


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


async def search_catalogue(
    *, query: str, source: str | None, limit: int, offset: int
) -> Dict[str, Any]:
    """One page of the catalogue search, from the service that owns the index.

    Deliberately uncached: a query costs about a millisecond upstream, and a
    cache keyed on free text would mostly hold one-off keystrokes.
    """
    params: Dict[str, Any] = {"q": query, "limit": limit, "offset": offset}
    if source:
        params["source"] = source
    upstream_headers = internal_service_headers(get_context().get("request_id"))

    try:
        async with httpx.AsyncClient(
            timeout=_default_timeout(), verify=get_httpx_verify(), cert=get_httpx_client_cert()
        ) as client:
            resp = await upstream_error_handler.run_with_retries(
                logger,
                lambda: client.get(
                    _AGENTS_CATALOGUE_SEARCH_ENDPOINT, headers=upstream_headers, params=params
                ),
                upstream_service="agents",
                operation="skill_catalogue_search",
            )
            resp.raise_for_status()
    except httpx.HTTPStatusError as exc:
        upstream_error_handler.raise_http_error(
            logger,
            exc,
            event="skill_catalogue_search_failed",
            message="Agents service returned an HTTP error searching the catalogue",
            public_detail="Skill search is temporarily unavailable. Please try again.",
            upstream_service="agents",
            operation="skill_catalogue_search",
        )
    except httpx.RequestError as exc:
        upstream_error_handler.raise_request_error(
            logger,
            exc,
            event="skill_catalogue_search_unreachable",
            message="Agents service is unreachable while searching the catalogue",
            public_detail="Skill search is temporarily unavailable. Please try again.",
            upstream_service="agents",
            operation="skill_catalogue_search",
        )

    payload = resp.json()
    if not isinstance(payload, dict):
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Agents service returned a malformed search payload.",
        )
    return payload


# The upstream statuses an Add can answer with, and what the user is told. The
# agents service already phrases 422 for a person; everything else is mapped
# here so an upstream message never reaches the UI unreviewed.
_REMOTE_ADD_ERRORS = {
    status.HTTP_404_NOT_FOUND: "That skill is no longer in the catalogue.",
    status.HTTP_409_CONFLICT: "You already have a skill with this name.",
    status.HTTP_502_BAD_GATEWAY: "The skill's source could not be reached. Please try again later.",
    status.HTTP_503_SERVICE_UNAVAILABLE: "Remote skills are not enabled on this server.",
}


async def add_remote_skill_to_user_pool(
    *, user_id: str, source_id: str, skill_id: str
) -> Dict[str, Any]:
    """Add a remote skill to the user's pool. Returns the new pool entry.

    One attempt, never retried: the Add may download and verify a whole skill
    upstream, so a retry after a slow first attempt would double the work and
    then answer 409 for a skill that had in fact been added.
    """
    upstream_headers = internal_service_headers(get_context().get("request_id"))
    url = _user_pool_remote_add_url(user_id, source_id, skill_id)

    try:
        async with httpx.AsyncClient(
            timeout=settings.http.skills_remote_add_timeout,
            verify=get_httpx_verify(),
            cert=get_httpx_client_cert(),
        ) as client:
            resp = await client.post(url, headers=upstream_headers)
            mapped = _REMOTE_ADD_ERRORS.get(resp.status_code)
            if mapped is not None:
                raise HTTPException(status_code=resp.status_code, detail=mapped)
            if resp.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY:
                detail = "This skill failed verification and was not added."
                try:
                    body = resp.json()
                    if isinstance(body, dict) and isinstance(body.get("detail"), str):
                        detail = body["detail"][:300]
                except ValueError:
                    pass
                raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=detail)
            resp.raise_for_status()
    except HTTPException:
        raise
    except httpx.HTTPStatusError as exc:
        upstream_error_handler.raise_http_error(
            logger,
            exc,
            event="user_skill_add_remote_failed",
            message="Agents service returned an HTTP error adding a remote skill",
            public_detail="Could not add the skill. Please try again.",
            upstream_service="agents",
            operation="user_skill_add_remote",
        )
    except httpx.RequestError as exc:
        upstream_error_handler.raise_request_error(
            logger,
            exc,
            event="user_skill_add_remote_unreachable",
            message="Agents service is unreachable adding a remote skill",
            public_detail="Could not add the skill. Please try again.",
            upstream_service="agents",
            operation="user_skill_add_remote",
        )

    body = resp.json()
    if not isinstance(body, dict):
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Agents service returned a malformed add-skill payload.",
        )
    logger.info(
        "user_skill_add_remote_completed",
        "Remote skill added to the user's pool",
        user_id=user_id,
        source_id=source_id,
        skill_name=skill_id,
    )
    return body


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
                    detail="A skill with that name already exists in your pool.",
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
                    detail="Skill not in your pool — add it from the catalogue or create a custom one first.",
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
