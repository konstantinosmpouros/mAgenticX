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
from observability import get_context, get_logger

from core.proxy import internal_service_headers
from core.settings import settings
from core.tls import get_httpx_verify
from core.error_handling import upstream_error_handler

from utils.skills_cache import skills_cache

logger = get_logger(__name__)

_AGENTS_SKILLS_ENDPOINT = f"{settings.upstream.agents_service_url.rstrip('/')}/skills"


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
