"""Unit tests for the Redis read-through skills cache.

These tests exercise :class:`utils.skills_cache.SkillsCache` against an
in-process fakeredis instance, covering all three key families (global,
per-user registry, per-(user, agent) selection set) plus their TTLs, the
cascade scan/delete, and the resilience contract that a Redis failure never
raises into the request path (every accessor swallows and returns ``None``).
"""

from __future__ import annotations

import json

import pytest
import pytest_asyncio
from fakeredis import aioredis as fake_aioredis

from core.settings import settings
from utils.skills_cache import (
    SkillsCache,
    _GLOBAL_KEY,
    _user_agent_key,
    _user_registry_key,
)


@pytest_asyncio.fixture
async def fake_redis():
    client = fake_aioredis.FakeRedis(decode_responses=True)
    try:
        yield client
    finally:
        await client.aclose()


@pytest_asyncio.fixture
async def cache(fake_redis):
    instance = SkillsCache()
    instance._client = fake_redis
    try:
        yield instance
    finally:
        instance._client = None


# ---------------------------------------------------------------------------
# key builders
# ---------------------------------------------------------------------------

def test_key_builders_are_namespaced():
    assert _GLOBAL_KEY == "skills:global"
    assert _user_registry_key("u1") == "skills:user:u1:registry"
    assert _user_agent_key("u1", "a1") == "skills:user:u1:agent:a1"


# ---------------------------------------------------------------------------
# _get_client lazy creation + memoisation
# ---------------------------------------------------------------------------

async def test_get_client_returns_set_client(cache, fake_redis):
    assert await cache._get_client() is fake_redis


async def test_get_client_creates_lazily(monkeypatch):
    instance = SkillsCache()
    created: dict[str, object] = {}

    def fake_from_url(url, *, password, encoding, decode_responses):
        created["url"] = url
        created["password"] = password
        created["decode_responses"] = decode_responses
        return "fake-client"

    monkeypatch.setattr("utils.skills_cache.aioredis.from_url", fake_from_url)
    client = await instance._get_client()
    assert client == "fake-client"
    assert created["url"] == settings.redis.url
    assert created["decode_responses"] is True
    # Empty password secret resolves to None so redis-py uses no auth.
    assert created["password"] is None
    # Second call is memoised — from_url must not be hit again.
    assert await instance._get_client() == "fake-client"


# ---------------------------------------------------------------------------
# global catalog
# ---------------------------------------------------------------------------

async def test_set_and_get_global_roundtrips(cache, fake_redis):
    payload = [{"name": "skill-a"}, {"name": "skill-b"}]
    await cache.set_global(payload)
    assert await cache.get_global() == payload
    # TTL must be the settings-driven value, never persisted forever.
    ttl = await fake_redis.ttl(_GLOBAL_KEY)
    assert 0 < ttl <= settings.redis.skills_global_ttl_seconds


async def test_set_global_honours_explicit_ttl(cache, fake_redis):
    await cache.set_global([{"name": "x"}], ttl_seconds=42)
    ttl = await fake_redis.ttl(_GLOBAL_KEY)
    assert 0 < ttl <= 42


async def test_get_global_miss_returns_none(cache):
    assert await cache.get_global() is None


async def test_get_global_malformed_json_returns_none(cache, fake_redis):
    await fake_redis.set(_GLOBAL_KEY, "{not-valid-json")
    assert await cache.get_global() is None


async def test_get_global_non_list_payload_returns_none(cache, fake_redis):
    await fake_redis.set(_GLOBAL_KEY, json.dumps({"oops": "dict-not-list"}))
    assert await cache.get_global() is None


async def test_invalidate_global_deletes_entry(cache, fake_redis):
    await cache.set_global([{"name": "x"}])
    await cache.invalidate_global()
    assert await fake_redis.get(_GLOBAL_KEY) is None
    assert await cache.get_global() is None


# ---------------------------------------------------------------------------
# per-user registry
# ---------------------------------------------------------------------------

async def test_set_and_get_user_registry_roundtrips(cache, fake_redis):
    payload = [{"skill": "alpha"}]
    await cache.set_user_registry("user-1", payload)
    assert await cache.get_user_registry("user-1") == payload
    ttl = await fake_redis.ttl(_user_registry_key("user-1"))
    assert 0 < ttl <= settings.redis.skills_user_registry_ttl_seconds


async def test_get_user_registry_miss_returns_none(cache):
    assert await cache.get_user_registry("nobody") is None


async def test_get_user_registry_malformed_json_returns_none(cache, fake_redis):
    await fake_redis.set(_user_registry_key("user-1"), "[broken")
    assert await cache.get_user_registry("user-1") is None


async def test_get_user_registry_non_list_returns_none(cache, fake_redis):
    await fake_redis.set(_user_registry_key("user-1"), json.dumps({"k": "v"}))
    assert await cache.get_user_registry("user-1") is None


async def test_invalidate_user_registry_deletes_entry(cache, fake_redis):
    await cache.set_user_registry("user-1", [{"skill": "alpha"}])
    await cache.invalidate_user_registry("user-1")
    assert await cache.get_user_registry("user-1") is None


# ---------------------------------------------------------------------------
# per-(user, agent) selection set
# ---------------------------------------------------------------------------

async def test_set_and_get_user_agent_skills_roundtrips(cache, fake_redis):
    await cache.set_user_agent_skills("user-1", "agent-1", ["s1", "s2"])
    assert await cache.get_user_agent_skills("user-1", "agent-1") == ["s1", "s2"]
    ttl = await fake_redis.ttl(_user_agent_key("user-1", "agent-1"))
    assert 0 < ttl <= settings.redis.skills_user_agent_ttl_seconds


async def test_get_user_agent_skills_coerces_items_to_str(cache, fake_redis):
    # Stored payload may have been written with non-string members; the getter
    # normalises every element to str.
    await fake_redis.set(_user_agent_key("user-1", "agent-1"), json.dumps([1, 2, "three"]))
    assert await cache.get_user_agent_skills("user-1", "agent-1") == ["1", "2", "three"]


async def test_get_user_agent_skills_miss_returns_none(cache):
    assert await cache.get_user_agent_skills("u", "a") is None


async def test_get_user_agent_skills_malformed_json_returns_none(cache, fake_redis):
    await fake_redis.set(_user_agent_key("u", "a"), "not json[")
    assert await cache.get_user_agent_skills("u", "a") is None


async def test_get_user_agent_skills_non_list_returns_none(cache, fake_redis):
    await fake_redis.set(_user_agent_key("u", "a"), json.dumps({"k": "v"}))
    assert await cache.get_user_agent_skills("u", "a") is None


async def test_invalidate_user_agent_skills_deletes_entry(cache, fake_redis):
    await cache.set_user_agent_skills("user-1", "agent-1", ["s1"])
    await cache.invalidate_user_agent_skills("user-1", "agent-1")
    assert await cache.get_user_agent_skills("user-1", "agent-1") is None


# ---------------------------------------------------------------------------
# cascade invalidation
# ---------------------------------------------------------------------------

async def test_invalidate_all_user_agent_keys_drops_only_that_users_agent_keys(cache, fake_redis):
    await cache.set_user_agent_skills("user-1", "agent-1", ["s1"])
    await cache.set_user_agent_skills("user-1", "agent-2", ["s2"])
    await cache.set_user_agent_skills("user-2", "agent-9", ["s9"])
    await cache.set_user_registry("user-1", [{"skill": "keep-me"}])

    await cache.invalidate_all_user_agent_keys("user-1")

    # Both of user-1's per-agent keys are gone.
    assert await cache.get_user_agent_skills("user-1", "agent-1") is None
    assert await cache.get_user_agent_skills("user-1", "agent-2") is None
    # Another user's per-agent key is untouched.
    assert await cache.get_user_agent_skills("user-2", "agent-9") == ["s9"]
    # The registry key (different family) is untouched by the agent-key cascade.
    assert await cache.get_user_registry("user-1") == [{"skill": "keep-me"}]


async def test_invalidate_all_user_agent_keys_no_keys_is_noop(cache):
    # No matching keys → no exception, nothing deleted.
    await cache.invalidate_all_user_agent_keys("user-with-nothing")


# ---------------------------------------------------------------------------
# resilience — a Redis failure must never raise into the request path
# ---------------------------------------------------------------------------

class _BoomClient:
    async def get(self, *_a, **_k):
        raise ConnectionError("redis down")

    async def set(self, *_a, **_k):
        raise ConnectionError("redis down")

    async def delete(self, *_a, **_k):
        raise ConnectionError("redis down")

    async def scan(self, *_a, **_k):
        raise ConnectionError("redis down")


@pytest_asyncio.fixture
async def broken_cache():
    instance = SkillsCache()
    instance._client = _BoomClient()
    try:
        yield instance
    finally:
        instance._client = None


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
