"""Unit tests for the bridge -> agents-service skills proxy (``utils.skills``).

Every public function in ``utils.skills`` opens an ``httpx.AsyncClient`` and
calls the agents service through ``upstream_error_handler.run_with_retries``.
We monkeypatch ``utils.skills.httpx.AsyncClient`` with a fake client whose
``get``/``post``/``delete``/``request`` methods either return a fake response
or raise an httpx transport error. Nothing is cached any more — the bundled
catalogue and its Redis cache were removed by plan 30 — so every test is about
what is forwarded and how upstream answers are mapped.
``utils.skills.get_agent_by_id`` is patched directly to control slug resolution.
"""
from __future__ import annotations

from types import SimpleNamespace

import httpx
import pytest
import pytest_asyncio

import utils.skills as skills_mod
from schema import UserSkill, UserSkillDetail
from utils.skills import (
    add_remote_skill_to_user_pool,
    create_custom_skill_in_pool,
    disable_user_agent_skill,
    enable_user_agent_skill,
    get_user_agent_skills,
    get_user_skill_detail,
    list_user_skills,
    remove_skill_from_user_pool,
    search_catalogue,
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
# search_catalogue
# ---------------------------------------------------------------------------
async def test_search_forwards_query_and_paging(monkeypatch):
    """The bridge holds no catalogue: a search is one upstream GET, uncached."""
    page = {"results": [{"source_id": "nvidia", "skill_id": "cudf"}], "total": 1}
    calls: list = []
    install_fake_client(monkeypatch, lambda m, u, k: FakeResponse(json_data=page), calls)

    first = await search_catalogue(query="cuda", source=None, limit=10, offset=0)
    await search_catalogue(query="cuda", source=None, limit=10, offset=0)

    assert first == page
    assert len(calls) == 2                       # nothing cached in between
    method, url, kwargs = calls[0]
    assert method == "GET" and url.endswith("/skills/catalogue/search")
    assert kwargs["params"] == {"q": "cuda", "limit": 10, "offset": 0}


async def test_search_passes_a_source_filter_only_when_given(monkeypatch):
    calls: list = []
    install_fake_client(monkeypatch, lambda m, u, k: FakeResponse(json_data={"results": []}), calls)
    await search_catalogue(query="", source="ecc", limit=5, offset=10)
    assert calls[0][2]["params"] == {"q": "", "limit": 5, "offset": 10, "source": "ecc"}


async def test_search_malformed_payload_502(monkeypatch):
    install_fake_client(monkeypatch, lambda m, u, k: FakeResponse(json_data=["not", "a", "page"]))
    with pytest.raises(Exception) as exc:
        await search_catalogue(query="x", source=None, limit=10, offset=0)
    assert getattr(exc.value, "status_code", None) == 502


async def test_search_request_error_503(monkeypatch):
    install_fake_client(
        monkeypatch,
        lambda m, u, k: httpx.ConnectError("down", request=httpx.Request("GET", "http://agents.test")),
    )
    with pytest.raises(Exception) as exc:
        await search_catalogue(query="x", source=None, limit=10, offset=0)
    assert getattr(exc.value, "status_code", None) == 503


# ---------------------------------------------------------------------------
# list_user_skills
# ---------------------------------------------------------------------------
async def test_list_user_skills_reads_upstream_every_time(monkeypatch):
    """The pool is not mirrored here any more, and not cached either.

    The cache is what made a skill created by the ``create_skill`` tool invisible
    in the Skills tab for up to two hours; with the hop now *being* the read,
    caching it would put that window straight back.
    """
    calls = []
    install_fake_client(
        monkeypatch,
        lambda m, u, k: FakeResponse(json_data=[{"name": "pool-skill", "type": "global"}]),
        calls=calls,
    )
    first = await list_user_skills(user_id="u1")
    second = await list_user_skills(user_id="u1")

    assert [r["name"] for r in first] == ["pool-skill"]
    assert first == second
    assert len(calls) == 2            # no read-through cache in between


async def test_list_user_skills_non_list_returns_empty(monkeypatch):
    install_fake_client(monkeypatch, lambda m, u, k: FakeResponse(json_data="not a list"))
    result = await list_user_skills(user_id="u3")
    assert result == []


# ---------------------------------------------------------------------------
# get_user_skill_detail
# ---------------------------------------------------------------------------
async def test_get_user_skill_detail_returns_dict(monkeypatch):
    detail = {"name": "s", "type": "custom", "files": []}
    install_fake_client(monkeypatch, lambda m, u, k: FakeResponse(json_data=detail))
    result = await get_user_skill_detail(user_id="u", skill_name="s")
    assert result == detail


async def test_get_user_skill_detail_404(monkeypatch):
    install_fake_client(monkeypatch, lambda m, u, k: FakeResponse(status_code=404))
    with pytest.raises(Exception) as exc:
        await get_user_skill_detail(user_id="u", skill_name="missing")
    assert getattr(exc.value, "status_code", None) == 404


async def test_get_user_skill_detail_malformed_payload_502(monkeypatch):
    install_fake_client(monkeypatch, lambda m, u, k: FakeResponse(json_data=["list", "not", "dict"]))
    with pytest.raises(Exception) as exc:
        await get_user_skill_detail(user_id="u", skill_name="s")
    assert getattr(exc.value, "status_code", None) == 502


async def test_get_user_skill_detail_http_error_502(monkeypatch):
    install_fake_client(monkeypatch, lambda m, u, k: FakeResponse(status_code=500, raise_status=True))
    with pytest.raises(Exception) as exc:
        await get_user_skill_detail(user_id="u", skill_name="s")
    assert getattr(exc.value, "status_code", None) == 502


# ---------------------------------------------------------------------------
# add_remote_skill_to_user_pool
# ---------------------------------------------------------------------------
async def test_add_remote_is_one_post_and_returns_the_entry(monkeypatch):
    entry = {"name": "cudf", "type": "remote", "source_path": "remote/nvidia/cudf@abc"}
    calls: list = []
    install_fake_client(monkeypatch, lambda m, u, k: FakeResponse(status_code=201, json_data=entry), calls)
    body = await add_remote_skill_to_user_pool(user_id="u", source_id="nvidia", skill_id="cudf")
    assert body == entry
    assert [(c[0], c[1].endswith("/users/u/skills/remote/nvidia/cudf")) for c in calls] == [("POST", True)]


async def test_add_remote_is_never_retried(monkeypatch):
    """An Add may download a whole skill upstream; a retry after a slow first
    attempt would double the work and then answer 409 for a skill that had in
    fact been added. A transport error therefore surfaces after ONE call."""
    calls: list = []
    install_fake_client(
        monkeypatch,
        lambda m, u, k: httpx.ReadTimeout("slow", request=httpx.Request("POST", "http://agents.test")),
        calls,
    )
    with pytest.raises(Exception) as exc:
        await add_remote_skill_to_user_pool(user_id="u", source_id="nvidia", skill_id="cudf")
    assert getattr(exc.value, "status_code", None) == 503
    assert len(calls) == 1


@pytest.mark.parametrize("upstream, expected", [(404, 404), (409, 409), (502, 502), (503, 503)])
async def test_add_remote_maps_upstream_statuses_to_reviewed_messages(monkeypatch, upstream, expected):
    """The user sees the bridge's own wording, never an upstream detail string."""
    install_fake_client(
        monkeypatch,
        lambda m, u, k: FakeResponse(status_code=upstream, json_data={"detail": "internal path /var/x"}),
    )
    with pytest.raises(Exception) as exc:
        await add_remote_skill_to_user_pool(user_id="u", source_id="nvidia", skill_id="cudf")
    assert getattr(exc.value, "status_code", None) == expected
    assert "/var/x" not in str(getattr(exc.value, "detail", ""))


async def test_add_remote_422_forwards_the_verification_reason(monkeypatch):
    install_fake_client(
        monkeypatch,
        lambda m, u, k: FakeResponse(
            status_code=422, json_data={"detail": "This skill failed verification (checksum mismatch)."}
        ),
    )
    with pytest.raises(Exception) as exc:
        await add_remote_skill_to_user_pool(user_id="u", source_id="nvidia", skill_id="cudf")
    assert getattr(exc.value, "status_code", None) == 422
    assert "checksum mismatch" in exc.value.detail


# ---------------------------------------------------------------------------
# create_custom_skill_in_pool
# ---------------------------------------------------------------------------
async def test_create_custom_skill_success(monkeypatch):
    created = {"name": "new", "type": "custom", "source_path": "p"}
    install_fake_client(monkeypatch, lambda m, u, k: FakeResponse(status_code=201, json_data=created))
    result = await create_custom_skill_in_pool(
        user_id="u", payload={"name": "new", "files": [{"path": "SKILL.md", "content": "# New"}]}
    )
    # The upstream entry is returned verbatim — nothing is stored on this side,
    # so there is no second copy that can disagree about what the user has.
    assert result == created


async def test_create_custom_skill_409(monkeypatch):
    install_fake_client(monkeypatch, lambda m, u, k: FakeResponse(status_code=409))
    with pytest.raises(Exception) as exc:
        await create_custom_skill_in_pool(user_id="u", payload={"name": "dup"})
    assert getattr(exc.value, "status_code", None) == 409


async def test_create_custom_skill_422_forwards_upstream_detail(monkeypatch):
    body = {"detail": "SKILL.md is required."}
    install_fake_client(monkeypatch, lambda m, u, k: FakeResponse(status_code=422, json_data=body))
    with pytest.raises(Exception) as exc:
        await create_custom_skill_in_pool(user_id="u", payload={"name": "bad"})
    assert getattr(exc.value, "status_code", None) == 422
    assert exc.value.detail == "SKILL.md is required."


async def test_create_custom_skill_400_with_unparseable_body(monkeypatch):
    install_fake_client(
        monkeypatch,
        lambda m, u, k: FakeResponse(status_code=400, json_data=ValueError("no json")),
    )
    with pytest.raises(Exception) as exc:
        await create_custom_skill_in_pool(user_id="u", payload={"name": "bad"})
    assert getattr(exc.value, "status_code", None) == 422
    # falls back to the generic detail when the upstream body cannot be parsed
    assert "could not be created" in exc.value.detail


async def test_create_custom_skill_malformed_success_payload_502(monkeypatch):
    install_fake_client(monkeypatch, lambda m, u, k: FakeResponse(status_code=201, json_data=["bad"]))
    with pytest.raises(Exception) as exc:
        await create_custom_skill_in_pool(user_id="u", payload={"name": "x"})
    assert getattr(exc.value, "status_code", None) == 502


async def test_create_custom_skill_request_error(monkeypatch):
    install_fake_client(
        monkeypatch,
        lambda m, u, k: httpx.ConnectError("x", request=httpx.Request("POST", "http://agents.test")),
    )
    with pytest.raises(Exception) as exc:
        await create_custom_skill_in_pool(user_id="u", payload={"name": "x"})
    assert getattr(exc.value, "status_code", None) == 503


# ---------------------------------------------------------------------------
# remove_skill_from_user_pool
# ---------------------------------------------------------------------------
async def test_remove_skill_is_a_pure_proxy(monkeypatch):
    """The cascade to per-agent assignments happens in ``agent_runtime``, where
    the rows are — this side just forwards the delete."""
    calls: list = []
    install_fake_client(
        monkeypatch, lambda m, u, k: FakeResponse(status_code=204), calls=calls
    )
    await remove_skill_from_user_pool(user_id="u", skill_name="s")
    assert [c[0] for c in calls] == ["DELETE"]


async def test_remove_skill_http_error_502(monkeypatch):
    install_fake_client(monkeypatch, lambda m, u, k: FakeResponse(status_code=500, raise_status=True))
    with pytest.raises(Exception) as exc:
        await remove_skill_from_user_pool(user_id="u", skill_name="s")
    assert getattr(exc.value, "status_code", None) == 502


async def test_remove_skill_request_error_503(monkeypatch):
    install_fake_client(
        monkeypatch,
        lambda m, u, k: httpx.ReadError("x", request=httpx.Request("DELETE", "http://agents.test")),
    )
    with pytest.raises(Exception) as exc:
        await remove_skill_from_user_pool(user_id="u", skill_name="s")
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
async def test_get_user_agent_skills_non_list_returns_empty(monkeypatch, patch_slug):
    install_fake_client(monkeypatch, lambda m, u, k: FakeResponse(json_data={"x": 1}))
    result = await get_user_agent_skills(user_id="u", agent_id="a")
    assert result == []


# ---------------------------------------------------------------------------
# enable / disable per-(user, agent) skill (shared _proxy_skill_mutation)
# ---------------------------------------------------------------------------
async def test_enable_user_agent_skill_uses_put(monkeypatch, patch_slug):
    calls: list = []
    install_fake_client(monkeypatch, lambda m, u, k: FakeResponse(status_code=204), calls)
    await enable_user_agent_skill(user_id="u", agent_id="a", skill_name="s")
    assert calls[0][0] == "PUT"


async def test_disable_user_agent_skill_uses_delete(monkeypatch, patch_slug):
    calls: list = []
    install_fake_client(monkeypatch, lambda m, u, k: FakeResponse(status_code=204), calls)
    await disable_user_agent_skill(user_id="u", agent_id="a", skill_name="s")
    assert calls[0][0] == "DELETE"


async def test_proxy_skill_mutation_404_not_in_pool(monkeypatch, patch_slug):
    install_fake_client(monkeypatch, lambda m, u, k: FakeResponse(status_code=404))
    with pytest.raises(Exception) as exc:
        await enable_user_agent_skill(user_id="u", agent_id="a", skill_name="s")
    assert getattr(exc.value, "status_code", None) == 404


async def test_proxy_skill_mutation_http_error_502(monkeypatch, patch_slug):
    install_fake_client(monkeypatch, lambda m, u, k: FakeResponse(status_code=500, raise_status=True))
    with pytest.raises(Exception) as exc:
        await disable_user_agent_skill(user_id="u", agent_id="a", skill_name="s")
    assert getattr(exc.value, "status_code", None) == 502


async def test_proxy_skill_mutation_request_error_503(monkeypatch, patch_slug):
    install_fake_client(
        monkeypatch,
        lambda m, u, k: httpx.ConnectError("x", request=httpx.Request("PUT", "http://agents.test")),
    )
    with pytest.raises(Exception) as exc:
        await enable_user_agent_skill(user_id="u", agent_id="a", skill_name="s")
    assert getattr(exc.value, "status_code", None) == 503


# ---------------------------------------------------------------------------
# The upstream payload must satisfy the response contracts
# ---------------------------------------------------------------------------
# Three separate outages came from the same shape: a reader returned a dict, and
# the dict was missing a field the Pydantic response model requires
# (`source_path`) or sent None where a str is declared (`category`). Nothing
# catches that until a real request 500s, because the payload and the schema are
# only connected at the router. The producer moved upstream; the gap did not, so
# these validate what the agents service actually sends against the real models.
async def test_the_pool_payload_satisfies_the_user_skill_contract(monkeypatch):
    # Exactly what `GET /users/{uid}/skills` returns — a legacy global entry, a
    # custom one and a remote one, which is where `category`, `source_path` and
    # `provenance` differ.
    upstream = [
        {"name": "global-one", "type": "global", "description": "d",
         "source_path": "global/x/global-one", "category": "x",
         "origin": "user", "created_by_agent": None, "created_at": None},
        {"name": "custom-one", "type": "custom", "description": "d",
         "source_path": "users/uc/custom/custom-one", "category": "",
         "origin": "user", "created_by_agent": None, "created_at": None},
        {"name": "cudf", "type": "remote", "description": "d",
         "source_path": "remote/nvidia/cudf@08a438518961", "category": "",
         "origin": "user", "created_by_agent": None, "created_at": None,
         "provenance": {"source_id": "nvidia", "source_label": "NVIDIA/skills",
                        "commit": "08a4385189" + "0" * 30, "licence": "CC-BY-4.0 AND Apache-2.0",
                        "upstream_url": "https://github.com/NVIDIA/skills/tree/x/skills/cudf"}},
    ]
    install_fake_client(monkeypatch, lambda m, u, k: FakeResponse(json_data=upstream))

    for item in await list_user_skills(user_id="uc"):
        UserSkill.model_validate(item)


async def test_the_detail_payload_satisfies_the_detail_contract(monkeypatch):
    upstream = {
        "name": "custom-two", "type": "custom", "description": "d",
        "source_path": "users/ud/custom/custom-two", "category": "",
        "content": "# Body",
        "files": [
            {"path": "SKILL.md", "content": "body", "encoding": "utf-8", "size": 0},
            {"path": "run.py", "content": "x", "encoding": "utf-8", "size": 0},
        ],
    }
    install_fake_client(monkeypatch, lambda m, u, k: FakeResponse(json_data=upstream))

    model = UserSkillDetail.model_validate(
        await get_user_skill_detail(user_id="ud", skill_name="custom-two")
    )
    assert model.source_path == "users/ud/custom/custom-two"
    # `content` is the SKILL.md body, so the preview and the file inventory
    # cannot disagree.
    assert model.content == "# Body"
    assert [f.path for f in model.files] == ["SKILL.md", "run.py"]


# ---------------------------------------------------------------------------
# Per-agent assignments are read upstream too
# ---------------------------------------------------------------------------
async def test_agent_assignments_are_read_from_the_owning_service(monkeypatch, patch_slug):
    """They used to be a ``chat_db`` table imported by the reconciliation pass.
    The trade taken here is deliberate: this read now fails when the agents
    service is down, where it used to serve a possibly-stale local row."""
    calls = []
    install_fake_client(
        monkeypatch, lambda m, u, k: FakeResponse(json_data=["note-taker"]), calls=calls
    )
    assert await get_user_agent_skills(user_id="u", agent_id="a1") == ["note-taker"]
    assert calls[0][0] == "GET"
