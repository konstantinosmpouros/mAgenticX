"""Unit tests for the Redis read-through skills cache.

These tests exercise :class:`utils.skills_cache.SkillsCache` — now a domain
wrapper over ``redis_fastapi.CacheBackend`` — against an in-process fakeredis
instance, covering all three key families (global, per-user registry,
per-(user, agent) selection set), their TTLs, the eviction-group cascade, and
the resilience contract that a Redis failure never raises into the request
path (the SDK backend fails open; every accessor degrades to ``None``/no-op).

The backend is injected by seeding ``core.cache.policies._backend`` — the
module-level singleton ``get_cache_backend`` hands out — so the wrapper under
test runs exactly the code path production uses.
"""

from __future__ import annotations

import json

import pytest_asyncio
from fakeredis import aioredis as fake_aioredis
from redis_fastapi import CacheBackend

import core.cache.policies as cache_policies
from core.cache.policies import (
    SKILLS_GLOBAL_KEY,
    skills_user_agent_group,
    skills_user_agent_key,
    skills_user_registry_key,
)
from core.settings import settings
from utils.skills_cache import SkillsCache


@pytest_asyncio.fixture
async def fake_redis():
    client = fake_aioredis.FakeRedis(decode_responses=True)
    try:
        yield client
    finally:
        await client.aclose()


@pytest_asyncio.fixture
async def backend(fake_redis):
    """A CacheBackend over fakeredis, installed as the shared singleton."""
    instance = CacheBackend(fake_redis)
    cache_policies._backend = instance
    try:
        yield instance
    finally:
        cache_policies._backend = None


@pytest_asyncio.fixture
async def cache(backend):
    return SkillsCache()


def _full_key(backend: CacheBackend, key: str, group: str | None = None) -> str:
    # Tests compute raw Redis keys through the same builder the backend uses
    # (prefix + optional {group} hash-tag), so TTL / foreign-write assertions
    # can't drift from the real key layout.
    return backend._build_key(key, group)


# ---------------------------------------------------------------------------
# key builders (policy registry)
# ---------------------------------------------------------------------------

def test_key_builders_are_namespaced():
    assert SKILLS_GLOBAL_KEY == "skills:global"
    assert skills_user_registry_key("u1") == "skills:user:u1:registry"
    assert skills_user_agent_key("u1", "a1") == "skills:user:u1:agent:a1"
    assert skills_user_agent_group("u1") == "skills:agents:u1"


# ---------------------------------------------------------------------------
# get_cache_backend lazy creation + memoisation
# ---------------------------------------------------------------------------

async def test_get_cache_backend_creates_lazily_and_memoises(monkeypatch, fake_redis):
    monkeypatch.setattr(cache_policies, "_backend", None)
    created: list[object] = []

    def fake_factory():
        created.append(fake_redis)
        return fake_redis

    monkeypatch.setattr(cache_policies, "create_redis_client", fake_factory)
    first = await cache_policies.get_cache_backend()
    second = await cache_policies.get_cache_backend()
    assert first is second
    # The client factory must be hit exactly once — the backend is shared.
    assert len(created) == 1
    monkeypatch.setattr(cache_policies, "_backend", None)


# ---------------------------------------------------------------------------
# global catalog
# ---------------------------------------------------------------------------

async def test_set_and_get_global_roundtrips(cache, backend, fake_redis):
    payload = [{"name": "skill-a"}, {"name": "skill-b"}]
    await cache.set_global(payload)
    assert await cache.get_global() == payload
    # TTL must be the settings-driven value, never persisted forever.
    ttl = await fake_redis.ttl(_full_key(backend, SKILLS_GLOBAL_KEY))
    assert 0 < ttl <= settings.redis.skills_global_ttl_seconds


async def test_set_global_honours_explicit_ttl(cache, backend, fake_redis):
    await cache.set_global([{"name": "x"}], ttl_seconds=42)
    ttl = await fake_redis.ttl(_full_key(backend, SKILLS_GLOBAL_KEY))
    assert 0 < ttl <= 42


async def test_get_global_miss_returns_none(cache):
    assert await cache.get_global() is None


async def test_get_global_malformed_json_returns_none(cache, backend, fake_redis):
    await fake_redis.set(_full_key(backend, SKILLS_GLOBAL_KEY), "{not-valid-json")
    assert await cache.get_global() is None


async def test_get_global_non_list_payload_returns_none(cache, backend, fake_redis):
    await fake_redis.set(_full_key(backend, SKILLS_GLOBAL_KEY), json.dumps({"oops": "dict-not-list"}))
    assert await cache.get_global() is None


async def test_invalidate_global_deletes_entry(cache, backend, fake_redis):
    await cache.set_global([{"name": "x"}])
    await cache.invalidate_global()
    assert await fake_redis.get(_full_key(backend, SKILLS_GLOBAL_KEY)) is None
    assert await cache.get_global() is None


# ---------------------------------------------------------------------------
# per-user registry
# ---------------------------------------------------------------------------

async def test_set_and_get_user_registry_roundtrips(cache, backend, fake_redis):
    payload = [{"skill": "alpha"}]
    await cache.set_user_registry("user-1", payload)
    assert await cache.get_user_registry("user-1") == payload
    ttl = await fake_redis.ttl(_full_key(backend, skills_user_registry_key("user-1")))
    assert 0 < ttl <= settings.redis.skills_user_registry_ttl_seconds


async def test_get_user_registry_miss_returns_none(cache):
    assert await cache.get_user_registry("nobody") is None


async def test_get_user_registry_malformed_json_returns_none(cache, backend, fake_redis):
    await fake_redis.set(_full_key(backend, skills_user_registry_key("user-1")), "[broken")
    assert await cache.get_user_registry("user-1") is None


async def test_get_user_registry_non_list_returns_none(cache, backend, fake_redis):
    await fake_redis.set(
        _full_key(backend, skills_user_registry_key("user-1")), json.dumps({"k": "v"})
    )
    assert await cache.get_user_registry("user-1") is None


async def test_invalidate_user_registry_deletes_entry(cache):
    await cache.set_user_registry("user-1", [{"skill": "alpha"}])
    await cache.invalidate_user_registry("user-1")
    assert await cache.get_user_registry("user-1") is None


# ---------------------------------------------------------------------------
# per-(user, agent) selection set
# ---------------------------------------------------------------------------

async def test_set_and_get_user_agent_skills_roundtrips(cache, backend, fake_redis):
    await cache.set_user_agent_skills("user-1", "agent-1", ["s1", "s2"])
    assert await cache.get_user_agent_skills("user-1", "agent-1") == ["s1", "s2"]
    full_key = _full_key(
        backend, skills_user_agent_key("user-1", "agent-1"), skills_user_agent_group("user-1")
    )
    ttl = await fake_redis.ttl(full_key)
    assert 0 < ttl <= settings.redis.skills_user_agent_ttl_seconds


async def test_get_user_agent_skills_coerces_items_to_str(cache, backend, fake_redis):
    # Stored payload may have been written with non-string members; the getter
    # normalises every element to str.
    full_key = _full_key(
        backend, skills_user_agent_key("user-1", "agent-1"), skills_user_agent_group("user-1")
    )
    await fake_redis.set(full_key, json.dumps([1, 2, "three"]))
    assert await cache.get_user_agent_skills("user-1", "agent-1") == ["1", "2", "three"]


async def test_get_user_agent_skills_miss_returns_none(cache):
    assert await cache.get_user_agent_skills("u", "a") is None


async def test_get_user_agent_skills_malformed_json_returns_none(cache, backend, fake_redis):
    full_key = _full_key(backend, skills_user_agent_key("u", "a"), skills_user_agent_group("u"))
    await fake_redis.set(full_key, "not json[")
    assert await cache.get_user_agent_skills("u", "a") is None


async def test_get_user_agent_skills_non_list_returns_none(cache, backend, fake_redis):
    full_key = _full_key(backend, skills_user_agent_key("u", "a"), skills_user_agent_group("u"))
    await fake_redis.set(full_key, json.dumps({"k": "v"}))
    assert await cache.get_user_agent_skills("u", "a") is None


async def test_invalidate_user_agent_skills_deletes_entry(cache):
    await cache.set_user_agent_skills("user-1", "agent-1", ["s1"])
    await cache.invalidate_user_agent_skills("user-1", "agent-1")
    assert await cache.get_user_agent_skills("user-1", "agent-1") is None


# ---------------------------------------------------------------------------
# cascade invalidation (eviction group)
# ---------------------------------------------------------------------------

async def test_invalidate_all_user_agent_keys_drops_only_that_users_agent_keys(cache):
    await cache.set_user_agent_skills("user-1", "agent-1", ["s1"])
    await cache.set_user_agent_skills("user-1", "agent-2", ["s2"])
    await cache.set_user_agent_skills("user-2", "agent-9", ["s9"])
    await cache.set_user_registry("user-1", [{"skill": "keep-me"}])

    await cache.invalidate_all_user_agent_keys("user-1")

    # Both of user-1's per-agent keys are gone (same eviction group).
    assert await cache.get_user_agent_skills("user-1", "agent-1") is None
    assert await cache.get_user_agent_skills("user-1", "agent-2") is None
    # Another user's per-agent key is untouched (different group).
    assert await cache.get_user_agent_skills("user-2", "agent-9") == ["s9"]
    # The registry key (no group) is untouched by the agent-key cascade.
    assert await cache.get_user_registry("user-1") == [{"skill": "keep-me"}]


async def test_invalidate_all_user_agent_keys_no_keys_is_noop(cache):
    # No matching keys → no exception, nothing deleted.
    await cache.invalidate_all_user_agent_keys("user-with-nothing")


# ---------------------------------------------------------------------------
# resilience — a Redis failure must never raise into the request path.
# ConnectionError is an OSError subclass, which the SDK backend catches and
# degrades to miss/no-op on every operation (including the eviction cascade).
# ---------------------------------------------------------------------------

class _BoomClient:
    async def get(self, *_a, **_k):
        raise ConnectionError("redis down")

    async def set(self, *_a, **_k):
        raise ConnectionError("redis down")

    async def delete(self, *_a, **_k):
        raise ConnectionError("redis down")

    async def eval(self, *_a, **_k):
        raise ConnectionError("redis down")

    def scan_iter(self, *_a, **_k):
        raise ConnectionError("redis down")


@pytest_asyncio.fixture
async def broken_cache():
    cache_policies._backend = CacheBackend(_BoomClient())
    try:
        yield SkillsCache()
    finally:
        cache_policies._backend = None


async def test_get_global_swallows_redis_error(broken_cache):
    assert await broken_cache.get_global() is None


async def test_set_global_swallows_redis_error(broken_cache):
    await broken_cache.set_global([{"name": "x"}])


async def test_invalidate_global_swallows_redis_error(broken_cache):
    await broken_cache.invalidate_global()


async def test_get_user_registry_swallows_redis_error(broken_cache):
    assert await broken_cache.get_user_registry("u") is None


async def test_set_user_registry_swallows_redis_error(broken_cache):
    await broken_cache.set_user_registry("u", [{"k": "v"}])


async def test_invalidate_user_registry_swallows_redis_error(broken_cache):
    await broken_cache.invalidate_user_registry("u")


async def test_get_user_agent_skills_swallows_redis_error(broken_cache):
    assert await broken_cache.get_user_agent_skills("u", "a") is None


async def test_set_user_agent_skills_swallows_redis_error(broken_cache):
    await broken_cache.set_user_agent_skills("u", "a", ["s"])


async def test_invalidate_user_agent_skills_swallows_redis_error(broken_cache):
    await broken_cache.invalidate_user_agent_skills("u", "a")


async def test_invalidate_all_user_agent_keys_swallows_redis_error(broken_cache):
    await broken_cache.invalidate_all_user_agent_keys("u")
