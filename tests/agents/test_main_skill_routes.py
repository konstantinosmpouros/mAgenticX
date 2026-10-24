from __future__ import annotations

from types import SimpleNamespace
from typing import ClassVar

import httpx
import pytest


def _custom_body(name: str, description: str = "from api", extra_files=None):
    files = [{"path": "SKILL.md", "content": "api body", "encoding": "utf-8"}]
    for f in extra_files or []:
        files.append(f)
    return {"name": name, "description": description, "files": files}


def _catalogue_row(agents_service, skill_id: str, *, refusal=None, description="A remote skill"):
    """A catalogue row as the sync writes it."""
    return agents_service.skill_store.CatalogueEntry(
        skill_id=skill_id, name=skill_id, description=description, licence="MIT",
        source_ref="c" * 40, entry_path=f"skills/{skill_id}", meta_sha="m",
        content_ref="ref-" + skill_id, refusal=refusal,
    )


async def _seed_catalogue(agents_service, store, source_id="ecc", rows=()):
    await store.apply_source_sync(source_id, source_ref="c" * 40, entries=list(rows), manifests=None)


def _enable_remote(agents_service, monkeypatch, enabled=True):
    monkeypatch.setattr(agents_service.settings_module.settings.remote_skills, "enabled", enabled)


# ---------------------------------------------------------------------------
# The bundled catalogue is gone (plan 30)
# ---------------------------------------------------------------------------
async def test_the_bundled_catalogue_routes_no_longer_exist(client, skill_store_memory, internal_headers):
    assert (await client.get("/skills/global", headers=internal_headers)).status_code == 404
    added = await client.post("/users/user-1/skills/global/deep-research", headers=internal_headers)
    assert added.status_code in (404, 405)


# ---------------------------------------------------------------------------
# GET /skills/catalogue/search
# ---------------------------------------------------------------------------
async def test_search_returns_admitted_remote_rows_only(client, agents_service, skill_store_memory, internal_headers, monkeypatch):
    _enable_remote(agents_service, monkeypatch)
    await _seed_catalogue(agents_service, skill_store_memory, rows=[
        _catalogue_row(agents_service, "postgres-patterns"),
        _catalogue_row(agents_service, "postgres-secrets", refusal="no licence"),
    ])
    response = await client.get("/skills/catalogue/search?q=postgres", headers=internal_headers)
    assert response.status_code == 200
    body = response.json()
    assert [r["skill_id"] for r in body["results"]] == ["postgres-patterns"]
    assert body["total"] == 1 and body["remote_enabled"] is True
    hit = body["results"][0]
    assert hit["source_label"] == "affaan-m/ECC"
    assert hit["upstream_url"] == f"https://github.com/affaan-m/ECC/tree/{'c' * 40}/skills/postgres-patterns"


async def test_search_is_empty_while_remote_skills_are_off(client, agents_service, skill_store_memory, internal_headers, monkeypatch):
    """Nothing could be added from it, so the catalogue shows nothing at all."""
    _enable_remote(agents_service, monkeypatch, enabled=False)
    await _seed_catalogue(agents_service, skill_store_memory, rows=[_catalogue_row(agents_service, "postgres-patterns")])
    body = (await client.get("/skills/catalogue/search?q=postgres", headers=internal_headers)).json()
    assert body["results"] == [] and body["remote_enabled"] is False


async def test_search_never_returns_a_source_off_the_allowlist(client, agents_service, skill_store_memory, internal_headers, monkeypatch):
    # Rows a removed source left behind must not resurface.
    _enable_remote(agents_service, monkeypatch)
    await _seed_catalogue(agents_service, skill_store_memory, source_id="gone", rows=[_catalogue_row(agents_service, "orphan")])
    assert (await client.get("/skills/catalogue/search?q=orphan", headers=internal_headers)).json()["results"] == []
    assert (await client.get("/skills/catalogue/search?q=orphan&source=gone", headers=internal_headers)).json()["results"] == []


async def test_search_refuses_malformed_parameters(client, agents_service, skill_store_memory, internal_headers, monkeypatch):
    _enable_remote(agents_service, monkeypatch)
    for query in ("limit=51", "limit=0", "offset=-1", "source=../x", "q=" + "x" * 201):
        response = await client.get(f"/skills/catalogue/search?{query}", headers=internal_headers)
        assert response.status_code == 422, query


# ---------------------------------------------------------------------------
# GET /skills/remote/sources
# ---------------------------------------------------------------------------
async def test_sources_lists_every_allowlisted_source(client, agents_service, skill_store_memory, internal_headers):
    await skill_store_memory.record_source_error("nvidia", "timeout")
    body = (await client.get("/skills/remote/sources", headers=internal_headers)).json()
    ids = [row["source_id"] for row in body]
    assert ids == [src.source_id for src in agents_service.remote_sources.SOURCES]
    assert next(r for r in body if r["source_id"] == "nvidia")["last_error"] == "timeout"


# ---------------------------------------------------------------------------
# POST /users/{user_id}/skills/remote/{source_id}/{skill_id}
# ---------------------------------------------------------------------------
async def test_remote_add_is_refused_while_the_feature_is_off(client, agents_service, skill_store_memory, internal_headers, monkeypatch):
    _enable_remote(agents_service, monkeypatch, enabled=False)
    response = await client.post("/users/user-1/skills/remote/ecc/postgres-patterns", headers=internal_headers)
    assert response.status_code == 503
    assert skill_store_memory.pool == {}


async def test_remote_add_of_an_unknown_source_or_skill_is_404(client, agents_service, skill_store_memory, internal_headers, monkeypatch):
    _enable_remote(agents_service, monkeypatch)
    assert (await client.post("/users/user-1/skills/remote/nope/x", headers=internal_headers)).status_code == 404
    assert (await client.post("/users/user-1/skills/remote/ecc/never-synced", headers=internal_headers)).status_code == 404


async def test_a_refused_or_withdrawn_skill_cannot_be_added(client, agents_service, skill_store_memory, internal_headers, monkeypatch):
    """Same 404 as a missing skill: the refusal reason is not an oracle."""
    _enable_remote(agents_service, monkeypatch)
    await _seed_catalogue(agents_service, skill_store_memory, rows=[
        _catalogue_row(agents_service, "risky", refusal="risk=critical"),
        _catalogue_row(agents_service, "gone-soon"),
    ])
    await _seed_catalogue(agents_service, skill_store_memory, rows=[
        _catalogue_row(agents_service, "risky", refusal="risk=critical"),
    ])  # "gone-soon" is now withdrawn
    for skill in ("risky", "gone-soon"):
        response = await client.post(f"/users/user-1/skills/remote/ecc/{skill}", headers=internal_headers)
        assert response.status_code == 404, skill
    assert skill_store_memory.pool == {}


async def test_remote_add_downloads_once_then_shares_the_copy(client, agents_service, skill_store_memory, internal_headers, monkeypatch):
    _enable_remote(agents_service, monkeypatch)
    await _seed_catalogue(agents_service, skill_store_memory, rows=[_catalogue_row(agents_service, "postgres-patterns")])
    fetches = []

    async def fake_fetch(store, client_, source, entry):
        fetches.append(entry["skill_id"])
        return {"SKILL.md": ("---\nname: postgres-patterns\ndescription: d\n---\nbody", "utf-8", "f" * 64)}

    monkeypatch.setattr(agents_service.user_registry, "fetch_remote_copy", fake_fetch)

    first = await client.post("/users/user-1/skills/remote/ecc/postgres-patterns", headers=internal_headers)
    assert first.status_code == 201
    body = first.json()
    assert body["type"] == "remote"
    assert body["provenance"]["licence"] == "MIT"
    assert body["provenance"]["commit"] == "c" * 40

    second_user = await client.post("/users/user-2/skills/remote/ecc/postgres-patterns", headers=internal_headers)
    assert second_user.status_code == 201
    assert fetches == ["postgres-patterns"]          # the second Add downloaded nothing
    assert skill_store_memory.copy_writes == 1

    detail = (await client.get("/users/user-2/skills/postgres-patterns", headers=internal_headers)).json()
    assert [f["path"] for f in detail["files"]] == ["SKILL.md"]

    again = await client.post("/users/user-1/skills/remote/ecc/postgres-patterns", headers=internal_headers)
    assert again.status_code == 409


async def test_remote_add_maps_verification_and_upstream_failures(client, agents_service, skill_store_memory, internal_headers, monkeypatch):
    _enable_remote(agents_service, monkeypatch)
    await _seed_catalogue(agents_service, skill_store_memory, rows=[_catalogue_row(agents_service, "postgres-patterns")])
    fetch = agents_service.remote_fetch

    async def refuse(*_a):
        raise fetch.RemoteSkillRefused("checksum mismatch")

    async def unreachable(*_a):
        raise fetch.RemoteSkillUnavailable("timeout")

    monkeypatch.setattr(agents_service.user_registry, "fetch_remote_copy", refuse)
    refused = await client.post("/users/user-1/skills/remote/ecc/postgres-patterns", headers=internal_headers)
    assert refused.status_code == 422 and "checksum mismatch" in refused.json()["detail"]

    monkeypatch.setattr(agents_service.user_registry, "fetch_remote_copy", unreachable)
    down = await client.post("/users/user-1/skills/remote/ecc/postgres-patterns", headers=internal_headers)
    assert down.status_code == 502
    assert skill_store_memory.pool == {}              # nothing stored on either failure


async def test_remote_add_refuses_malformed_ids(client, agents_service, skill_store_memory, internal_headers, monkeypatch):
    _enable_remote(agents_service, monkeypatch)
    for bad in ("ECC/x", "ecc/Has-Caps", "ecc/-lead", "ecc/a_b"):
        response = await client.post(f"/users/user-1/skills/remote/{bad}", headers=internal_headers)
        assert response.status_code in (404, 422), bad


# ---------------------------------------------------------------------------
# GET /users/{user_id}/skills
# ---------------------------------------------------------------------------
async def test_get_user_skill_pool_empty(client, skill_store_memory, skills_fs, internal_headers):
    response = await client.get("/users/user-1/skills", headers=internal_headers)
    assert response.status_code == 200
    assert response.json() == []


async def test_get_user_skill_pool_after_add(client, skill_store_memory, skills_fs, internal_headers):
    add = await client.post("/users/user-1/skills/custom", headers=internal_headers, json=_custom_body("my-skill"))
    assert add.status_code == 201

    response = await client.get("/users/user-1/skills", headers=internal_headers)
    assert response.status_code == 200
    body = response.json()
    assert [item["name"] for item in body] == ["my-skill"]
    assert body[0]["type"] == "custom"


async def test_a_legacy_global_entry_still_lists_and_reads(client, skill_store_memory, skills_fs, internal_headers):
    """A pre-plan-30 pool row must not 500 the pool listing or the detail read."""
    await skill_store_memory.add_global("user-1", "deep-research", category="research")
    listing = (await client.get("/users/user-1/skills", headers=internal_headers)).json()
    assert [(i["name"], i["type"]) for i in listing] == [("deep-research", "global")]
    detail = await client.get("/users/user-1/skills/deep-research", headers=internal_headers)
    assert detail.status_code == 200 and "deep research" in detail.json()["content"]


# ---------------------------------------------------------------------------
# GET /users/{user_id}/skills/{skill_name}
# ---------------------------------------------------------------------------
async def test_get_user_skill_detail_success(client, skill_store_memory, skills_fs, internal_headers):
    await client.post("/users/user-1/skills/custom", headers=internal_headers, json=_custom_body("my-skill"))
    response = await client.get("/users/user-1/skills/my-skill", headers=internal_headers)
    assert response.status_code == 200
    body = response.json()
    assert body["name"] == "my-skill"
    assert body["type"] == "custom"
    assert "api body" in body["content"]


async def test_get_user_skill_detail_404(client, skill_store_memory, skills_fs, internal_headers):
    response = await client.get("/users/user-1/skills/missing", headers=internal_headers)
    assert response.status_code == 404


# ---------------------------------------------------------------------------
# POST /users/{user_id}/skills/custom
# ---------------------------------------------------------------------------
async def test_create_custom_skill_201(client, skill_store_memory, skills_fs, internal_headers):
    response = await client.post(
        "/users/user-1/skills/custom",
        headers=internal_headers,
        json=_custom_body("my-custom", extra_files=[{"path": "notes.md", "content": "x", "encoding": "utf-8"}]),
    )
    assert response.status_code == 201
    body = response.json()
    assert body["name"] == "my-custom"
    assert body["type"] == "custom"


async def test_create_custom_skill_conflict_with_pool_409(client, skill_store_memory, skills_fs, internal_headers):
    await client.post("/users/user-1/skills/custom", headers=internal_headers, json=_custom_body("dup"))
    response = await client.post("/users/user-1/skills/custom", headers=internal_headers, json=_custom_body("dup"))
    assert response.status_code == 409


async def test_create_custom_skill_missing_skill_md_422(client, skill_store_memory, skills_fs, internal_headers):
    response = await client.post(
        "/users/user-1/skills/custom",
        headers=internal_headers,
        json={"name": "no-entry", "files": [{"path": "notes.md", "content": "x", "encoding": "utf-8"}]},
    )
    assert response.status_code == 422


async def test_create_custom_skill_bad_base64_422(client, skill_store_memory, skills_fs, internal_headers):
    response = await client.post(
        "/users/user-1/skills/custom",
        headers=internal_headers,
        json=_custom_body("bad", extra_files=[{"path": "img.png", "content": "!!!", "encoding": "base64"}]),
    )
    assert response.status_code == 422


# ---------------------------------------------------------------------------
# DELETE /users/{user_id}/skills/{skill_name}
# ---------------------------------------------------------------------------
async def test_delete_user_skill_204(client, skill_store_memory, skills_fs, internal_headers):
    await client.post("/users/user-1/skills/custom", headers=internal_headers, json=_custom_body("my-skill"))
    response = await client.delete("/users/user-1/skills/my-skill", headers=internal_headers)
    assert response.status_code == 204

    pool = await client.get("/users/user-1/skills", headers=internal_headers)
    assert pool.json() == []


async def test_delete_missing_user_skill_is_idempotent_204(client, skill_store_memory, skills_fs, internal_headers):
    response = await client.delete("/users/user-1/skills/never-existed", headers=internal_headers)
    assert response.status_code == 204


# ---------------------------------------------------------------------------
# GET/PUT/DELETE /agents/{slug}/users/{user_id}/skills[/{skill_name}]
# ---------------------------------------------------------------------------
async def test_get_user_agent_skills_empty(client, skill_store_memory, skills_fs, internal_headers):
    response = await client.get("/agents/omni/users/user-1/skills", headers=internal_headers)
    assert response.status_code == 200
    assert response.json() == []


async def test_enable_and_list_user_agent_skill(client, skill_store_memory, skills_fs, internal_headers):
    await client.post("/users/user-1/skills/custom", headers=internal_headers, json=_custom_body("my-skill"))

    enable = await client.put("/agents/omni/users/user-1/skills/my-skill", headers=internal_headers)
    assert enable.status_code == 204

    listing = await client.get("/agents/omni/users/user-1/skills", headers=internal_headers)
    assert listing.status_code == 200
    assert listing.json() == ["my-skill"]


async def test_enable_user_agent_skill_not_in_pool_404(client, skill_store_memory, skills_fs, internal_headers):
    response = await client.put("/agents/omni/users/user-1/skills/my-skill", headers=internal_headers)
    assert response.status_code == 404


async def test_disable_user_agent_skill_204(client, skill_store_memory, skills_fs, internal_headers):
    await client.post("/users/user-1/skills/custom", headers=internal_headers, json=_custom_body("my-skill"))
    await client.put("/agents/omni/users/user-1/skills/my-skill", headers=internal_headers)

    disable = await client.delete("/agents/omni/users/user-1/skills/my-skill", headers=internal_headers)
    assert disable.status_code == 204

    listing = await client.get("/agents/omni/users/user-1/skills", headers=internal_headers)
    assert listing.json() == []


async def test_disable_unassigned_user_agent_skill_is_idempotent_204(client, skill_store_memory, skills_fs, internal_headers):
    response = await client.delete("/agents/omni/users/user-1/skills/my-skill", headers=internal_headers)
    assert response.status_code == 204


async def test_skill_routes_require_internal_caller(client, skill_store_memory, skills_fs):
    for path in ("/skills/catalogue/search", "/skills/remote/sources", "/users/user-1/skills"):
        assert (await client.get(path)).status_code == 403, path
    assert (await client.post("/users/user-1/skills/remote/ecc/x")).status_code == 403


# ---------------------------------------------------------------------------
# POST /realtime/session
# ---------------------------------------------------------------------------
class _FakeResponse:
    def __init__(self, text="v=0\r\nanswer-sdp", status_code=200):
        self.text = text
        self.status_code = status_code

    def raise_for_status(self):
        return None

    def json(self):
        return {"error": "bad"}


class _FakeAsyncClient:
    def __init__(self, response=None, raise_exc=None, *args, **kwargs):
        self._response = response or _FakeResponse()
        self._raise_exc = raise_exc

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def post(self, url, headers=None, files=None):
        if self._raise_exc is not None:
            raise self._raise_exc
        return self._response


async def test_realtime_session_success(client, agents_service, internal_headers, monkeypatch):
    monkeypatch.setattr(agents_service.router_voice.httpx, "AsyncClient", lambda *a, **k: _FakeAsyncClient())

    response = await client.post(
        "/realtime/session",
        headers=internal_headers,
        json={"sdp": "v=0\r\noffer", "voice": "verse"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["sdp"] == "v=0\r\nanswer-sdp"
    assert body["voice"] == "verse"


async def test_realtime_session_normalizes_unknown_voice(client, agents_service, internal_headers, monkeypatch):
    monkeypatch.setattr(agents_service.router_voice.httpx, "AsyncClient", lambda *a, **k: _FakeAsyncClient())

    response = await client.post(
        "/realtime/session",
        headers=internal_headers,
        json={"sdp": "v=0\r\noffer", "voice": "not-a-voice"},
    )
    assert response.status_code == 200
    assert response.json()["voice"] == "alloy"


async def test_realtime_session_unconfigured_503(client, agents_service, internal_headers, monkeypatch):
    monkeypatch.setattr(agents_service.settings_module.settings.api_keys, "openai", None)

    response = await client.post(
        "/realtime/session",
        headers=internal_headers,
        json={"sdp": "v=0\r\noffer"},
    )
    assert response.status_code == 503


async def test_realtime_session_upstream_http_error_502(client, agents_service, internal_headers, monkeypatch):
    request = httpx.Request("POST", "https://api.openai.com/v1/realtime/calls")
    err_response = httpx.Response(400, request=request, json={"error": "bad offer"})
    exc = httpx.HTTPStatusError("bad", request=request, response=err_response)
    monkeypatch.setattr(agents_service.router_voice.httpx, "AsyncClient", lambda *a, **k: _FakeAsyncClient(raise_exc=exc))

    response = await client.post(
        "/realtime/session",
        headers=internal_headers,
        json={"sdp": "v=0\r\noffer"},
    )
    assert response.status_code == 502


async def test_realtime_session_request_error_502(client, agents_service, internal_headers, monkeypatch):
    request = httpx.Request("POST", "https://api.openai.com/v1/realtime/calls")
    exc = httpx.ConnectError("unreachable", request=request)
    monkeypatch.setattr(agents_service.router_voice.httpx, "AsyncClient", lambda *a, **k: _FakeAsyncClient(raise_exc=exc))

    response = await client.post(
        "/realtime/session",
        headers=internal_headers,
        json={"sdp": "v=0\r\noffer"},
    )
    assert response.status_code == 502


# ---------------------------------------------------------------------------
# POST /agents/{slug}/resume
# ---------------------------------------------------------------------------
class _FakeSessionContext:
    async def __aenter__(self):
        return object()

    async def __aexit__(self, exc_type, exc, tb):
        return False


class _FakeInterrupt:
    def __init__(self, interrupt_id="int-1", action_requests=None):
        self.id = interrupt_id
        self.value = {"action_requests": action_requests or [{"action": "a"}]}


class _FakeCompiled:
    def __init__(self, interrupts):
        self._interrupts = interrupts

    async def aget_state(self, config):
        # Durable saver is async; carry a config so the terminal
        # CHECKPOINT_COMMITTED emission can read a checkpoint_id.
        return SimpleNamespace(
            interrupts=self._interrupts,
            config={"configurable": {"checkpoint_id": "cp-1"}},
        )


class _FakeResumeAgent:
    interrupts = [_FakeInterrupt()]
    captured_command: dict = {}

    def __init__(self, config=None):
        self.config = config
        self.run_config = {}
        self.compiled = _FakeCompiled(type(self).interrupts)
        self.tools_names = []

    async def ensure_built(self):
        return None

    def attach_tools(self, tools):
        self.tools_names = [t.get("name", "") for t in tools]

    async def astream(self, payload, command=None):
        type(self).captured_command["command"] = command
        yield b"data: resumed\n\n"

    def _encode_run_error(self, exc):
        return f"data: error {exc}\n\n".encode()


class _NoInterruptResumeAgent(_FakeResumeAgent):
    """Durable checkpoint exists but no interrupt is parked → resume 409s."""
    interrupts: list = []


def _patch_agent_resolver(agents_service, monkeypatch, registry):
    """Point the inference router's agent lookup at a fake registry.

    The router resolves through `resolve_agent_definition(slug, owner_user_id)`
    so a user-authored agent can be loaded from its owner's rows, so tests patch
    that seam rather than a module-level registry dict. `owner_user_id` is
    ignored here — these tests exercise platform agents.

    The seam is **async**: a user-authored definition is a database read, so the
    lookup awaits even though the platform branch it serves here is a dict hit.
    """

    async def _resolve(slug, owner_user_id=None):
        return registry.get(slug)

    monkeypatch.setattr(
        agents_service.router_inference, "resolve_agent_definition", _resolve
    )


def _resume_env(agents_service, monkeypatch, agent_cls=_FakeResumeAgent, has_cp=True):
    # has_cp=False ⇒ the checkpoint has no pending interrupt (409), modelled by
    # an agent whose aget_state returns empty interrupts.
    if not has_cp and agent_cls is _FakeResumeAgent:
        agent_cls = _NoInterruptResumeAgent
    registry = {"omni": agents_service.schemas.AgentDefinition(slug="omni", cls=agent_cls, manifest={})}
    _patch_agent_resolver(agents_service, monkeypatch, registry)
    monkeypatch.setattr(agents_service.router_inference, "optional_mcp_session", lambda: _FakeSessionContext())

    async def fake_load_mcp_tools(session):
        return [{"name": "sql_query"}]

    monkeypatch.setattr(agents_service.router_inference, "load_mcp_tools", fake_load_mcp_tools)
    # The durable saver is wired in the lifespan (not run under ASGITransport),
    # so force the readiness probe true.
    monkeypatch.setattr(agents_service.router_inference, "has_checkpointer_initialized", lambda: True)

    async def fake_release_unless_paused(agent, run_id):
        return None

    monkeypatch.setattr(agents_service.router_inference, "release_checkpoint_unless_paused", fake_release_unless_paused)


async def test_resume_requires_thread_id_400(client, agents_service, internal_headers, monkeypatch):
    _resume_env(agents_service, monkeypatch)
    response = await client.post(
        "/agents/omni/resume",
        headers=internal_headers,
        json={"config": {}, "thread_id": "", "decision": "approve"},
    )
    assert response.status_code == 400


async def test_resume_no_checkpoint_409(client, agents_service, internal_headers, monkeypatch):
    _resume_env(agents_service, monkeypatch, has_cp=False)
    response = await client.post(
        "/agents/omni/resume",
        headers=internal_headers,
        json={"config": {}, "thread_id": "t-1", "decision": "approve"},
    )
    assert response.status_code == 409


async def test_resume_unknown_agent_404(client, agents_service, internal_headers, monkeypatch):
    _resume_env(agents_service, monkeypatch)
    response = await client.post(
        "/agents/missing/resume",
        headers=internal_headers,
        json={"config": {}, "thread_id": "t-1", "decision": "approve"},
    )
    assert response.status_code == 404


async def test_resume_approve_streams(client, agents_service, internal_headers, monkeypatch):
    _resume_env(agents_service, monkeypatch)
    _FakeResumeAgent.captured_command = {}
    response = await client.post(
        "/agents/omni/resume",
        headers=internal_headers,
        json={"config": {"run_config": {"configurable": {}}}, "thread_id": "t-1", "decision": "approve"},
    )
    assert response.status_code == 200
    # The resume stream now ends with a terminal CHECKPOINT_COMMITTED frame.
    assert "data: resumed\n\n" in response.text
    cmd = _FakeResumeAgent.captured_command["command"]
    assert cmd.resume["decisions"][0]["type"] == "approve"


async def test_resume_reject_uses_reason(client, agents_service, internal_headers, monkeypatch):
    _resume_env(agents_service, monkeypatch)
    _FakeResumeAgent.captured_command = {}
    response = await client.post(
        "/agents/omni/resume",
        headers=internal_headers,
        json={"config": {}, "thread_id": "t-1", "decision": "reject", "reason": "no thanks"},
    )
    assert response.status_code == 200
    cmd = _FakeResumeAgent.captured_command["command"]
    assert cmd.resume["decisions"][0] == {"type": "reject", "message": "no thanks"}


class _BatchResumeAgent(_FakeResumeAgent):
    interrupts = [
        _FakeInterrupt(action_requests=[{"action": "write_file"}, {"action": "write_file"}]),
    ]


async def test_resume_batched_per_action_decisions(client, agents_service, internal_headers, monkeypatch):
    # A batched interrupt (2 gated tool calls) with a mixed per-action decisions
    # list must map positionally — approve #0, reject #1 — not replicate one.
    _resume_env(agents_service, monkeypatch, agent_cls=_BatchResumeAgent)
    _BatchResumeAgent.captured_command = {}
    response = await client.post(
        "/agents/omni/resume",
        headers=internal_headers,
        json={
            "config": {"run_config": {"configurable": {}}},
            "thread_id": "t-1",
            "decision": "approve",
            "decisions": [
                {"decision": "approve"},
                {"decision": "reject", "reason": "wrong path"},
            ],
        },
    )
    assert response.status_code == 200
    cmd = _BatchResumeAgent.captured_command["command"]
    assert cmd.resume["decisions"] == [
        {"type": "approve"},
        {"type": "reject", "message": "wrong path"},
    ]


async def test_resume_decisions_count_mismatch_422(client, agents_service, internal_headers, monkeypatch):
    # 2 pending actions but only 1 decision → 422 (guards the LangChain
    # ValueError from leaking as a 500).
    _resume_env(agents_service, monkeypatch, agent_cls=_BatchResumeAgent)
    response = await client.post(
        "/agents/omni/resume",
        headers=internal_headers,
        json={
            "config": {"run_config": {"configurable": {}}},
            "thread_id": "t-1",
            "decision": "approve",
            "decisions": [{"decision": "approve"}],
        },
    )
    assert response.status_code == 422


class _AskUserInterrupt:
    def __init__(self, interrupt_id="int-ask"):
        self.id = interrupt_id
        self.value = {
            "type": "ask_user",
            "questions": [
                {"id": "q1", "question": "Which period?", "options": ["Q3", "Q4"], "multiple": False},
                {"id": "q2", "question": "Anything else?", "options": [], "multiple": False},
            ],
        }


class _AskUserResumeAgent(_FakeResumeAgent):
    interrupts: ClassVar[list] = [_AskUserInterrupt()]


def _ask_user_resume(client, internal_headers, **body):
    return client.post(
        "/agents/omni/resume",
        headers=internal_headers,
        json={"config": {"run_config": {"configurable": {}}}, "thread_id": "t-1", **body},
    )


async def test_resume_ask_user_answers_become_the_resume_value(client, agents_service, internal_headers, monkeypatch):
    _resume_env(agents_service, monkeypatch, agent_cls=_AskUserResumeAgent)
    _AskUserResumeAgent.captured_command = {}
    response = await _ask_user_resume(
        client,
        internal_headers,
        decision="approve",
        interrupt_id="int-ask",
        value={"answers": [{"id": "q1", "selected": ["Q4"], "text": "and Q1 next year"}]},
    )
    assert response.status_code == 200
    cmd = _AskUserResumeAgent.captured_command["command"]
    # Not approval decisions: the tool itself reads this.
    assert cmd.resume == {
        "answers": [{"id": "q1", "selected": ["Q4"], "text": "and Q1 next year"}],
        "skipped": False,
    }


async def test_resume_ask_user_reject_is_a_skip(client, agents_service, internal_headers, monkeypatch):
    _resume_env(agents_service, monkeypatch, agent_cls=_AskUserResumeAgent)
    _AskUserResumeAgent.captured_command = {}
    response = await _ask_user_resume(client, internal_headers, decision="reject", value={"answers": "ignored"})
    assert response.status_code == 200
    assert _AskUserResumeAgent.captured_command["command"].resume == {"answers": [], "skipped": True}


@pytest.mark.parametrize(
    "value",
    [
        None,
        {"answers": "nope"},
        {"answers": [{"id": "q7", "selected": []}]},
        {"answers": [{"id": "q1", "selected": "Q3"}]},
    ],
)
async def test_resume_ask_user_malformed_value_422(client, agents_service, internal_headers, monkeypatch, value):
    _resume_env(agents_service, monkeypatch, agent_cls=_AskUserResumeAgent)
    _AskUserResumeAgent.captured_command = {}
    response = await _ask_user_resume(client, internal_headers, decision="approve", value=value)
    assert response.status_code == 422
    assert _AskUserResumeAgent.captured_command == {}


class _TwoAskUserResumeAgent(_FakeResumeAgent):
    interrupts: ClassVar[list] = [_AskUserInterrupt("a" * 32), _AskUserInterrupt("b" * 32)]


async def test_resume_ask_user_with_two_pauses_answers_the_first_by_id(client, agents_service, internal_headers, monkeypatch):
    # LangGraph refuses a bare resume value while several interrupts are pending.
    _resume_env(agents_service, monkeypatch, agent_cls=_TwoAskUserResumeAgent)
    _TwoAskUserResumeAgent.captured_command = {}
    response = await _ask_user_resume(client, internal_headers, decision="reject")
    assert response.status_code == 200
    assert _TwoAskUserResumeAgent.captured_command["command"].resume == {"a" * 32: {"answers": [], "skipped": True}}


async def test_resume_no_pending_interrupt_409(client, agents_service, internal_headers, monkeypatch):
    class _NoInterruptAgent(_FakeResumeAgent):
        interrupts: list = []

    _resume_env(agents_service, monkeypatch, agent_cls=_NoInterruptAgent)
    response = await client.post(
        "/agents/omni/resume",
        headers=internal_headers,
        json={"config": {}, "thread_id": "t-1", "decision": "approve"},
    )
    assert response.status_code == 409


async def test_resume_stale_interrupt_id_409(client, agents_service, internal_headers, monkeypatch):
    _resume_env(agents_service, monkeypatch)
    response = await client.post(
        "/agents/omni/resume",
        headers=internal_headers,
        json={
            "config": {},
            "thread_id": "t-1",
            "decision": "approve",
            "interrupt_id": "different-id",
        },
    )
    assert response.status_code == 409


async def test_resume_state_load_failure_500(client, agents_service, internal_headers, monkeypatch):
    class _StateFailAgent(_FakeResumeAgent):
        async def ensure_built(self):
            raise RuntimeError("checkpoint gone")

    _resume_env(agents_service, monkeypatch, agent_cls=_StateFailAgent)
    response = await client.post(
        "/agents/omni/resume",
        headers=internal_headers,
        json={"config": {}, "thread_id": "t-1", "decision": "approve"},
    )
    assert response.status_code == 500


async def test_resume_init_failure_400(client, agents_service, internal_headers, monkeypatch):
    class _InitFailAgent(_FakeResumeAgent):
        def __init__(self, config=None):
            raise RuntimeError("bad config")

    _resume_env(agents_service, monkeypatch, agent_cls=_InitFailAgent)
    response = await client.post(
        "/agents/omni/resume",
        headers=internal_headers,
        json={"config": {}, "thread_id": "t-1", "decision": "approve"},
    )
    assert response.status_code == 400


async def test_resume_stream_runtime_error_encoded(client, agents_service, internal_headers, monkeypatch):
    class _StreamFailAgent(_FakeResumeAgent):
        async def astream(self, payload, command=None):
            raise RuntimeError("resume broke")
            yield b""

    _resume_env(agents_service, monkeypatch, agent_cls=_StreamFailAgent)
    response = await client.post(
        "/agents/omni/resume",
        headers=internal_headers,
        json={"config": {}, "thread_id": "t-1", "decision": "approve"},
    )
    assert response.status_code == 200
    assert response.text == "data: error resume broke\n\n"
