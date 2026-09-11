"""fastapi-redis-sdk installation for the bridge.

One entry point — :func:`install_redis_sdk` — wires the SDK's connection-pool
lifespan, the Redis-backed rate limiting (global per-identity budget +
per-route ``rate_limit`` dependencies from ``core.security.rate_limit``), and
the DI caching layer onto the app.

Configuration handling is deliberate, and splits in two.

**The connection pool is ours, not the SDK's.** ``_build_sdk_pool`` replaces
``_PoolState.build_async_pool`` before the lifespan runs. That is not a
preference — the SDK's env-driven settings *cannot* express a working TLS pool.
Its ``_tls_kwargs()`` drops ``ssl_ca_certs`` unless ``ssl`` is true, and then
emits a bare ``ssl: True`` alongside it; but redis-py accepts ``ssl=`` only on
``Redis(...)``, never on the ``ConnectionPool`` the SDK actually builds. So
every combination the environment can produce fails, in one of two ways:

* CA supplied, ``ssl`` true  → ``TypeError: AbstractConnection.__init__() got
  an unexpected keyword argument 'ssl'`` — in URL *and* host/port mode alike.
* ``ssl`` false (or unset)   → the CA is silently dropped, the handshake is
  verified against the *system* trust store, and every connection fails
  ``CERTIFICATE_VERIFY_FAILED``.

Both were shipped to production in turn. The second is the dangerous one: it
fails quietly, because ``rediss://`` still connects and TLS is still negotiated
— and with the fail-open stance below, rate limiting is simply absent while the
API keeps serving. Owning the pool removes the whole class of problem: the
trust shape comes from :func:`core.cache.client.redis_tls_kwargs`, the single
definition this service has, already proven on the raw-Redis consumers.

**The SDK's own settings are primed only with behaviour knobs** — key prefix
and the two rate-limit flags. It is deliberately never told the Redis
credentials: it has no connection left to make with them, so the password stays
out of the SDK's settings object and out of ``/proc``-visible env (and out of
subprocesses like the alembic migration run).

Failure stance: fail-open (``rate_limit_fail_closed`` False). A Redis outage
must never take the API down — the same availability-first stance as the
logout denylist. Degraded operation is logged by the SDK and the request is
served.
"""
from __future__ import annotations

import os
from typing import Any

from fastapi import FastAPI
from redis.asyncio import ConnectionPool as AsyncConnectionPool
from redis_fastapi import FastAPIRedis, get_settings
from redis_fastapi.deps import _PoolState

from core.cache.client import redis_tls_kwargs
from core.settings import settings
from core.security.rate_limit import USER_BUDGET_RATE, exempt_from_budget, verified_identity
from core.logging import get_logger

logger = get_logger(__name__)

# Every key the SDK's cache/rate-limit layer writes lives under this prefix,
# namespaced away from the bridge's raw-Redis keys (event-log streams, the
# `denylist:` sids, `skills:` cache entries during migration overlap).
SDK_KEY_PREFIX = "mx:sdk"


def _build_sdk_pool() -> AsyncConnectionPool:
    """Build the pool the SDK runs on, with this service's TLS trust applied.

    Installed over ``_PoolState.build_async_pool`` so the SDK's own lifespan
    still owns the pool's life cycle — it is created before the rate-limit
    capability probe and closed on shutdown, exactly as the library intends.
    Only the *construction* is ours, because only construction is broken (see
    the module docstring).

    Connection details come from ``core.settings``, the same values every other
    Redis consumer in the bridge uses, rather than from the SDK's parallel view
    of the environment — a second opinion here is precisely what would drift.
    """
    sdk_settings = get_settings()
    kwargs: dict[str, Any] = {
        # `from_url` lets explicit kwargs stand when the URL omits them, and our
        # URL carries no credentials — the password is a file-backed Swarm
        # secret resolved by core.settings.
        "password": settings.redis.password.get_secret_value() or None,
        **redis_tls_kwargs(),
    }
    # Pass through the pool knobs the SDK would have applied itself, so
    # replacing the builder changes trust handling and nothing else.
    if sdk_settings.max_connections is not None:
        kwargs["max_connections"] = sdk_settings.max_connections
    if sdk_settings.socket_timeout is not None:
        kwargs["socket_timeout"] = sdk_settings.socket_timeout
    if sdk_settings.socket_connect_timeout is not None:
        kwargs["socket_connect_timeout"] = sdk_settings.socket_connect_timeout
    return AsyncConnectionPool.from_url(settings.redis.url, **kwargs)


def _prime_sdk_settings() -> None:
    """Seed and warm the SDK's env-driven settings singleton.

    Only behaviour knobs are written — the SDK builds no connection of its own,
    so it is never handed the Redis credentials. ``REDIS_PASSWORD`` is lifted
    out of the environment for the duration of the warm-up so the cached
    settings object cannot capture a secret it has no use for, then put back
    for any later reader.
    """
    os.environ.update(
        {
            "REDIS_PREFIX": SDK_KEY_PREFIX,
            # The global budget middleware must stay quiet on headers — only the
            # strict per-route limits advertise X-RateLimit-* (they pass
            # emit_headers=True explicitly), so clients never see two conflicting
            # limit families on one response.
            "REDIS_RATE_LIMIT_EMIT_HEADERS": "false",
            "REDIS_RATE_LIMIT_FAIL_CLOSED": "false",
        }
    )

    previous_password = os.environ.pop("REDIS_PASSWORD", None)
    try:
        get_settings.cache_clear()  # drop anything cached from an earlier import
        sdk_settings = get_settings()  # capture the primed env into the singleton
    finally:
        if previous_password is not None:
            os.environ["REDIS_PASSWORD"] = previous_password

    logger.info(
        "redis_sdk_settings_primed",
        "fastapi-redis-sdk settings initialized",
        # tls_verified is the signal that the CA actually landed: without it the
        # handshake falls back to the system trust store and fails closed.
        tls_verified=bool(redis_tls_kwargs().get("ssl_ca_certs")),
        prefix=sdk_settings.prefix,
        tls=settings.redis.url.startswith("rediss://"),
        fail_closed=sdk_settings.rate_limit_fail_closed,
    )


def install_redis_sdk(app: FastAPI) -> None:
    """Attach the SDK to the app: pool lifespan + rate limiting + caching.

    The builder *wraps* the app's existing lifespan (it does not replace it),
    so the bridge's own startup — alembic migration subprocess, scheduler,
    embedding sweeper — runs unchanged inside the SDK's pool context.

    The global budget replaces the old hand-rolled ``UserRateLimitMiddleware``
    with identical semantics: one aggregate Redis-counted budget per verified
    user (per-IP fallback), ``/health`` and ``/v1/internal/*`` exempt,
    fail-open. Strict per-route limits (auth, inference, speech) come from the
    ``rate_limit`` dependencies in ``core.security.rate_limit``.
    """
    _prime_sdk_settings()
    # Must land before the lifespan runs: it is the lifespan that calls this to
    # create the pool, and the rate-limit capability probe runs against it
    # immediately afterwards.
    _PoolState.build_async_pool = staticmethod(_build_sdk_pool)
    (
        FastAPIRedis(app)
        .lifespan()
        .rate_limiting(
            global_rate=USER_BUDGET_RATE,
            identifier=verified_identity,
            scope="budget",
            skip_when=exempt_from_budget,
        )
        .caching()
    )
