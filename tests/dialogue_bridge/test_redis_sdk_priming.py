"""How the fastapi-redis-sdk settings singleton is primed.

This is the only injection point the SDK exposes — it reads an ``lru_cache``-d,
env-driven settings object — so getting the priming wrong misconfigures every
Redis call the SDK makes, and does so **silently**.

That is not hypothetical. Production ran with a ``rediss://`` URL and a CA that
was never applied: TLS was still negotiated, the server certificate was verified
against the *system* trust store (which does not hold the internal CA), every
connection failed ``CERTIFICATE_VERIFY_FAILED``, and because the stance is
fail-open the API kept serving with rate limiting quietly absent. Nothing in the
local stack could catch it — local Redis is plaintext, so the whole branch is
skipped.

The trap underneath: the SDK drops ``ssl_ca_certs`` unless ``ssl`` is true, but
passing ``ssl=True`` *with a URL* makes redis-py raise ``TypeError: unexpected
keyword argument 'ssl'``. There is no URL-mode combination that both verifies
and starts, which is why priming is host/port only.
"""
from __future__ import annotations

import os

import pytest
from redis_fastapi import get_settings

from core.cache.integration import _prime_sdk_settings
from core.settings import settings


@pytest.fixture
def primed(monkeypatch):
    """Prime the SDK against a chosen Redis URL, then restore the singleton."""

    def _prime(url: str, ca: str | None = "/app/tls/ca.crt", password: str = "s3cret"):
        monkeypatch.setattr(settings.redis, "url", url)
        monkeypatch.setattr(settings.tls, "ca_cert_path", ca)
        monkeypatch.setattr(
            settings.redis, "password", type(settings.redis.password)(password)
        )
        monkeypatch.setenv("REDIS_URL", url)
        _prime_sdk_settings()
        return get_settings()

    yield _prime
    get_settings.cache_clear()


# ---------------------------------------------------------------------------
# The load-bearing property
# ---------------------------------------------------------------------------
def test_the_sdk_is_never_primed_in_url_mode(primed):
    # `url` being set is what puts the SDK in URL mode, where the CA is
    # unusable. Host/port mode is the only shape that can both verify and start.
    s = primed("rediss://redis:6379/0")
    assert s.url is None
    assert (s.host, s.port, s.db) == ("redis", 6379, 0)


def test_a_tls_url_arms_verification_with_the_internal_ca(primed):
    s = primed("rediss://redis:6379/0", ca="/app/tls/ca.crt")
    assert s.ssl is True
    assert s.ssl_ca_certs == "/app/tls/ca.crt"
    assert s.ssl_check_hostname is True
    # The gate: without `ssl` true the SDK returns {} and the CA never reaches
    # the connection, which is exactly how this failed in production.
    assert s._tls_kwargs()["ssl_ca_certs"] == "/app/tls/ca.crt"


def test_a_plaintext_url_arms_no_tls_at_all(primed):
    # Local dev. Nothing to verify, so nothing must be configured — an `ssl=True`
    # here would fail to connect to a plaintext server.
    s = primed("redis://redis:6379/0", ca=None)
    assert s.ssl is False
    assert s.ssl_ca_certs is None
    assert s._tls_kwargs() == {}


# ---------------------------------------------------------------------------
# Credentials
# ---------------------------------------------------------------------------
def test_the_password_reaches_the_singleton(primed):
    # Host/port mode honours the separate password field. URL mode ignores it,
    # which is why the credentials used to be embedded in the URL instead.
    s = primed("rediss://redis:6379/0", password="s3cret")
    assert s.password is not None
    assert s.password.get_secret_value() == "s3cret"


def test_the_password_is_scrubbed_from_the_environment(primed):
    # It must live only inside the cached settings object — never in
    # /proc-visible env, and never inherited by a subprocess (the alembic run).
    primed("rediss://redis:6379/0", password="s3cret")
    assert "REDIS_PASSWORD" not in os.environ


def test_the_original_url_is_restored_after_priming(primed):
    # REDIS_URL is unset only for the duration of priming; anything else reading
    # the environment afterwards must see what the container was started with.
    primed("rediss://redis:6379/0")
    assert os.environ.get("REDIS_URL") == "rediss://redis:6379/0"


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "url, host, port, db",
    [
        ("rediss://redis:6379/0", "redis", 6379, 0),
        ("redis://localhost:6380/3", "localhost", 6380, 3),
        ("redis://redis:6379", "redis", 6379, 0),
    ],
)
def test_host_port_and_db_come_from_the_url(primed, url, host, port, db):
    s = primed(url, ca=None)
    assert (s.host, s.port, s.db) == (host, port, db)
