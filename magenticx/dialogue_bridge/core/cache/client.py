"""Single source of truth for the bridge's async Redis client construction.

Every raw-Redis consumer — the inference event log (``utils.event_log``), the
logout denylist (``core.auth.session``) and the OIDC state store
(``core.auth.oidc``) — opens its pool through this factory so the connection
configuration (credentials, encoding, and especially TLS trust) can never
drift: a prior divergence left a cache client without the internal CA, so it
failed every ``rediss://`` handshake with CERTIFICATE_VERIFY_FAILED while the
event log connected fine.

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


#: Headroom over the XREAD BLOCK time before the socket read gives up.
STREAM_READ_TIMEOUT_MARGIN_SECONDS = 5.0


def stream_read_socket_timeout() -> float:
    """The socket timeout of the client that blocks on ``XREAD BLOCK``.

    redis-py (8.x) gives every client ``socket_timeout=5`` by default, and the
    event log blocks for ``REDIS_STREAM_READ_BLOCK_MS`` (30 s): every idle read
    then died with a timeout after 5 s and dropped the run's WebSocket
    (``ws_stream_failed`` every ~5 s). The reading socket has to outlast the
    block time, with a margin for the server's reply.
    """
    return settings.redis.read_block_ms / 1000 + STREAM_READ_TIMEOUT_MARGIN_SECONDS


def create_redis_client(*, socket_timeout: float | None = None) -> aioredis.Redis:
    """A client with the shared connection configuration.

    ``socket_timeout`` is left to redis-py's default (5 s) unless given: an
    ordinary command must fail fast rather than hang on a stuck server. Only a
    client dedicated to blocking reads passes a longer one (see
    :func:`stream_read_socket_timeout`); the connect timeout keeps its own
    default either way.
    """
    password = settings.redis.password.get_secret_value() or None
    connect_kwargs: dict[str, Any] = dict(
        password=password,
        encoding="utf-8",
        decode_responses=True,
        **redis_tls_kwargs(),
    )
    if socket_timeout is not None:
        connect_kwargs["socket_timeout"] = socket_timeout
    return aioredis.from_url(settings.redis.url, **connect_kwargs)
