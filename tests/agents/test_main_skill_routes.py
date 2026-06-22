from __future__ import annotations

from types import SimpleNamespace

import httpx
import pytest


def _custom_body(name: str, description: str = "from api", extra_files=None):
    files = [{"path": "SKILL.md", "content": "api body", "encoding": "utf-8"}]
    for f in extra_files or []:
        files.append(f)
    return {"name": name, "description": description, "files": files}


# ---------------------------------------------------------------------------
# GET /skills/global
# ---------------------------------------------------------------------------
async def test_get_global_skills_lists_catalog(client, skills_fs, internal_headers):
    response = await client.get("/skills/global", headers=internal_headers)
    assert response.status_code == 200
    body = response.json()
    names = sorted(item["name"] for item in body)
    assert names == ["deep-research", "design-system"]
    research = next(i for i in body if i["name"] == "deep-research")
    assert research["category"] == "research"
    assert "deep research" in research["content"]


async def test_get_global_skills_bypass_cache_reindexes(client, skills_fs, internal_headers):
    # Drop a new skill onto the volume after the cache was warmed.
    new_dir = skills_fs.global_root / "ops" / "deploy-helper"
    new_dir.mkdir(parents=True, exist_ok=True)
    (new_dir / "SKILL.md").write_text("---\nname: deploy-helper\ndescription: ops\n---\nbody", encoding="utf-8")

    cached = await client.get("/skills/global", headers=internal_headers)
    assert "deploy-helper" not in {i["name"] for i in cached.json()}

    refreshed = await client.get("/skills/global?bypass_cache=true", headers=internal_headers)
    assert "deploy-helper" in {i["name"] for i in refreshed.json()}


# ---------------------------------------------------------------------------
# GET /users/{user_id}/skills
# ---------------------------------------------------------------------------
async def test_get_user_skill_pool_empty(client, skills_fs, internal_headers):
    response = await client.get("/users/user-1/skills", headers=internal_headers)
    assert response.status_code == 200
    assert response.json() == []


async def test_get_user_skill_pool_after_add(client, skills_fs, internal_headers):
    add = await client.post("/users/user-1/skills/global/deep-research", headers=internal_headers)
    assert add.status_code == 204

    response = await client.get("/users/user-1/skills", headers=internal_headers)
    assert response.status_code == 200
    body = response.json()
    assert [item["name"] for item in body] == ["deep-research"]
    assert body[0]["type"] == "global"


# ---------------------------------------------------------------------------
# GET /users/{user_id}/skills/{skill_name}
# ---------------------------------------------------------------------------
async def test_get_user_skill_detail_success(client, skills_fs, internal_headers):
    await client.post("/users/user-1/skills/global/deep-research", headers=internal_headers)
    response = await client.get("/users/user-1/skills/deep-research", headers=internal_headers)
    assert response.status_code == 200
    body = response.json()
    assert body["name"] == "deep-research"
    assert body["type"] == "global"
    assert "deep research" in body["content"]


async def test_get_user_skill_detail_404(client, skills_fs, internal_headers):
    response = await client.get("/users/user-1/skills/missing", headers=internal_headers)
    assert response.status_code == 404


# ---------------------------------------------------------------------------
# POST /users/{user_id}/skills/global/{skill_name}
# ---------------------------------------------------------------------------
async def test_add_global_skill_204(client, skills_fs, internal_headers):
    response = await client.post("/users/user-1/skills/global/design-system", headers=internal_headers)
    assert response.status_code == 204


async def test_add_global_skill_unknown_404(client, skills_fs, internal_headers):
    response = await client.post("/users/user-1/skills/global/no-such", headers=internal_headers)
    assert response.status_code == 404


async def test_add_global_skill_conflict_409(client, skills_fs, internal_headers):
    await client.post("/users/user-1/skills/global/deep-research", headers=internal_headers)
    response = await client.post("/users/user-1/skills/global/deep-research", headers=internal_headers)
    assert response.status_code == 409


# ---------------------------------------------------------------------------
# POST /users/{user_id}/skills/custom
# ---------------------------------------------------------------------------
async def test_create_custom_skill_201(client, skills_fs, internal_headers):
    response = await client.post(
        "/users/user-1/skills/custom",
        headers=internal_headers,
        json=_custom_body("my-custom", extra_files=[{"path": "notes.md", "content": "x", "encoding": "utf-8"}]),
    )
    assert response.status_code == 201
    body = response.json()
    assert body["name"] == "my-custom"
    assert body["type"] == "custom"


async def test_create_custom_skill_conflict_with_global_409(client, skills_fs, internal_headers):
    response = await client.post(
        "/users/user-1/skills/custom",
        headers=internal_headers,
        json=_custom_body("deep-research"),
    )
    assert response.status_code == 409


async def test_create_custom_skill_conflict_with_pool_409(client, skills_fs, internal_headers):
    await client.post("/users/user-1/skills/custom", headers=internal_headers, json=_custom_body("dup"))
    response = await client.post("/users/user-1/skills/custom", headers=internal_headers, json=_custom_body("dup"))
    assert response.status_code == 409


async def test_create_custom_skill_missing_skill_md_422(client, skills_fs, internal_headers):
    response = await client.post(
        "/users/user-1/skills/custom",
        headers=internal_headers,
        json={"name": "no-entry", "files": [{"path": "notes.md", "content": "x", "encoding": "utf-8"}]},
    )
    assert response.status_code == 422


async def test_create_custom_skill_bad_base64_422(client, skills_fs, internal_headers):
    response = await client.post(
        "/users/user-1/skills/custom",
        headers=internal_headers,
        json=_custom_body("bad", extra_files=[{"path": "img.png", "content": "!!!", "encoding": "base64"}]),
    )
    assert response.status_code == 422


# ---------------------------------------------------------------------------
# DELETE /users/{user_id}/skills/{skill_name}
# ---------------------------------------------------------------------------
async def test_delete_user_skill_204(client, skills_fs, internal_headers):
    await client.post("/users/user-1/skills/global/deep-research", headers=internal_headers)
    response = await client.delete("/users/user-1/skills/deep-research", headers=internal_headers)
    assert response.status_code == 204

    pool = await client.get("/users/user-1/skills", headers=internal_headers)
    assert pool.json() == []


async def test_delete_missing_user_skill_is_idempotent_204(client, skills_fs, internal_headers):
    response = await client.delete("/users/user-1/skills/never-existed", headers=internal_headers)
    assert response.status_code == 204


# ---------------------------------------------------------------------------
# GET/PUT/DELETE /agents/{slug}/users/{user_id}/skills[/{skill_name}]
# ---------------------------------------------------------------------------
async def test_get_user_agent_skills_empty(client, skills_fs, internal_headers):
    response = await client.get("/agents/omni/users/user-1/skills", headers=internal_headers)
    assert response.status_code == 200
    assert response.json() == []


async def test_enable_and_list_user_agent_skill(client, skills_fs, internal_headers):
    await client.post("/users/user-1/skills/global/deep-research", headers=internal_headers)

    enable = await client.put("/agents/omni/users/user-1/skills/deep-research", headers=internal_headers)
    assert enable.status_code == 204

    listing = await client.get("/agents/omni/users/user-1/skills", headers=internal_headers)
    assert listing.status_code == 200
    assert listing.json() == ["deep-research"]


async def test_enable_user_agent_skill_not_in_pool_404(client, skills_fs, internal_headers):
    response = await client.put("/agents/omni/users/user-1/skills/deep-research", headers=internal_headers)
    assert response.status_code == 404


async def test_disable_user_agent_skill_204(client, skills_fs, internal_headers):
    await client.post("/users/user-1/skills/global/deep-research", headers=internal_headers)
    await client.put("/agents/omni/users/user-1/skills/deep-research", headers=internal_headers)

    disable = await client.delete("/agents/omni/users/user-1/skills/deep-research", headers=internal_headers)
    assert disable.status_code == 204

    listing = await client.get("/agents/omni/users/user-1/skills", headers=internal_headers)
    assert listing.json() == []


async def test_disable_unassigned_user_agent_skill_is_idempotent_204(client, skills_fs, internal_headers):
    response = await client.delete("/agents/omni/users/user-1/skills/deep-research", headers=internal_headers)
    assert response.status_code == 204


async def test_skill_routes_require_internal_caller(client, skills_fs):
    response = await client.get("/skills/global")
    assert response.status_code == 403


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
    monkeypatch.setattr(agents_service.main.httpx, "AsyncClient", lambda *a, **k: _FakeAsyncClient())

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
    monkeypatch.setattr(agents_service.main.httpx, "AsyncClient", lambda *a, **k: _FakeAsyncClient())

    response = await client.post(
        "/realtime/session",
        headers=internal_headers,
        json={"sdp": "v=0\r\noffer", "voice": "not-a-voice"},
    )
    assert response.status_code == 200
    assert response.json()["voice"] == "alloy"


async def test_realtime_session_unconfigured_503(client, agents_service, internal_headers, monkeypatch):
    monkeypatch.setattr(agents_service.main.settings.api_keys, "openai", None)

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
    monkeypatch.setattr(agents_service.main.httpx, "AsyncClient", lambda *a, **k: _FakeAsyncClient(raise_exc=exc))

    response = await client.post(
        "/realtime/session",
        headers=internal_headers,
        json={"sdp": "v=0\r\noffer"},
    )
    assert response.status_code == 502


async def test_realtime_session_request_error_502(client, agents_service, internal_headers, monkeypatch):
    request = httpx.Request("POST", "https://api.openai.com/v1/realtime/calls")
    exc = httpx.ConnectError("unreachable", request=request)
    monkeypatch.setattr(agents_service.main.httpx, "AsyncClient", lambda *a, **k: _FakeAsyncClient(raise_exc=exc))

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
        return f"data: error {exc}\n\n".encode("utf-8")


class _NoInterruptResumeAgent(_FakeResumeAgent):
    """Durable checkpoint exists but no interrupt is parked → resume 409s."""
    interrupts: list = []


def _resume_env(agents_service, monkeypatch, agent_cls=_FakeResumeAgent, has_cp=True):
    # has_cp=False ⇒ the checkpoint has no pending interrupt (409), modelled by
    # an agent whose aget_state returns empty interrupts.
    if not has_cp and agent_cls is _FakeResumeAgent:
        agent_cls = _NoInterruptResumeAgent
    registry = {"omni": SimpleNamespace(cls=agent_cls, manifest={})}
    monkeypatch.setattr(agents_service.main, "AGENT_REGISTRY", registry)
    monkeypatch.setattr(agents_service.main, "mcp_session_context", lambda: _FakeSessionContext())

    async def fake_load_mcp_tools(session):
        return [{"name": "sql_query"}]

    monkeypatch.setattr(agents_service.main, "load_mcp_tools", fake_load_mcp_tools)
    # The durable saver is wired in the lifespan (not run under ASGITransport),
    # so force the readiness probe true.
    monkeypatch.setattr(agents_service.main, "has_checkpointer_initialized", lambda: True)

    async def fake_release_unless_paused(agent, run_id):
        return None

    monkeypatch.setattr(agents_service.main, "release_checkpoint_unless_paused", fake_release_unless_paused)


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
