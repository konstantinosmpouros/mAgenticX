"""Unit tests for the bridge -> agents-service skills proxy (``utils.skills``).

Every public function in ``utils.skills`` opens an ``httpx.AsyncClient`` and
calls the agents service through ``upstream_error_handler.run_with_retries``.
We monkeypatch ``utils.skills.httpx.AsyncClient`` with a fake client whose
``get``/``post``/``delete``/``request`` methods either return a fake response
or raise an httpx transport error, and we stub the ``skills_cache`` layer with
an in-memory dict so cache hits / misses / invalidations are observable
without a real Redis. ``utils.skills.get_agent_by_id`` is patched directly to
control slug resolution.
"""
from __future__ import annotations

from types import SimpleNamespace

import httpx
import pytest
import pytest_asyncio

import utils.skills as skills_mod
from utils import skill_store
from utils.skills import (
    add_global_skill_to_user_pool,
    create_custom_skill_in_pool,
    disable_user_agent_skill,
    enable_user_agent_skill,
    get_user_agent_skills,
    get_user_skill_detail,
    list_skills,
    list_user_skills,
    remove_skill_from_user_pool,
    _resolve_agent_slug,
)


# ---------------------------------------------------------------------------
# Fake httpx plumbing
# ---------------------------------------------------------------------------
class FakeResponse:
    def __init__(self, *, status_code: int = 200, json_data=None, raise_status: bool = False):
        self.status_code = status_code
        self._json_data = json_data
        self._raise_status = raise_status

    def json(self):
        if isinstance(self._json_data, Exception):
            raise self._json_data
        return self._json_data

    def raise_for_status(self):
        if self._raise_status or self.status_code >= 400:
            request = httpx.Request("GET", "http://agents.test/x")
            response = httpx.Response(self.status_code, request=request)
            raise httpx.HTTPStatusError("boom", request=request, response=response)


class FakeClient:
    """Async-context-manager stand-in for ``httpx.AsyncClient``.

    ``handler`` is a callable ``(method, url, kwargs) -> FakeResponse`` (or one
    that raises). Every verb funnels through it so a test can inspect what was
    requested and decide the response.
    """

    def __init__(self, handler):
        self._handler = handler

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get(self, url, **kwargs):
        return await self._dispatch("GET", url, kwargs)

    async def post(self, url, **kwargs):
        return await self._dispatch("POST", url, kwargs)

    async def delete(self, url, **kwargs):
        return await self._dispatch("DELETE", url, kwargs)

    async def request(self, method, url, **kwargs):
        return await self._dispatch(method, url, kwargs)

    async def _dispatch(self, method, url, kwargs):
        result = self._handler(method, url, kwargs)
        if isinstance(result, Exception):
            raise result
        return result


def install_fake_client(monkeypatch, handler, calls=None):
    """Patch ``utils.skills.httpx.AsyncClient`` to yield a FakeClient.

    If ``calls`` is supplied each dispatch is appended to it as
    ``(method, url, kwargs)`` for assertions.
    """

    def wrapped(method, url, kwargs):
        if calls is not None:
            calls.append((method, url, kwargs))
        return handler(method, url, kwargs)

    def factory(*args, **kwargs):
        return FakeClient(wrapped)

    monkeypatch.setattr(skills_mod.httpx, "AsyncClient", factory)


# ---------------------------------------------------------------------------
# In-memory skills_cache stub
# ---------------------------------------------------------------------------
class FakeSkillsCache:
    def __init__(self):
        self.global_value = None
        self.user_registry: dict[str, list] = {}
        self.user_agent: dict[tuple[str, str], list] = {}
        self.invalidated_registries: list[str] = []
        self.invalidated_all_agent: list[str] = []
        self.invalidated_agent: list[tuple[str, str]] = []
        self.set_global_calls: list[list] = []

    async def get_global(self):
        return self.global_value

    async def set_global(self, payload):
        self.global_value = payload
        self.set_global_calls.append(payload)

    async def get_user_registry(self, user_id):
        return self.user_registry.get(user_id)

    async def set_user_registry(self, user_id, payload):
        self.user_registry[user_id] = payload

    async def invalidate_user_registry(self, user_id):
        self.invalidated_registries.append(user_id)
        self.user_registry.pop(user_id, None)

    async def invalidate_all_user_agent_keys(self, user_id):
        self.invalidated_all_agent.append(user_id)

    async def get_user_agent_skills(self, user_id, agent_id):
        return self.user_agent.get((user_id, agent_id))

    async def set_user_agent_skills(self, user_id, agent_id, payload):
        self.user_agent[(user_id, agent_id)] = payload

    async def invalidate_user_agent_skills(self, user_id, agent_id):
        self.invalidated_agent.append((user_id, agent_id))
        self.user_agent.pop((user_id, agent_id), None)


@pytest.fixture
def fake_cache(monkeypatch):
    cache = FakeSkillsCache()
    monkeypatch.setattr(skills_mod, "skills_cache", cache)
    return cache


@pytest_asyncio.fixture
async def db(session_factory):
    """A real session — the user pool and per-agent assignments live in chat_db
    now, so these are no longer pure proxy tests."""
    async with session_factory() as session:
        yield session


@pytest.fixture
def patch_slug(monkeypatch):
    """Make ``_resolve_agent_slug`` return a fixed slug for any agent_id."""

    async def fake_get_agent_by_id(agent_id):
        return SimpleNamespace(id=agent_id, slug="test-slug")

    monkeypatch.setattr(skills_mod, "get_agent_by_id", fake_get_agent_by_id)


# ---------------------------------------------------------------------------
# list_skills
# ---------------------------------------------------------------------------
async def test_list_skills_cache_hit_skips_upstream(monkeypatch, fake_cache):
    fake_cache.global_value = [{"name": "cached-skill"}]

    def handler(method, url, kwargs):  # pragma: no cover - must not be called
        raise AssertionError("upstream must not be hit on cache hit")

    install_fake_client(monkeypatch, handler)

    result = await list_skills()
    assert result == [{"name": "cached-skill"}]


async def test_list_skills_cache_miss_fetches_and_upserts(monkeypatch, fake_cache):
    payload = [{"name": "s1"}, {"name": "s2"}]
    calls: list = []
    install_fake_client(monkeypatch, lambda m, u, k: FakeResponse(json_data=payload), calls)

    result = await list_skills()

    assert result == payload
    assert fake_cache.global_value == payload
    # cache-miss path passes params=None (no bypass query string)
    assert calls[0][2]["params"] is None


async def test_list_skills_bypass_skips_read_and_reupserts(monkeypatch, fake_cache):
    fake_cache.global_value = [{"name": "stale"}]
    fresh = [{"name": "fresh"}]
    calls: list = []
    install_fake_client(monkeypatch, lambda m, u, k: FakeResponse(json_data=fresh), calls)

    result = await list_skills(bypass_cache=True)

    assert result == fresh
    assert fake_cache.global_value == fresh
    assert calls[0][2]["params"] == {"bypass_cache": "true"}


async def test_list_skills_non_list_payload_returns_empty(monkeypatch, fake_cache):
    install_fake_client(monkeypatch, lambda m, u, k: FakeResponse(json_data={"oops": 1}))
    result = await list_skills()
    assert result == []
    # malformed payload is not cached
    assert fake_cache.set_global_calls == []


async def test_list_skills_http_error_raises_502(monkeypatch, fake_cache):
    install_fake_client(monkeypatch, lambda m, u, k: FakeResponse(status_code=500, raise_status=True))
    # upstream_error_handler converts the upstream HTTP error to HTTPException(502)
    with pytest.raises(Exception) as exc:
        await list_skills()
    assert getattr(exc.value, "status_code", None) == 502


async def test_list_skills_request_error_raises_503(monkeypatch, fake_cache):
    install_fake_client(
        monkeypatch,
        lambda m, u, k: httpx.ConnectError("down", request=httpx.Request("GET", "http://agents.test")),
    )
    with pytest.raises(Exception) as exc:
        await list_skills()
    assert getattr(exc.value, "status_code", None) == 503


# ---------------------------------------------------------------------------
# list_user_skills
# ---------------------------------------------------------------------------
async def test_list_user_skills_served_from_chat_db_without_upstream(monkeypatch, db):
    # Once we hold a pool, the agents service is not consulted at all — this is
    # what removes the two-hour staleness window a tool-created skill used to sit in.
    await skill_store.add_to_pool(db, "u1", "pool-skill", pool_type="global")
    await db.commit()

    def handler(method, url, kwargs):  # pragma: no cover
        raise AssertionError("must not hit upstream")

    install_fake_client(monkeypatch, handler)
    result = await list_user_skills(db=db, user_id="u1")
    assert [r["name"] for r in result] == ["pool-skill"]
    assert result[0]["type"] == "global"


async def test_list_user_skills_adopts_a_volume_only_pool(monkeypatch, db):
    # A user whose pool pre-dates this store: fetch the manifest, then each
    # custom skill's body, adopt both, and serve locally from then on.
    manifest = [{"name": "p1", "type": "custom", "description": "d"}]
    detail = {"name": "p1", "type": "custom", "files": [{"path": "SKILL.md", "content": "# P1"}]}

    def handler(method, url, kwargs):
        # the per-skill detail URL ends with the skill name
        return FakeResponse(json_data=detail if url.rstrip("/").endswith("/p1") else manifest)

    install_fake_client(monkeypatch, handler)
    result = await list_user_skills(db=db, user_id="u2")
    assert [r["name"] for r in result] == ["p1"]

    # Membership is adopted; the body is NOT — file contents are pulled when a
    # skill is opened, because most are never read and they are the large part
    # of the payload.
    stored = await skill_store.get_custom_skill(db, "u2", "p1")
    assert stored is not None
    assert stored["files"] == []

    def explode(method, url, kwargs):  # pragma: no cover
        raise AssertionError("must not re-fetch once membership is adopted")

    install_fake_client(monkeypatch, explode)
    assert [r["name"] for r in await list_user_skills(db=db, user_id="u2")] == ["p1"]


async def test_list_user_skills_non_list_returns_empty(monkeypatch, fake_cache, db):
    install_fake_client(monkeypatch, lambda m, u, k: FakeResponse(json_data="not a list"))
    result = await list_user_skills(db=db, user_id="u3")
    assert result == []


async def test_list_user_skills_request_error(monkeypatch, fake_cache, db):
    install_fake_client(
        monkeypatch,
        lambda m, u, k: httpx.ConnectTimeout("t", request=httpx.Request("GET", "http://agents.test")),
    )
    with pytest.raises(Exception) as exc:
        await list_user_skills(db=db, user_id="u4")
    assert getattr(exc.value, "status_code", None) == 503


# ---------------------------------------------------------------------------
# get_user_skill_detail
# ---------------------------------------------------------------------------
async def test_get_user_skill_detail_returns_dict(monkeypatch, db):
    detail = {"name": "s", "type": "custom", "files": []}
    install_fake_client(monkeypatch, lambda m, u, k: FakeResponse(json_data=detail))
    result = await get_user_skill_detail(db=db, user_id="u", skill_name="s")
    assert result == detail


async def test_get_user_skill_detail_404(monkeypatch, db):
    install_fake_client(monkeypatch, lambda m, u, k: FakeResponse(status_code=404))
    with pytest.raises(Exception) as exc:
        await get_user_skill_detail(db=db, user_id="u", skill_name="missing")
    assert getattr(exc.value, "status_code", None) == 404


async def test_get_user_skill_detail_malformed_payload_502(monkeypatch, db):
    install_fake_client(monkeypatch, lambda m, u, k: FakeResponse(json_data=["list", "not", "dict"]))
    with pytest.raises(Exception) as exc:
        await get_user_skill_detail(db=db, user_id="u", skill_name="s")
    assert getattr(exc.value, "status_code", None) == 502


async def test_get_user_skill_detail_http_error_502(monkeypatch, db):
    install_fake_client(monkeypatch, lambda m, u, k: FakeResponse(status_code=500, raise_status=True))
    with pytest.raises(Exception) as exc:
        await get_user_skill_detail(db=db, user_id="u", skill_name="s")
    assert getattr(exc.value, "status_code", None) == 502


# ---------------------------------------------------------------------------
# add_global_skill_to_user_pool
# ---------------------------------------------------------------------------
async def test_add_global_skill_records_pool_membership(monkeypatch, db):
    install_fake_client(monkeypatch, lambda m, u, k: FakeResponse(status_code=204))
    await add_global_skill_to_user_pool(db=db, user_id="u", skill_name="s")
    pool = await skill_store.list_pool(db, "u")
    assert [(p["name"], p["type"]) for p in pool] == [("s", "global")]


async def test_add_global_skill_404(monkeypatch, fake_cache, db):
    install_fake_client(monkeypatch, lambda m, u, k: FakeResponse(status_code=404))
    with pytest.raises(Exception) as exc:
        await add_global_skill_to_user_pool(db=db, user_id="u", skill_name="s")
    assert getattr(exc.value, "status_code", None) == 404
    # Upstream refused, so nothing is recorded here either.
    assert await skill_store.list_pool(db, "u") == []


async def test_add_global_skill_409_conflict(monkeypatch, fake_cache, db):
    install_fake_client(monkeypatch, lambda m, u, k: FakeResponse(status_code=409))
    with pytest.raises(Exception) as exc:
        await add_global_skill_to_user_pool(db=db, user_id="u", skill_name="s")
    assert getattr(exc.value, "status_code", None) == 409


async def test_add_global_skill_request_error(monkeypatch, fake_cache, db):
    install_fake_client(
        monkeypatch,
        lambda m, u, k: httpx.ConnectError("x", request=httpx.Request("POST", "http://agents.test")),
    )
    with pytest.raises(Exception) as exc:
        await add_global_skill_to_user_pool(db=db, user_id="u", skill_name="s")
    assert getattr(exc.value, "status_code", None) == 503


# ---------------------------------------------------------------------------
# create_custom_skill_in_pool
# ---------------------------------------------------------------------------
async def test_create_custom_skill_success(monkeypatch, fake_cache, db):
    created = {"name": "new", "type": "custom", "source_path": "p"}
    install_fake_client(monkeypatch, lambda m, u, k: FakeResponse(status_code=201, json_data=created))
    result = await create_custom_skill_in_pool(
        db=db, user_id="u", payload={"name": "new", "files": [{"path": "SKILL.md", "content": "# New"}]}
    )
    assert result == created
    # The submitted files are the content that survives losing the volume.
    stored = await skill_store.get_custom_skill(db, "u", "new")
    assert stored is not None
    # The full contract shape — `encoding` and `size` are part of SkillFile.
    assert stored["files"] == [
        {"path": "SKILL.md", "content": "# New", "encoding": "utf-8", "size": 5}
    ]
    assert [p["name"] for p in await skill_store.list_pool(db, "u")] == ["new"]


async def test_create_custom_skill_409(monkeypatch, fake_cache, db):
    install_fake_client(monkeypatch, lambda m, u, k: FakeResponse(status_code=409))
    with pytest.raises(Exception) as exc:
        await create_custom_skill_in_pool(db=db, user_id="u", payload={"name": "dup"})
    assert getattr(exc.value, "status_code", None) == 409


async def test_create_custom_skill_422_forwards_upstream_detail(monkeypatch, fake_cache, db):
    body = {"detail": "SKILL.md is required."}
    install_fake_client(monkeypatch, lambda m, u, k: FakeResponse(status_code=422, json_data=body))
    with pytest.raises(Exception) as exc:
        await create_custom_skill_in_pool(db=db, user_id="u", payload={"name": "bad"})
    assert getattr(exc.value, "status_code", None) == 422
    assert exc.value.detail == "SKILL.md is required."


async def test_create_custom_skill_400_with_unparseable_body(monkeypatch, fake_cache, db):
    install_fake_client(
        monkeypatch,
        lambda m, u, k: FakeResponse(status_code=400, json_data=ValueError("no json")),
    )
    with pytest.raises(Exception) as exc:
        await create_custom_skill_in_pool(db=db, user_id="u", payload={"name": "bad"})
    assert getattr(exc.value, "status_code", None) == 422
    # falls back to the generic detail when the upstream body cannot be parsed
    assert "could not be created" in exc.value.detail


async def test_create_custom_skill_malformed_success_payload_502(monkeypatch, fake_cache, db):
    install_fake_client(monkeypatch, lambda m, u, k: FakeResponse(status_code=201, json_data=["bad"]))
    with pytest.raises(Exception) as exc:
        await create_custom_skill_in_pool(db=db, user_id="u", payload={"name": "x"})
    assert getattr(exc.value, "status_code", None) == 502


async def test_create_custom_skill_request_error(monkeypatch, fake_cache, db):
    install_fake_client(
        monkeypatch,
        lambda m, u, k: httpx.ConnectError("x", request=httpx.Request("POST", "http://agents.test")),
    )
    with pytest.raises(Exception) as exc:
        await create_custom_skill_in_pool(db=db, user_id="u", payload={"name": "x"})
    assert getattr(exc.value, "status_code", None) == 503


# ---------------------------------------------------------------------------
# remove_skill_from_user_pool
# ---------------------------------------------------------------------------
async def test_remove_skill_drops_pool_entry_and_its_assignments(monkeypatch, db):
    # Assignments go too: a removed skill must not keep showing as enabled on an
    # agent, and the next hydrate must not try to materialise it.
    await skill_store.add_to_pool(db, "u", "s", pool_type="custom")
    await skill_store.set_agent_skill(db, "u", "agent-a", "s", enabled=True)
    await db.commit()

    install_fake_client(monkeypatch, lambda m, u, k: FakeResponse(status_code=204))
    await remove_skill_from_user_pool(db=db, user_id="u", skill_name="s")

    assert await skill_store.list_pool(db, "u") == []
    assert await skill_store.list_agent_skills(db, "u", "agent-a") == []


async def test_remove_skill_http_error_502(monkeypatch, fake_cache, db):
    install_fake_client(monkeypatch, lambda m, u, k: FakeResponse(status_code=500, raise_status=True))
    with pytest.raises(Exception) as exc:
        await remove_skill_from_user_pool(db=db, user_id="u", skill_name="s")
    assert getattr(exc.value, "status_code", None) == 502


async def test_remove_skill_request_error_503(monkeypatch, fake_cache, db):
    install_fake_client(
        monkeypatch,
        lambda m, u, k: httpx.ReadError("x", request=httpx.Request("DELETE", "http://agents.test")),
    )
    with pytest.raises(Exception) as exc:
        await remove_skill_from_user_pool(db=db, user_id="u", skill_name="s")
    assert getattr(exc.value, "status_code", None) == 503


# ---------------------------------------------------------------------------
# _resolve_agent_slug
# ---------------------------------------------------------------------------
async def test_resolve_agent_slug_returns_slug(monkeypatch):
    async def fake_get_agent_by_id(agent_id):
        return SimpleNamespace(id=agent_id, slug="resolved-slug")

    monkeypatch.setattr(skills_mod, "get_agent_by_id", fake_get_agent_by_id)
    assert await _resolve_agent_slug("agent-1") == "resolved-slug"


async def test_resolve_agent_slug_404_when_missing(monkeypatch):
    async def fake_get_agent_by_id(agent_id):
        return None

    monkeypatch.setattr(skills_mod, "get_agent_by_id", fake_get_agent_by_id)
    with pytest.raises(Exception) as exc:
        await _resolve_agent_slug("nope")
    assert getattr(exc.value, "status_code", None) == 404


async def test_resolve_agent_slug_500_when_no_slug(monkeypatch):
    async def fake_get_agent_by_id(agent_id):
        return SimpleNamespace(id=agent_id, slug=None)

    monkeypatch.setattr(skills_mod, "get_agent_by_id", fake_get_agent_by_id)
    with pytest.raises(Exception) as exc:
        await _resolve_agent_slug("agent-noslug")
    assert getattr(exc.value, "status_code", None) == 500


# ---------------------------------------------------------------------------
# get_user_agent_skills (read-through cache)
# ---------------------------------------------------------------------------
async def test_get_user_agent_skills_served_from_chat_db(monkeypatch, patch_slug, db):
    await skill_store.set_agent_skill(db, "u", "test-slug", "skill-x", enabled=True)
    await db.commit()

    def handler(method, url, kwargs):  # pragma: no cover
        raise AssertionError("must not hit upstream once we hold assignments")

    install_fake_client(monkeypatch, handler)
    assert await get_user_agent_skills(db=db, user_id="u", agent_id="a") == ["skill-x"]


async def test_get_user_agent_skills_adopts_and_resolves_the_slug(monkeypatch, patch_slug, db):
    calls: list = []
    install_fake_client(monkeypatch, lambda m, u, k: FakeResponse(json_data=["s1", "s2"]), calls)
    result = await get_user_agent_skills(db=db, user_id="u", agent_id="a")
    assert result == ["s1", "s2"]
    # the resolved slug appears in the upstream URL
    assert "test-slug" in calls[0][1]
    # adopted, so the pairing is now local
    assert await skill_store.list_agent_skills(db, "u", "test-slug") == ["s1", "s2"]


async def test_get_user_agent_skills_coerces_items_to_str(monkeypatch, fake_cache, patch_slug, db):
    install_fake_client(monkeypatch, lambda m, u, k: FakeResponse(json_data=[1, 2, 3]))
    result = await get_user_agent_skills(db=db, user_id="u", agent_id="a")
    assert result == ["1", "2", "3"]


async def test_get_user_agent_skills_non_list_returns_empty(monkeypatch, fake_cache, patch_slug, db):
    install_fake_client(monkeypatch, lambda m, u, k: FakeResponse(json_data={"x": 1}))
    result = await get_user_agent_skills(db=db, user_id="u", agent_id="a")
    assert result == []


async def test_get_user_agent_skills_http_error_502(monkeypatch, fake_cache, patch_slug, db):
    install_fake_client(monkeypatch, lambda m, u, k: FakeResponse(status_code=503, raise_status=True))
    with pytest.raises(Exception) as exc:
        await get_user_agent_skills(db=db, user_id="u", agent_id="a")
    assert getattr(exc.value, "status_code", None) == 502


async def test_get_user_agent_skills_request_error_503(monkeypatch, fake_cache, patch_slug, db):
    install_fake_client(
        monkeypatch,
        lambda m, u, k: httpx.ConnectError("x", request=httpx.Request("GET", "http://agents.test")),
    )
    with pytest.raises(Exception) as exc:
        await get_user_agent_skills(db=db, user_id="u", agent_id="a")
    assert getattr(exc.value, "status_code", None) == 503


# ---------------------------------------------------------------------------
# enable / disable per-(user, agent) skill (shared _proxy_skill_mutation)
# ---------------------------------------------------------------------------
async def test_enable_user_agent_skill_uses_put_and_records_it(monkeypatch, patch_slug, db):
    calls: list = []
    install_fake_client(monkeypatch, lambda m, u, k: FakeResponse(status_code=204), calls)
    await enable_user_agent_skill(db=db, user_id="u", agent_id="a", skill_name="s")
    assert calls[0][0] == "PUT"
    assert await skill_store.list_agent_skills(db, "u", "test-slug") == ["s"]


async def test_disable_user_agent_skill_uses_delete_and_removes_it(monkeypatch, patch_slug, db):
    await skill_store.set_agent_skill(db, "u", "test-slug", "s", enabled=True)
    await db.commit()
    calls: list = []
    install_fake_client(monkeypatch, lambda m, u, k: FakeResponse(status_code=204), calls)
    await disable_user_agent_skill(db=db, user_id="u", agent_id="a", skill_name="s")
    assert calls[0][0] == "DELETE"
    assert await skill_store.list_agent_skills(db, "u", "test-slug") == []


async def test_proxy_skill_mutation_404_not_in_pool(monkeypatch, fake_cache, patch_slug, db):
    install_fake_client(monkeypatch, lambda m, u, k: FakeResponse(status_code=404))
    with pytest.raises(Exception) as exc:
        await enable_user_agent_skill(db=db, user_id="u", agent_id="a", skill_name="s")
    assert getattr(exc.value, "status_code", None) == 404
    # Upstream refused, so the assignment is not recorded here either.
    assert await skill_store.list_agent_skills(db, "u", "test-slug") == []


async def test_proxy_skill_mutation_http_error_502(monkeypatch, fake_cache, patch_slug, db):
    install_fake_client(monkeypatch, lambda m, u, k: FakeResponse(status_code=500, raise_status=True))
    with pytest.raises(Exception) as exc:
        await disable_user_agent_skill(db=db, user_id="u", agent_id="a", skill_name="s")
    assert getattr(exc.value, "status_code", None) == 502


async def test_proxy_skill_mutation_request_error_503(monkeypatch, fake_cache, patch_slug, db):
    install_fake_client(
        monkeypatch,
        lambda m, u, k: httpx.ConnectError("x", request=httpx.Request("PUT", "http://agents.test")),
    )
    with pytest.raises(Exception) as exc:
        await enable_user_agent_skill(db=db, user_id="u", agent_id="a", skill_name="s")
    assert getattr(exc.value, "status_code", None) == 503


async def test_opening_a_skill_adopts_its_content(monkeypatch, db):
    # The lazy half: a skill whose body we do not hold is fetched once, stored,
    # and served locally from then on.
    await skill_store.store_custom_skill(db, "u9", name="p9", files=[])
    await db.commit()

    detail = {"name": "p9", "type": "custom", "files": [{"path": "SKILL.md", "content": "# P9"}]}
    install_fake_client(monkeypatch, lambda m, u, k: FakeResponse(json_data=detail))
    first = await get_user_skill_detail(db=db, user_id="u9", skill_name="p9")
    assert [f["path"] for f in first["files"]] == ["SKILL.md"]

    def explode(method, url, kwargs):  # pragma: no cover
        raise AssertionError("must not re-fetch a body we already stored")

    install_fake_client(monkeypatch, explode)
    again = await get_user_skill_detail(db=db, user_id="u9", skill_name="p9")
    assert again["files"] == [
        {"path": "SKILL.md", "content": "# P9", "encoding": "utf-8", "size": 4}
    ]


# ---------------------------------------------------------------------------
# The store's output must satisfy the response contracts
# ---------------------------------------------------------------------------
# Three separate outages came from the same shape: chat_db grew a reader, the
# reader returned a dict, and the dict was missing a field the Pydantic
# response model requires (`source_path`) or sent None where a str is declared
# (`category`). Nothing catches that until a real request 500s, because the
# store and the schema are only connected at the router. These validate the
# store's output against the real models.
async def test_list_pool_output_satisfies_the_user_skill_contract(db):
    from schema import UserSkill

    await skill_store.add_to_pool(
        db, "uc", "global-one", pool_type="global", source_path="global/x/global-one",
        category="x",
    )
    await skill_store.store_custom_skill(db, "uc", name="custom-one", files=[])
    await db.commit()

    for item in await skill_store.list_pool(db, "uc"):
        UserSkill.model_validate(item)


async def test_get_custom_skill_output_satisfies_the_detail_contract(db):
    from schema import UserSkillDetail

    await skill_store.store_custom_skill(
        db,
        "ud",
        name="custom-two",
        description="d",
        files=[{"path": "SKILL.md", "content": "# Body"}, {"path": "run.py", "content": "x"}],
    )
    await db.commit()

    stored = await skill_store.get_custom_skill(db, "ud", "custom-two")
    model = UserSkillDetail.model_validate(stored)
    assert model.source_path == "users/ud/custom/custom-two"
    # `content` is the SKILL.md body, read from the stored file so the preview
    # and the file inventory cannot disagree.
    assert model.content == "# Body"
    assert [f.path for f in model.files] == ["SKILL.md", "run.py"]
