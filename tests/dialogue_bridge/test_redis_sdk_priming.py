"""How the bridge supplies the fastapi-redis-sdk with a working Redis pool.

The SDK reads an ``lru_cache``-d, env-driven settings object and builds its own
``ConnectionPool`` from it. That pool cannot be configured correctly through the
environment, so the bridge replaces the builder — and these tests pin the two
failures that replacement exists to prevent. Both reached production.

1. ``ssl`` false → ``ssl_ca_certs`` is dropped, the handshake verifies against
   the *system* trust store (which does not hold the internal CA), and every
   connection fails ``CERTIFICATE_VERIFY_FAILED``. Silent: the API keeps serving
   because rate limiting is fail-open, so nothing surfaces but log noise.
2. ``ssl`` true → the SDK emits a bare ``ssl: True`` kwarg. redis-py accepts
   ``ssl=`` only on ``Redis(...)``, which pops it to pick a connection class;
   a ``ConnectionPool`` rejects it with ``TypeError: AbstractConnection.
   __init__() got an unexpected keyword argument 'ssl'``. In URL *and* host/port
   mode alike — there is no third combination.

Nothing in the local stack can catch either one: local Redis is plaintext, so
the whole TLS branch is skipped. That is why these assert against a constructed
connection object rather than a live server — ``make_connection()`` is the exact
call that raised in production, and it needs nothing running.
"""
from __future__ import annotations

import os
import ssl

import pytest
from redis.asyncio import ConnectionPool
from redis.asyncio.connection import Connection, SSLConnection
from redis_fastapi import get_settings

from core.cache.client import redis_tls_kwargs
from core.cache.integration import _build_sdk_pool, _prime_sdk_settings
from core.settings import settings

CA_PATH = "/app/tls/ca.crt"


@pytest.fixture
def pool(monkeypatch):
    """Prime the SDK against a chosen Redis URL and build the bridge's pool."""

    def _build(url: str, ca: str | None = CA_PATH, password: str = "s3cret") -> ConnectionPool:
        monkeypatch.setattr(settings.redis, "url", url)
        monkeypatch.setattr(settings.tls, "ca_cert_path", ca)
        monkeypatch.setattr(
            settings.redis, "password", type(settings.redis.password)(password)
        )
        _prime_sdk_settings()
        return _build_sdk_pool()

    yield _build
    get_settings.cache_clear()


# ---------------------------------------------------------------------------
# The regression that shipped: the pool could not build a connection at all
# ---------------------------------------------------------------------------
def test_a_tls_pool_can_construct_a_connection(pool):
    # This is the exact call that raised TypeError in production. It runs
    # entirely offline, so a plaintext-only local stack cannot hide it.
    connection = pool("rediss://redis:6379/0").make_connection()
    assert isinstance(connection, SSLConnection)


def test_no_bare_ssl_kwarg_ever_reaches_the_pool(pool):
    # `ssl` is legal on Redis(...) and nowhere else. Its presence is the defect.
    assert "ssl" not in pool("rediss://redis:6379/0").connection_kwargs
    assert "ssl" not in redis_tls_kwargs()


# ---------------------------------------------------------------------------
# The silent failure before it: TLS negotiated, but against the wrong trust root
# ---------------------------------------------------------------------------
def test_the_internal_ca_reaches_the_connection(pool):
    context = pool("rediss://redis:6379/0", ca=CA_PATH).make_connection().ssl_context
    assert context.ca_certs == CA_PATH
    assert context.cert_reqs == ssl.CERT_REQUIRED
    assert context.check_hostname is True


def test_a_plaintext_url_arms_no_tls_at_all(pool):
    # Local dev. Nothing to verify, so nothing must be configured — TLS kwargs
    # here would fail against a plaintext server.
    plain = pool("redis://redis:6379/0", ca=None)
    assert plain.connection_class is Connection
    assert not [key for key in plain.connection_kwargs if key.startswith("ssl")]


# ---------------------------------------------------------------------------
# Credentials
# ---------------------------------------------------------------------------
def test_the_password_reaches_the_pool(pool):
    # The URL carries no credentials — the password is a file-backed Swarm
    # secret resolved by core.settings and passed as an explicit kwarg.
    assert pool("rediss://redis:6379/0", password="s3cret").connection_kwargs[
        "password"
    ] == "s3cret"


def test_the_sdk_settings_never_hold_the_password(pool):
    # The SDK builds no connection of its own, so it is never handed a
    # credential it has no use for.
    pool("rediss://redis:6379/0", password="s3cret")
    assert get_settings().password is None


def test_priming_leaves_the_environment_as_it_found_it(monkeypatch, pool):
    monkeypatch.setenv("REDIS_PASSWORD", "from-env")
    pool("rediss://redis:6379/0")
    assert os.environ["REDIS_PASSWORD"] == "from-env"


# ---------------------------------------------------------------------------
# Behaviour knobs the SDK does still own
# ---------------------------------------------------------------------------
def test_the_sdk_is_primed_fail_open(pool):
    # A Redis outage must never take the API down.
    pool("rediss://redis:6379/0")
    assert get_settings().rate_limit_fail_closed is False
