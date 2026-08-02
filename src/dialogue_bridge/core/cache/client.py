"""Single source of truth for the bridge's async Redis client construction.

Every raw-Redis consumer — the inference event log (``utils.event_log``), the
logout denylist (``core.auth.session``), the OIDC state store
(``core.auth.oidc``), and the skills cache backend (``core.cache.policies``) —
opens its pool through this factory so the connection configuration
(credentials, encoding, and especially TLS trust) can never drift: a prior
divergence left the skills cache without the internal CA, so it failed every
``rediss://`` handshake with CERTIFICATE_VERIFY_FAILED while the event log
connected fine.

The fastapi-redis-sdk integration (``core.cache.integration``) maintains its
own pool from the SAME settings — see that module for how the two stay in sync.
"""
from __future__ import annotations

from typing import Any

import redis.asyncio as aioredis

from core.settings import settings


def create_redis_client() -> aioredis.Redis:
    password = settings.redis.password.get_secret_value() or None
    connect_kwargs: dict[str, Any] = dict(
        password=password,
        encoding="utf-8",
        decode_responses=True,
    )
    # `rediss://` (prod) → verify the Redis server certificate against the
    # internal CA, the same trust root used for every other inter-service TLS
    # connection. Plain `redis://` (local dev) skips this and connects in plain
    # text.
    if settings.redis.url.startswith("rediss://"):
        connect_kwargs.update(
            ssl_ca_certs=settings.tls.ca_cert_path,
            ssl_cert_reqs="required",
            ssl_check_hostname=True,
        )
    return aioredis.from_url(settings.redis.url, **connect_kwargs)
