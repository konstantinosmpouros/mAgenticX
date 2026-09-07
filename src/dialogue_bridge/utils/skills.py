"""Bridge-side skills surface — local reads, proxied writes.

Two different things live behind one module, and the split is the point:

* The **global catalogue** is genuinely remote. The agents service owns it (the
  ``skills_registry/`` directory in its image), so it is fetched over HTTP and
  read-through cached in Redis with a TTL.
* The **user's pool, its content and its per-agent assignments** are owned by
  ``chat_db``. Those reads are queries against :mod:`utils.skill_store`; nothing
  is cached, because there is no hop left to avoid.

Writes still go upstream first — that call is what validates, and it is what
puts the skill on the volume the runtime reads — and are persisted after.
Keeping the two stores in step is not this module's job: the reconciliation
exchange (:mod:`utils.workspace_sync`) owns it, and owns it in both directions.
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

from sqlalchemy.ext.asyncio import AsyncSession

from utils import skill_store
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
async def list_user_skills(*, db: AsyncSession, user_id: str) -> List[Dict[str, Any]]:
    """Return the user's pool from ``chat_db``.

    A plain query, and nothing else. No Redis — the cache existed to avoid a
    cross-service hop that no longer happens, and it was why a tool-created
    skill stayed invisible for up to two hours. No import-on-read either: the
    reconciliation pass owns that repair now, and it does the job properly,
    because it compares against the volume rather than guessing from an empty
    result. The old check could only fire when the pool was *entirely* empty, so
    anything added to a non-empty pool stayed invisible forever.
    """
    return await skill_store.list_pool(db, user_id)


async def get_user_skill_detail(
    *, db: AsyncSession, user_id: str, skill_name: str
) -> Dict[str, Any]:
    """One pool skill with its content.

    A **custom** skill is served from ``chat_db`` — we own its files, so there
    is no reason to ask the agents service for them. A **global** entry still
    goes upstream: the catalogue owns that content and it is shared, so copying
    it per user would go stale the moment the catalogue changed.

    Neither branch repairs anything any more. A custom skill we hold no files
    for, and a row whose folder is gone, are both states reconciliation resolves
    — and it resolves them in the right direction, which a read cannot: it can
    see whether the volume actually has the skill, so it knows whether to fetch
    the content or finish a deletion. Doing it here meant guessing from a 404.
    """
    stored = await skill_store.get_custom_skill(db, user_id, skill_name)
    if stored is not None and stored.get("files"):
        return stored
    return await _fetch_user_skill_detail_upstream(
        user_id=user_id, skill_name=skill_name
    )


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
    *, db: AsyncSession, user_id: str, skill_name: str
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

    await skill_store.add_to_pool(
        db, user_id, skill_name, pool_type=skill_store.POOL_TYPE_GLOBAL
    )
    await db.commit()


async def create_custom_skill_in_pool(
    *, db: AsyncSession, user_id: str, payload: Dict[str, Any]
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

    # Persist after the upstream call, which is what validates the skill. The
    # submitted files are the content: the agents service writes them to the
    # volume, and this is the copy that survives losing it.
    await skill_store.store_custom_skill(
        db,
        user_id,
        name=str(body.get("name") or payload.get("name") or "").strip(),
        description=str(body.get("description") or payload.get("description") or ""),
        category=body.get("category") or payload.get("category"),
        origin=str(body.get("origin") or "user"),
        created_by_agent=body.get("createdByAgent") or body.get("created_by_agent"),
        files=payload.get("files") or [],
    )
    await db.commit()
    return body


async def remove_skill_from_user_pool(
    *, db: AsyncSession, user_id: str, skill_name: str
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
    # False here means we hold no live entry — a pool that pre-dates this store,
    # or one whose adoption has not run yet. Proxy anyway: the agents service
    # owns the folder and is the one that has to delete it.
    await skill_store.tombstone_pool_entry(db, user_id, skill_name)
    await db.commit()

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

    # The volume no longer has it either, so the tombstone has nothing left to
    # protect — drop the row and its content for real.
    await skill_store.reap_pool_entry(db, user_id, skill_name)
    await db.commit()


# ---------------------------------------------------------------------------
# Per-(user, agent) skill selection
# ---------------------------------------------------------------------------
async def get_user_agent_skills(
    *, db: AsyncSession, user_id: str, agent_id: str
) -> List[str]:
    """The skills assigned to this (user, agent), from ``chat_db``.

    Assignments are imported by the reconciliation pass, which reads every
    agent's directory in one sweep. The read-triggered import this replaced
    only fired for a pair somebody happened to open, so an agent nobody opened
    never reached ``chat_db`` at all — and a volume loss took its assignments
    with it.
    """
    agent_slug = await _resolve_agent_slug(agent_id)
    return await skill_store.list_agent_skills(db, user_id, agent_slug)


async def _proxy_skill_mutation(
    *,
    method: str,
    db: AsyncSession,
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

    # Record the selection here too. The agents service still owns the folder
    # the runtime reads; this row is what survives losing that volume.
    await skill_store.set_agent_skill(
        db, user_id, await _resolve_agent_slug(agent_id), skill_name, enabled=enabled
    )
    await db.commit()
    logger.info(
        f"{event_prefix}_completed",
        "User-agent skill mutation completed and persisted",
        user_id=user_id,
        agent_id=agent_id,
        skill_name=skill_name,
    )


async def enable_user_agent_skill(
    *, db: AsyncSession, user_id: str, agent_id: str, skill_name: str
) -> None:
    """Enable a skill for a (user, agent) pair."""
    await _proxy_skill_mutation(
        method="PUT",
        db=db,
        user_id=user_id,
        agent_id=agent_id,
        skill_name=skill_name,
        event_prefix="user_agent_skill_enable",
        enabled=True,
    )


async def disable_user_agent_skill(
    *, db: AsyncSession, user_id: str, agent_id: str, skill_name: str
) -> None:
    """Disable a skill for a (user, agent) pair."""
    await _proxy_skill_mutation(
        method="DELETE",
        db=db,
        user_id=user_id,
        agent_id=agent_id,
        skill_name=skill_name,
        event_prefix="user_agent_skill_disable",
        enabled=False,
    )
