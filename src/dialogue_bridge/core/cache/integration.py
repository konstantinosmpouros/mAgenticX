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

**The SDK is primed in host/port mode, never with a URL, and that is load
bearing.** Its ``_tls_kwargs()`` drops ``ssl_ca_certs`` unless ``ssl`` is true,
but passing ``ssl=True`` alongside a ``rediss://`` URL raises
``TypeError: AbstractConnection.__init__() got an unexpected keyword argument
'ssl'`` — so with a URL there is no combination that both verifies the server
and starts. In host/port mode ``ssl=True`` is a valid kwarg, the CA is applied,
and the separate ``password`` field is honoured (in URL mode it is ignored,
which is why the credentials used to be embedded in the URL instead).

Getting this wrong fails quietly: ``rediss://`` still connects, TLS is still
negotiated, and the server certificate is verified against the *system* trust
store, which does not contain our internal CA. The connection then fails with
``CERTIFICATE_VERIFY_FAILED`` and, because the stance is fail-open, rate
limiting is simply absent while the API keeps serving.

Failure stance: fail-open (``rate_limit_fail_closed`` False). A Redis outage
must never take the API down — the same availability-first stance as the
logout denylist. Degraded operation is logged by the SDK and the request is
served.
"""
from __future__ import annotations

import os
from urllib.parse import urlsplit

from fastapi import FastAPI
from redis_fastapi import FastAPIRedis, get_settings

from core.settings import settings
from core.security.rate_limit import USER_BUDGET_RATE, exempt_from_budget, verified_identity
from core.logging import get_logger

logger = get_logger(__name__)

# Every key the SDK's cache/rate-limit layer writes lives under this prefix,
# namespaced away from the bridge's raw-Redis keys (event-log streams, the
# `denylist:` sids, `skills:` cache entries during migration overlap).
SDK_KEY_PREFIX = "mx:sdk"


def _prime_sdk_settings() -> None:
    """Seed, warm, and scrub the SDK's env-driven settings singleton.

    Values are written to ``os.environ`` (the only injection point the SDK
    exposes), ``get_settings()`` is called once so the ``lru_cache`` captures
    them, and the password is removed immediately — the cached settings object
    holds the only copy.

    ``REDIS_URL`` is *unset* for the duration: its mere presence puts the SDK in
    URL mode, where the CA is unusable (see the module docstring). It is put back
    afterwards so nothing else that reads the environment is surprised.
    """
    parts = urlsplit(settings.redis.url)
    password = settings.redis.password.get_secret_value()
    is_tls = parts.scheme == "rediss"

    env: dict[str, str] = {
        "REDIS_HOST": parts.hostname or "redis",
        "REDIS_PORT": str(parts.port or 6379),
        # urlsplit gives "/0"; an empty or unparseable path means db 0.
        "REDIS_DB": (parts.path or "/0").lstrip("/") or "0",
        "REDIS_PREFIX": SDK_KEY_PREFIX,
        # The global budget middleware must stay quiet on headers — only the
        # strict per-route limits advertise X-RateLimit-* (they pass
        # emit_headers=True explicitly), so clients never see two conflicting
        # limit families on one response.
        "REDIS_RATE_LIMIT_EMIT_HEADERS": "false",
        "REDIS_RATE_LIMIT_FAIL_CLOSED": "false",
    }
    if password:
        env["REDIS_PASSWORD"] = password
    # Every TLS field is written on every path, never left to whatever happens to
    # be in the ambient environment: a stale REDIS_SSL would otherwise make a
    # plaintext URL attempt TLS and fail to connect at all.
    env["REDIS_SSL"] = "true" if is_tls else "false"

    previous_url = os.environ.pop("REDIS_URL", None)
    if is_tls:
        # Same trust root as core.cache.client. `ssl` must be true for the SDK to
        # apply the CA at all, and is only a legal kwarg in this mode.
        env["REDIS_SSL_CA_CERTS"] = settings.tls.ca_cert_path or ""
        env["REDIS_SSL_CHECK_HOSTNAME"] = "true"
    else:
        for key in ("REDIS_SSL_CA_CERTS", "REDIS_SSL_CHECK_HOSTNAME"):
            os.environ.pop(key, None)
    os.environ.update(env)
    try:
        get_settings.cache_clear()  # drop anything cached from an earlier import
        sdk_settings = get_settings()  # capture the primed env into the singleton
    finally:
        # Scrub the secret regardless, and restore the URL the container was
        # started with so nothing credentialed lingers in the process env (or
        # leaks into subprocesses like the alembic run).
        os.environ.pop("REDIS_PASSWORD", None)
        if previous_url is not None:
            os.environ["REDIS_URL"] = previous_url

    logger.info(
        "redis_sdk_settings_primed",
        "fastapi-redis-sdk settings initialized",
        # tls_verified is the signal that the CA actually landed: a truthy
        # ssl_ca_certs is the difference between a verified connection and one
        # that fails closed against the system trust store.
        tls_verified=bool(sdk_settings.ssl and sdk_settings.ssl_ca_certs),
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
