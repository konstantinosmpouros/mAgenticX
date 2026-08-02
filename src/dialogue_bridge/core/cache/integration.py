"""fastapi-redis-sdk installation for the bridge.

One entry point — :func:`install_redis_sdk` — wires the SDK's connection-pool
lifespan, the Redis-backed rate limiting (global per-identity budget +
per-route ``rate_limit`` dependencies from ``core.security.rate_limit``), and
the DI caching layer onto the app.

Configuration handling is deliberate: the SDK reads an env-driven,
``lru_cache``-d ``RedisSettings`` singleton, but our Redis password is a
file-backed Swarm secret the SDK cannot resolve, and the ``rediss://`` trust
root is the internal CA. So this module primes the SDK's env from the
already-resolved ``core.settings`` values, warms the settings singleton once,
then scrubs the sensitive variable back out of the process environment — the
secret ends up only inside the cached settings object (a ``SecretStr``), never
in ``/proc``-visible env or inherited by subprocesses (e.g. the alembic
migration run).

Failure stance: fail-open (``rate_limit_fail_closed`` False). A Redis outage
must never take the API down — the same availability-first stance as the
logout denylist. Degraded operation is logged by the SDK and the request is
served.
"""
from __future__ import annotations

import os
from urllib.parse import quote, urlsplit, urlunsplit

from fastapi import FastAPI
from redis_fastapi import FastAPIRedis, get_settings

from core.settings import settings
from core.security.rate_limit import USER_BUDGET_RATE, exempt_from_budget, verified_identity
from observability import get_logger

logger = get_logger(__name__)

# Every key the SDK's cache/rate-limit layer writes lives under this prefix,
# namespaced away from the bridge's raw-Redis keys (event-log streams, the
# `denylist:` sids, `skills:` cache entries during migration overlap).
SDK_KEY_PREFIX = "mx:sdk"


def _url_with_credentials(url: str, password: str) -> str:
    """Embed the AUTH password into the Redis URL.

    Required because the SDK's ``connection_kwargs()`` builds its pool with
    ``from_url(url)`` and applies its separate ``password`` field **only** in
    host/port mode — a URL-configured pool would silently connect
    unauthenticated. URLs that already carry credentials pass through
    untouched.
    """
    parts = urlsplit(url)
    if not password or parts.username or parts.password:
        return url
    host = parts.hostname or ""
    netloc = f":{quote(password, safe='')}@{host}"
    if parts.port:
        netloc += f":{parts.port}"
    return urlunsplit((parts.scheme, netloc, parts.path, parts.query, parts.fragment))


def _prime_sdk_settings() -> None:
    """Seed, warm, and scrub the SDK's env-driven settings singleton.

    Values are written to ``os.environ`` (the only injection point the SDK
    exposes), ``get_settings()`` is called once so the ``lru_cache`` captures
    them, and the credentialed URL is swapped back for the password-less
    original immediately — the cached settings object holds the only copy.
    """
    password = settings.redis.password.get_secret_value()
    env: dict[str, str] = {
        "REDIS_URL": _url_with_credentials(settings.redis.url, password),
        "REDIS_PREFIX": SDK_KEY_PREFIX,
        # The global budget middleware must stay quiet on headers — only the
        # strict per-route limits advertise X-RateLimit-* (they pass
        # emit_headers=True explicitly), so clients never see two conflicting
        # limit families on one response.
        "REDIS_RATE_LIMIT_EMIT_HEADERS": "false",
        "REDIS_RATE_LIMIT_FAIL_CLOSED": "false",
    }
    if settings.redis.url.startswith("rediss://"):
        # Same trust root as core.cache.client: verify the server against the
        # internal CA, hostname check on.
        env["REDIS_SSL_CA_CERTS"] = settings.tls.ca_cert_path
        env["REDIS_SSL_CHECK_HOSTNAME"] = "true"

    os.environ.update(env)
    try:
        get_settings.cache_clear()  # drop anything cached from an earlier import
        sdk_settings = get_settings()  # capture the primed env into the singleton
    finally:
        # Scrub the secret regardless — restore the password-less URL the
        # container was started with so nothing credentialed lingers in the
        # process env (or leaks into subprocesses like the alembic run).
        os.environ["REDIS_URL"] = settings.redis.url

    logger.info(
        "redis_sdk_settings_primed",
        "fastapi-redis-sdk settings initialized",
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
