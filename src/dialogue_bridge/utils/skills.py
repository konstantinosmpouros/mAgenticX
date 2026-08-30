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
from core.logging import get_context, get_logger

from core.security.internal_trust import internal_service_headers
from core.settings import settings
from core.security.tls import get_httpx_client_cert, get_httpx_verify
from core.error_handling import upstream_error_handler

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import AgentTable

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

    No Redis: the cache existed to avoid a cross-service hop that no longer
    happens, and it was the reason a tool-created skill stayed invisible for up
    to two hours. Removing it deletes that bug rather than fixing it.

    No manual refresh either. Adoption re-runs by itself whenever what we hold
    is missing or incomplete (see ``pool_needs_adoption``), so the button that
    used to force it has nothing left to do.
    """
    if not await skill_store.pool_needs_adoption(db, user_id):
        return await skill_store.list_pool(db, user_id)

    manifest = await _fetch_user_pool_upstream(user_id)
    await skill_store.adopt_pool(db, user_id, manifest)
    # Adopt the per-agent assignments in the same pass. They used to be pulled
    # only when the user opened a given agent, which meant an agent nobody
    # opened never reached chat_db at all — so a volume loss took those
    # assignments with it. They are a handful of small rows; the first listing
    # is the natural place to complete the picture.
    await _adopt_all_agent_assignments(db, user_id)
    await db.commit()
    return await skill_store.list_pool(db, user_id)


async def _adopt_all_agent_assignments(db: AsyncSession, user_id: str) -> None:
    """Import every deep agent's assignment set for this user.

    Only deep agents have a skill model, so the others are skipped rather than
    queried. Each pair is guarded, so this is safe to re-run and costs nothing
    once the picture is complete.
    """
    rows = (
        await db.execute(
            select(AgentTable).where(
                AgentTable.is_active == True,  # noqa: E712
                AgentTable.type == "deep agent",
                or_(
                    AgentTable.owner_user_id.is_(None),
                    AgentTable.owner_user_id == user_id,
                ),
            )
        )
    ).scalars().all()

    for agent in rows:
        if not await skill_store.agent_has_no_assignments(db, user_id, agent.slug):
            continue
        try:
            names = await _fetch_user_agent_skills_upstream(
                user_id=user_id, agent_id=agent.id
            )
        except Exception:
            # One agent being unreadable must not abort the pool listing; the
            # pair is simply retried the next time the pool is adopted or the
            # agent's own view is opened.
            logger.warning(
                "user_agent_skills_adopt_failed",
                "Could not read an agent's skill assignments during adoption",
                user_id=user_id,
                agent_slug=agent.slug,
            )
            continue
        await skill_store.adopt_agent_skills(db, user_id, agent.slug, names)


async def _fetch_user_pool_upstream(user_id: str) -> List[Dict[str, Any]]:
    """The agents service's view of the pool — used only to adopt or refresh."""
    timeout = _default_timeout()
    request_id = get_context().get("request_id")
    upstream_headers = internal_service_headers(request_id)

    try:
        async with httpx.AsyncClient(timeout=timeout, verify=get_httpx_verify(), cert=get_httpx_client_cert()) as client:
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
    return payload


async def get_user_skill_detail(
    *, db: AsyncSession, user_id: str, skill_name: str
) -> Dict[str, Any]:
    """One pool skill with its content.

    A **custom** skill is served from ``chat_db`` — we own its files, so there
    is no reason to ask the agents service for them. A **global** entry still
    goes upstream: the catalogue owns that content and it is shared, so copying
    it per user would go stale the moment the catalogue changed.
    """
    stored = await skill_store.get_custom_skill(db, user_id, skill_name)
    if stored is not None and stored.get("files"):
        return stored

    try:
        detail = await _fetch_user_skill_detail_upstream(
            user_id=user_id, skill_name=skill_name
        )
    except HTTPException as exc:
        if exc.status_code == status.HTTP_404_NOT_FOUND and stored is not None:
            # We hold a skill the agents service does not. That means our row is
            # stale — the folder was removed without the removal reaching here
            # (a delete that predates this store, or one whose second write
            # failed). Drop it rather than leaving a pool entry that can only
            # ever 404: adoption heals the create direction, this heals delete.
            await skill_store.remove_from_pool(db, user_id, skill_name)
            await db.commit()
            logger.info(
                "user_skill_stale_entry_pruned",
                "Dropped a pool entry the agents service no longer has",
                user_id=user_id,
                skill_name=skill_name,
            )
        raise

    # Opening a skill is where its body is adopted. Bodies are the large part of
    # the payload and most are never read, so pulling every one during the pool
    # import would make the first Skills load pay for content nobody asked for.
    # This is the moment we know it is wanted — and the moment it becomes
    # recoverable if the volume is lost.
    if stored is not None and (detail.get("files") or []):
        await skill_store.store_custom_skill(
            db,
            user_id,
            name=skill_name,
            description=str(detail.get("description") or stored.get("description") or ""),
            category=detail.get("category") or stored.get("category"),
            origin=str(detail.get("origin") or stored.get("origin") or "user"),
            created_by_agent=detail.get("createdByAgent") or stored.get("createdByAgent"),
            files=detail.get("files") or [],
        )
        await db.commit()
        logger.info(
            "user_skill_content_adopted",
            "Adopted a custom skill's content into chat_db on first open",
            user_id=user_id,
            skill_name=skill_name,
            file_count=len(detail.get("files") or []),
        )
    return detail


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
    type=custom), and every per-(user, agent) assignment folder. We mirror
    the cascade in the bridge cache: pool invalidate + every per-agent key
    for this user.
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

    await skill_store.remove_from_pool(db, user_id, skill_name)
    await db.commit()


# ---------------------------------------------------------------------------
# Per-(user, agent) skill selection
# ---------------------------------------------------------------------------
async def get_user_agent_skills(
    *, db: AsyncSession, user_id: str, agent_id: str
) -> List[str]:
    """The skills assigned to this (user, agent), from ``chat_db``.

    Adopts a pre-existing assignment set from the volume the first time we see
    the pair, for the same reason the pool does: users have assignments that
    pre-date this store and a boot pass would have to be remembered.
    """
    agent_slug = await _resolve_agent_slug(agent_id)
    if not await skill_store.agent_has_no_assignments(db, user_id, agent_slug):
        return await skill_store.list_agent_skills(db, user_id, agent_slug)

    names = await _fetch_user_agent_skills_upstream(user_id=user_id, agent_id=agent_id)
    await skill_store.adopt_agent_skills(db, user_id, agent_slug, names)
    await db.commit()
    return await skill_store.list_agent_skills(db, user_id, agent_slug)


async def _fetch_user_agent_skills_upstream(*, user_id: str, agent_id: str) -> List[str]:
    """The agents service's view of the pair — used only to adopt."""
    agent_slug = await _resolve_agent_slug(agent_id)
    timeout = _default_timeout()
    request_id = get_context().get("request_id")
    upstream_headers = internal_service_headers(request_id)

    try:
        async with httpx.AsyncClient(timeout=timeout, verify=get_httpx_verify(), cert=get_httpx_client_cert()) as client:
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
    logger.info(
        "user_agent_skills_fetched_upstream",
        "Fetched per-(user, agent) skills from the agents service for adoption",
        user_id=user_id,
        agent_id=agent_id,
        count=len(skills),
    )
    return skills


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
