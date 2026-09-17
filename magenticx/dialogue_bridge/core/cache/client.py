"""Single source of truth for the bridge's async Redis client construction.

Every raw-Redis consumer — the inference event log (``utils.event_log``), the
logout denylist (``core.auth.session``), the OIDC state store
(``core.auth.oidc``), and the skills cache backend (``core.cache.policies``) —
opens its pool through this factory so the connection configuration
(credentials, encoding, and especially TLS trust) can never drift: a prior
divergence left the skills cache without the internal CA, so it failed every
``rediss://`` handshake with CERTIFICATE_VERIFY_FAILED while the event log
connected fine.

The fastapi-redis-sdk integration (``core.cache.integration``) builds its own
pool, but through :func:`redis_tls_kwargs` below — so there is exactly one
definition of how this service trusts a Redis server.
"""
from __future__ import annotations

from typing import Any

import redis.asyncio as aioredis

from core.settings import settings


def redis_tls_kwargs() -> dict[str, Any]:
    """TLS kwargs for a ``rediss://`` URL; an empty dict for plain ``redis://``.

    `rediss://` (prod) verifies the Redis server certificate against the
    internal CA, the same trust root used for every other inter-service TLS
    connection. Plain `redis://` (local dev) connects in plain text.

    **There is deliberately no bare ``ssl`` key here.** redis-py accepts
    ``ssl=`` only on ``Redis(...)``, which pops it to choose a connection class;
    passing it to a ``ConnectionPool`` — directly or through ``from_url`` —
    raises ``TypeError: AbstractConnection.__init__() got an unexpected keyword
    argument 'ssl'``. Naming ``ssl_ca_certs`` is what both turns verification on
    and supplies the trust root, and it is the only shape that works in every
    constructor. Dropping the CA is not a lesser evil either: the handshake then
    verifies against the *system* trust store, which does not hold our CA, and
    every connection fails ``CERTIFICATE_VERIFY_FAILED``.
    """
    if not settings.redis.url.startswith("rediss://"):
        return {}
    return {
        "ssl_ca_certs": settings.tls.ca_cert_path,
        "ssl_cert_reqs": "required",
        "ssl_check_hostname": True,
    }


def create_redis_client() -> aioredis.Redis:
    password = settings.redis.password.get_secret_value() or None
    connect_kwargs: dict[str, Any] = dict(
        password=password,
        encoding="utf-8",
        decode_responses=True,
        **redis_tls_kwargs(),
    )
    return aioredis.from_url(settings.redis.url, **connect_kwargs)
