"""Sandbox-execution lockdown invariants — and, since plan 11 phases 3–4, the
sandboxed ``execute`` that replaces the lockdown where a runner is configured.

While ``SANDBOX_EXECUTION_ENABLED`` is false there must be no code-execution
path: the workspace's composite default backend must not be sandbox-capable
(that is exactly what makes deepagents surface its built-in ``execute`` tool),
and the host-shell backend must never even be imported in service code. These
tests pin the invariant so a dependency bump or refactor cannot reopen it
silently.
"""
from __future__ import annotations

import base64
import importlib
import json
import re
import ssl
from pathlib import Path

import httpx
import pytest
import yaml
from deepagents.backends.protocol import SandboxBackendProtocol
from deepagents.middleware.filesystem import supports_execution
from deepagents.middleware.subagents import SubAgentMiddleware
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command
from pydantic import Field

ROOT = Path(__file__).resolve().parents[2]
AGENTS_SRC = ROOT / "magenticx" / "agents"

# Import statements are banned; comments explaining the ban are fine.
_IMPORT_RE = re.compile(r"^\s*(from\s+\S+\s+import\s+.*LocalShellBackend|import\s+.*LocalShellBackend)", re.MULTILINE)


def test_local_shell_backend_is_never_imported():
    """LocalShellBackend executes commands on the host process — its import is
    banned from the entire agents service, not just discouraged."""
    offenders: list[str] = []
    for path in AGENTS_SRC.rglob("*.py"):
        if "__pycache__" in path.parts:
            continue
        if _IMPORT_RE.search(path.read_text(encoding="utf-8", errors="ignore")):
            offenders.append(str(path.relative_to(ROOT)))
    assert not offenders, f"LocalShellBackend import found in: {offenders}"


def _files():
    package = importlib.import_module("harness.conversation_files")
    return package.ConversationFiles(
        user_id="user-1", conversation_id="conv-1", agent_slug="agent-1",
        store=package.ConversationFileStore(object()),
    )


def test_workspace_factory_builds_with_sandbox_execution_disabled(agents_service, skills_fs):
    """The normal path: flag off + the branch-scratch default builds cleanly."""
    workspace = importlib.import_module("harness.filesystem.workspace")
    assert agents_service.settings_module.settings.filesystem.sandbox_execution_enabled is False
    factory = workspace.build_workspace_backend(
        user_id="user-1", agent_slug="agent-1", files=_files(), use_memory=True
    )
    backend = factory(None)
    assert backend is not None


def test_workspace_factory_refuses_sandbox_default_when_disabled(
    agents_service, skills_fs, monkeypatch
):
    """The guard's teeth: if a refactor ever swaps the default backend for a
    sandbox-capable one while the flag is off, minting the backend must raise
    instead of silently exposing `execute`."""
    workspace = importlib.import_module("harness.filesystem.workspace")

    class _SandboxLookalike(workspace.BranchScratchBackend):
        """Default-backend subclass registered as a virtual SandboxBackendProtocol."""

    SandboxBackendProtocol.register(_SandboxLookalike)
    monkeypatch.setattr(workspace, "BranchScratchBackend", _SandboxLookalike)

    factory = workspace.build_workspace_backend(
        user_id="user-1", agent_slug="agent-1", files=_files(), use_memory=False
    )
    with pytest.raises(RuntimeError, match="SANDBOX_EXECUTION_ENABLED"):
        factory(None)


def test_execute_stays_a_reserved_tool_name(agents_service):
    """The built-in `execute` is injected by deepagents itself (never via
    self.tools), but dynamically-attached MCP tools are name-filtered against
    the builtin roster — 'execute' must stay in it so an external tool can't
    smuggle the name in."""
    builtins_mod = importlib.import_module("harness.tools.builtins")
    assert "execute" in builtins_mod.BUILTIN_BY_NAME
    assert builtins_mod.BUILTIN_BY_NAME["execute"].locked


def test_write_deny_ladder_regressions(agents_service):
    """The FilesystemPermission lockdown that is already load-bearing: input/
    (plus skills and the offload dirs) must stay write-denied."""
    workspace = importlib.import_module("harness.filesystem.workspace")

    def has_write_deny(path_fragment: str) -> bool:
        return any(
            rule.mode == "deny"
            and "write" in rule.operations
            and any(path_fragment in p for p in rule.paths)
            for rule in workspace.WORKSPACE_WRITE_DENY
        )

    assert has_write_deny("/conversation/input")
    assert has_write_deny("/skills")
    assert has_write_deny("/large_tool_results")
    assert has_write_deny("/conversation_history")


# ===========================================================================
# Plan 11 phases 3–4: `execute` through the sandbox runner, always approved
# ===========================================================================
# The runner is another service; here it is an httpx MockTransport speaking
# the contract (POST /v1/exec → {exit_code, stdout, stderr, truncated,
# duration_ms, killed_reason}). What is pinned is the agents side: when the
# backend exists, what it sends, what the model reads back, that an outage is
# an error result and never a fallback, and that no layer can run a command
# without the user's approval.
RUNNER_URL = "https://sandbox_runner:8090"
TRIAL_MODEL = "openai:gpt-5"
PROBE_MODEL = "openai:gpt-4.1-mini"


def _sandbox(agents_service):
    return importlib.import_module("harness.filesystem.sandbox_backend")


def _enable(agents_service, *, url: str = RUNNER_URL) -> None:
    fs = agents_service.settings_module.settings.filesystem
    fs.sandbox_execution_enabled = True
    fs.sandbox_runner_url = url


class _Runner:
    """A scripted sandbox runner: records every request, answers from a queue
    (the last answer repeats)."""

    def __init__(self, *answers):
        self.requests: list[httpx.Request] = []
        self._answers = list(answers) or [_ok()]

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        answer = self._answers.pop(0) if len(self._answers) > 1 else self._answers[0]
        if isinstance(answer, Exception):
            raise answer
        return answer

    @property
    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self)

    def bodies(self) -> list[dict]:
        return [json.loads(r.content) for r in self.requests]


class FakeInputs:
    """The bridge's view of the conversation's uploads (as in
    test_conversation_files_backend)."""

    def __init__(self, files: dict[str, bytes] | None = None, *, down: bool = False):
        self._files = files or {}
        self._down = down

    async def files(self):
        inputs = importlib.import_module("harness.conversation_files.inputs")
        if self._down:
            raise inputs.InputsUnavailable
        return {
            name: inputs.InputFile(name, f"att-{name}", len(data), "sha", "2026-11-03T10:00:00")
            for name, data in self._files.items()
        }

    async def read(self, name):
        await self.files()
        return self._files.get(name)


def _ok(**overrides) -> httpx.Response:
    body = {"exit_code": 0, "stdout": "hi\n", "stderr": "", "truncated": False,
            "duration_ms": 42, "killed_reason": None}
    body.update(overrides)
    return httpx.Response(200, json=body)


def _backend(agents_service, runner: _Runner, **identity):
    ids = {"user_id": "user-1", "agent_slug": "agent-1", "conversation_id": "conv-1", **identity}
    return _sandbox(agents_service).RemoteSandboxBackend(
        **ids, runner_url=RUNNER_URL, transport=runner.transport, async_transport=runner.transport
    )


def _wire_runner(agents_service, monkeypatch, runner: _Runner):
    """Make the workspace mint its sandbox backend against ``runner``."""
    workspace = importlib.import_module("harness.filesystem.workspace")
    real = _sandbox(agents_service).RemoteSandboxBackend

    class _Wired(real):
        def __init__(self, **kwargs):
            super().__init__(**kwargs, transport=runner.transport, async_transport=runner.transport)

    monkeypatch.setattr(workspace, "RemoteSandboxBackend", _Wired)
    return workspace


# ---------------------------------------------------------------------------
# Phase 3 — when the backend exists
# ---------------------------------------------------------------------------
def test_flag_off_keeps_the_state_backend_default(agents_service, skills_fs):
    workspace = importlib.import_module("harness.filesystem.workspace")
    # A runner URL alone is not enough: the kill switch decides.
    agents_service.settings_module.settings.filesystem.sandbox_runner_url = RUNNER_URL
    backend = workspace.build_workspace_backend(
        user_id="user-1", agent_slug="agent-1", files=_files(), use_memory=False
    )(None)
    assert type(backend.default) is workspace.BranchScratchBackend
    assert not isinstance(backend.default, SandboxBackendProtocol)
    assert not supports_execution(backend)


def test_flag_on_without_a_runner_url_stays_off(agents_service, skills_fs):
    workspace = importlib.import_module("harness.filesystem.workspace")
    fs = agents_service.settings_module.settings.filesystem
    fs.sandbox_execution_enabled = True
    fs.sandbox_runner_url = ""
    assert fs.sandbox_execution_active is False
    backend = workspace.build_workspace_backend(
        user_id="user-1", agent_slug="agent-1", files=_files(), use_memory=False
    )(None)
    assert type(backend.default) is workspace.BranchScratchBackend
    assert not supports_execution(backend)


def test_the_guard_still_fires_when_the_flag_is_on_but_no_runner_is_set(
    agents_service, skills_fs, monkeypatch
):
    """Half-configured is off — and the guard holds that too."""
    workspace = importlib.import_module("harness.filesystem.workspace")

    class _SandboxLookalike(workspace.BranchScratchBackend):
        pass

    SandboxBackendProtocol.register(_SandboxLookalike)
    monkeypatch.setattr(workspace, "BranchScratchBackend", _SandboxLookalike)
    agents_service.settings_module.settings.filesystem.sandbox_execution_enabled = True
    factory = workspace.build_workspace_backend(
        user_id="user-1", agent_slug="agent-1", files=_files(), use_memory=False
    )
    with pytest.raises(RuntimeError, match="SANDBOX_EXECUTION_ENABLED"):
        factory(None)


def test_enabled_makes_the_bound_sandbox_backend_the_default(agents_service, skills_fs):
    _enable(agents_service)
    workspace = importlib.import_module("harness.filesystem.workspace")
    sandbox = _sandbox(agents_service)
    backend = workspace.build_workspace_backend(
        user_id="user-1", agent_slug="agent-1", files=_files(), use_memory=True
    )(None)
    default = backend.default
    assert isinstance(default, sandbox.RemoteSandboxBackend)
    assert isinstance(default, SandboxBackendProtocol)
    assert supports_execution(backend)
    # File operations are the branch scratch store's — the same as with execution off.
    assert isinstance(default, workspace.BranchScratchBackend)
    # Bound to this run's identity, taken from the conversation files.
    assert (default._user_id, default._agent_slug, default._conversation_id) == ("user-1", "agent-1", "conv-1")
    # The id is stable and does not carry the raw identity.
    assert default.id.startswith("magenticx-sandbox-") and "user-1" not in default.id


async def test_execute_round_trips_with_identity_and_internal_auth(agents_service):
    runner = _Runner(_ok(stdout="hello\n", stderr="warn\n", exit_code=0))
    result = await _backend(agents_service, runner).aexecute("echo hello")

    [request] = runner.requests
    assert request.method == "POST"
    assert str(request.url) == f"{RUNNER_URL}/v1/exec"
    settings = agents_service.settings_module.settings
    header = settings.proxy.trusted_proxy_header_name
    assert request.headers[header] == settings.proxy.internal_service_secret.get_secret_value()
    assert json.loads(request.content) == {
        "user_id": "user-1",
        "agent_slug": "agent-1",
        "conversation_id": "conv-1",
        "command": "echo hello",
        "timeout_seconds": None,
        "workdir": "output",
    }
    assert result.exit_code == 0
    assert "hello" in result.output and "[stderr]\nwarn" in result.output
    assert result.truncated is False


def test_the_sync_path_round_trips_too(agents_service):
    runner = _Runner(_ok(exit_code=3, stdout="", stderr="boom"))
    result = _backend(agents_service, runner).execute("false", timeout=30)
    assert runner.bodies()[0]["timeout_seconds"] == 30
    assert result.exit_code == 3 and "boom" in result.output


async def test_a_zero_timeout_means_the_runners_default(agents_service):
    runner = _Runner()
    await _backend(agents_service, runner).aexecute("true", timeout=0)
    assert runner.bodies()[0]["timeout_seconds"] is None


async def test_the_client_uses_the_internal_tls_context(agents_service, monkeypatch):
    """mTLS: the client is built with the SSLContext (CA + client cert) every
    internal hop uses — not httpx's silently ignored ``cert=`` tuple."""
    sandbox = _sandbox(agents_service)
    marker = ssl.create_default_context()
    seen: dict = {}
    real_client = httpx.AsyncClient

    class _Recording(real_client):
        def __init__(self, **kwargs):
            seen.update(kwargs)
            super().__init__(**kwargs)

    monkeypatch.setattr(sandbox, "get_httpx_verify", lambda: marker)
    monkeypatch.setattr(sandbox.httpx, "AsyncClient", _Recording)
    await _backend(agents_service, _Runner()).aexecute("true")
    assert seen["verify"] is marker
    assert seen["cert"] is None


@pytest.mark.parametrize(
    ("reason", "words"),
    [
        ("timeout", "ran past its time limit"),
        ("memory", "ran out of memory"),
        ("output_limit", "more output than allowed"),
        ("disk_limit", "more to /conversation/output than allowed"),
        ("error", "sandbox failed while running it"),
    ],
)
async def test_a_killed_command_says_why_in_plain_words(agents_service, reason, words):
    runner = _Runner(_ok(exit_code=None, stdout="partial", killed_reason=reason,
                         truncated=reason == "output_limit"))
    result = await _backend(agents_service, runner).aexecute("run")
    assert words in result.output
    assert "partial" in result.output
    assert result.exit_code is None
    assert result.truncated is (reason == "output_limit")


async def test_runner_output_is_stripped_of_control_characters(agents_service):
    runner = _Runner(_ok(stdout="ok\x1b[31mred\x00\r\nnext\x07"))
    result = await _backend(agents_service, runner).aexecute("x")
    assert not any(c in result.output for c in ("\x1b", "\x00", "\x07", "\r"))
    assert "ok[31mred\nnext" in result.output


@pytest.mark.parametrize(
    ("answer", "words"),
    [
        (httpx.ConnectError("refused"), "unreachable"),
        (httpx.ReadTimeout("slow"), "did not answer in time"),
        (httpx.Response(503, json={"detail": "runsc unusable"}), "unavailable"),
        (httpx.Response(500, text="oops"), "HTTP 500"),
        (httpx.Response(422, json={"detail": "bad"}), "rejected the request"),
        (httpx.Response(403, json={"detail": "Forbidden"}), "HTTP 403"),
        (httpx.Response(200, text="not json"), "unreadable"),
        (httpx.Response(200, json={"exit_code": "zero"}), "unreadable"),
    ],
)
async def test_a_runner_failure_is_an_error_result_never_a_raise(agents_service, answer, words):
    runner = _Runner(answer)
    result = await _backend(agents_service, runner).aexecute("echo hi")
    assert result.output.startswith("Error:")
    assert words in result.output
    assert result.exit_code is None
    assert len(runner.requests) == 1  # tried once, nowhere else


def test_the_sync_path_fails_closed_too(agents_service):
    result = _backend(agents_service, _Runner(httpx.ConnectError("refused"))).execute("echo hi")
    assert result.output.startswith("Error:") and "unreachable" in result.output


async def test_a_command_the_runner_would_refuse_never_leaves_the_service(agents_service):
    sandbox = _sandbox(agents_service)
    runner = _Runner()
    backend = _backend(agents_service, runner)
    assert (await backend.aexecute("   ")).output.startswith("Error:")
    assert (await backend.aexecute("x" * (sandbox.MAX_COMMAND_CHARS + 1))).output.startswith("Error:")
    assert runner.requests == []


@pytest.mark.parametrize(
    "identity",
    [{"user_id": "../other"}, {"agent_slug": "a/b"}, {"conversation_id": ""},
     {"conversation_id": ".hidden"}, {"user_id": "spaces are bad"}],
)
def test_an_identity_that_could_address_another_tree_is_refused(agents_service, identity):
    with pytest.raises(ValueError, match="Invalid sandbox"):
        _backend(agents_service, _Runner(), **identity)


def test_the_backend_refuses_to_exist_without_a_runner(agents_service):
    sandbox = _sandbox(agents_service)
    with pytest.raises(RuntimeError, match="SANDBOX_RUNNER_URL"):
        sandbox.RemoteSandboxBackend(user_id="u", agent_slug="a", conversation_id="c", runner_url="")


async def test_a_runner_outage_does_not_fall_back_to_another_default(
    agents_service, skills_fs, monkeypatch, conversation_files
):
    """The Phase 3 acceptance test: flag on + runner down fails the call
    loudly, and the composite still routes `execute` to the sandbox — there
    is no default it could quietly degrade to."""
    _enable(agents_service)
    conversation_files.inputs = FakeInputs()
    runner = _Runner(httpx.ConnectError("refused"))
    workspace = _wire_runner(agents_service, monkeypatch, runner)
    factory = workspace.build_workspace_backend(
        user_id="u1", agent_slug="omni", files=conversation_files, use_memory=False
    )
    result = await factory(None).aexecute("echo hi")
    assert result.output.startswith("Error:") and "unreachable" in result.output
    again = factory(None)
    assert isinstance(again.default, _sandbox(agents_service).RemoteSandboxBackend)
    assert supports_execution(again)
    assert len(runner.requests) == 1


# ---------------------------------------------------------------------------
# Phase 4 — approval is platform-forced
# ---------------------------------------------------------------------------
def test_the_merge_forces_the_execute_gate_even_if_the_roster_drops_its_lock(agents_service, monkeypatch):
    gates = importlib.import_module("harness.tools.gates")
    monkeypatch.setattr(gates, "locked_gates", lambda: {})
    resolved = gates.resolve_interrupt_on(
        [], own_gates={"execute": False}, approvals={"execute": False}, agent_slug="a"
    )
    assert resolved["execute"] is True


def _definition(**overrides):
    spec = {
        "id": "probe-v1", "slug": "probe", "name": "Probe", "version": "1.0.0", "type": "deep_agent",
        "prompt": "./AGENT.md", "model": {"main": TRIAL_MODEL},
        "subagents": [{
            "name": "researcher", "description": "Researches.", "prompt": "./subagents/researcher.md",
            "subagents": [{"name": "coder", "description": "Codes.", "prompt": "./subagents/coder.md"}],
        }],
    }
    spec.update(overrides)
    return spec


def _definition_files():
    schema = importlib.import_module("schema")
    return [
        schema.AgentFile(path="AGENT.md", content="You are the probe main."),
        schema.AgentFile(path="subagents/researcher.md", content="You are the probe researcher."),
        schema.AgentFile(path="subagents/coder.md", content="You are the probe coder."),
    ]


def test_a_user_definition_cannot_switch_execute_approval_off(agents_service):
    spec, issues = agents_service.user_agents.validate_definition(
        "user-1", _definition(hitl={"execute": False}), _definition_files(),
        reserved_slugs=frozenset(), known_skills=frozenset(),
    )
    assert spec is None
    [issue] = [i for i in issues if i.path == "hitl.execute"]
    assert issue.severity == "error"
    assert "always asks for approval" in issue.message and "can't be set to false" in issue.message


def test_a_user_definition_may_say_execute_true(agents_service):
    spec, issues = agents_service.user_agents.validate_definition(
        "user-1", _definition(hitl={"execute": True}), _definition_files(),
        reserved_slugs=frozenset(), known_skills=frozenset(),
    )
    assert spec is not None, issues


def test_the_spec_loader_refuses_execute_false_too(agents_service):
    """Platform YAML and saved user agents load through `reference_errors`; a
    cleared execute gate is refused there, at load time."""
    spec_module = importlib.import_module("harness.abstractions.agent_spec")
    spec = spec_module.AgentSpec.model_validate(_definition(hitl={"execute": False}))
    errors = spec.reference_errors(is_known_model=lambda _m: True, is_known_native_tool=lambda _t: True)
    assert any("hitl.execute" in e and "cannot be set to false" in e for e in errors)


def test_the_seeded_yaml_agent_with_execute_true_still_loads(agents_service):
    spec_module = importlib.import_module("harness.abstractions.agent_spec")
    seed = AGENTS_SRC / "harness" / "agents_seed" / "omni-yaml-v1" / "agent.yaml"
    spec = spec_module.AgentSpec.model_validate(yaml.safe_load(seed.read_text(encoding="utf-8")))
    assert spec.hitl.get("execute") is True
    errors = spec.reference_errors(is_known_model=lambda _m: True, is_known_native_tool=lambda _t: True)
    assert not [e for e in errors if "hitl" in e]


def test_a_try_it_trial_gates_execute_at_every_depth(agents_service, monkeypatch):
    """A trial is a real YamlDeepAgent through build_deep_agent: its spec
    omits `execute`, the user's prefs say no, and every level still asks."""
    _enable(agents_service)
    deep_agent = importlib.import_module("harness.abstractions.deep_agent")
    spec_module = importlib.import_module("harness.abstractions.agent_spec")
    spec = spec_module.AgentSpec.model_validate(_definition(hitl={"write_file": True}))
    files = {f.path: f.content for f in _definition_files()}
    definition = agents_service.agents_utils.build_trial_definition("user-1", spec, files)

    captured: dict = {}
    monkeypatch.setattr(deep_agent, "create_deep_agent", lambda **kw: captured.update(kw))
    agent = definition.factory({
        "context": {"user_id": "user-1", "conversation_id": "conv-1", "agent_owner_id": "user-1",
                    "use_memory": False, "tool_config": {"approvals": {"execute": False}}},
        "run_config": {"configurable": {"thread_id": "t-1"}},
    })
    agent.sub_agents = agent.register_subagents()
    agent.skills_paths, agent.agent_md_paths = [], []
    agent.build_deep_agent(model=TRIAL_MODEL, subagents=agent.sub_agents, interrupt_on=spec.hitl, middleware=[])

    assert captured["interrupt_on"]["execute"] is True
    top = {s["name"]: s for s in captured["subagents"]}
    # Depth 1 inherits the main agent's resolved map inside deepagents (no key
    # of its own); depth 2 is built here and resolves the gates itself.
    assert "interrupt_on" not in top["researcher"] or top["researcher"]["interrupt_on"]["execute"] is True
    [task] = [m for m in top["researcher"]["middleware"] if isinstance(m, SubAgentMiddleware)]
    coder = {c["name"]: c for c in task._subagents}["coder"]
    assert coder["interrupt_on"]["execute"] is True


def test_the_builtin_catalog_lists_execute_only_when_enabled(agents_service):
    builtins_mod = importlib.import_module("harness.tools.builtins")
    assert "execute" not in {t["name"] for t in builtins_mod.builtin_tool_catalog()}
    tools = {t["name"]: t for t in builtins_mod.builtin_tool_catalog(sandbox_enabled=True)}
    assert tools["execute"]["group"] == "Execution"
    assert tools["execute"]["locked"] and tools["execute"]["hitlDefault"]
    # Reserved either way, so an MCP tool can't take the name.
    assert "execute" in builtins_mod.BUILTIN_BY_NAME


async def test_the_builtin_tools_route_follows_the_deployment(client, internal_headers, agents_service):
    names = {t["name"] for t in (await client.get("/builtin-tools", headers=internal_headers)).json()}
    assert "execute" not in names
    _enable(agents_service)
    names = {t["name"] for t in (await client.get("/builtin-tools", headers=internal_headers)).json()}
    assert "execute" in names


# ---------------------------------------------------------------------------
# End to end: a real deep agent graph, a scripted model, a mocked runner
# ---------------------------------------------------------------------------
def _exec(call_id: str, command: str) -> dict:
    return {"id": call_id, "name": "execute", "args": {"command": command}}


def _task(call_id: str, subagent: str) -> dict:
    return {"id": call_id, "name": "task", "args": {"subagent_type": subagent, "description": "Do it."}}


def _tool_name(tool) -> str | None:
    return tool.get("name") if isinstance(tool, dict) else getattr(tool, "name", None)


class _Scripted(FakeMessagesListChatModel):
    """Every agent's model, answering by the role its system prompt opens
    with, and recording the tool names each call was offered."""

    responses: list = Field(default_factory=list)
    model_name: str = "scripted-probe"
    scripts: dict = Field(default_factory=dict)
    cursor: dict = Field(default_factory=dict)
    offered: list = Field(default_factory=list)

    def bind_tools(self, tools, **kwargs):
        self.offered.append({_tool_name(t) for t in tools})
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        system = messages[0].text if messages else ""
        role = next((r for r in self.scripts if system.startswith(r)), None)
        if role is None:
            raise AssertionError(f"no script for system prompt: {system[:80]!r}")
        index = self.cursor.get(role, 0)
        self.cursor[role] = index + 1
        text, calls = self.scripts[role][min(index, len(self.scripts[role]) - 1)]
        message = AIMessage(
            id=f"msg-{role[-8:].strip()}-{index}",
            content=text,
            tool_calls=[{**call, "type": "tool_call"} for call in calls],
            usage_metadata={"input_tokens": 10, "output_tokens": 1, "total_tokens": 11},
            response_metadata={"model_name": "scripted-probe"},
        )
        return ChatResult(generations=[ChatGeneration(message=message)])

    async def _agenerate(self, *args, **kwargs):
        return self._generate(*args, **kwargs)


@pytest.fixture
def probe(agents_service, monkeypatch, memory_file_store):
    """A real deep agent whose own gates AND the user's prefs both try to
    switch execute approval off. Returns ``(agent, model)``."""
    deep_agent = importlib.import_module("harness.abstractions.deep_agent")
    tree = importlib.import_module("harness.abstractions.subagent_tree")
    models = importlib.import_module("deepagents._models")

    def _make(scripts: dict, *, nested: bool = False):
        model = _Scripted(scripts=scripts)
        monkeypatch.setattr(models, "init_chat_model", lambda *a, **k: model)

        class Probe(deep_agent.DeepAgent):
            name = "sandbox-probe"
            instructions = "You are the probe main."

            def load_skills(self):
                return []

            def load_agent_md(self):
                return []

            def register_subagents(self):
                if not nested:
                    return None
                return [tree.subagent(
                    "researcher", "Researches.", "You are the probe researcher.",
                    subagents=[tree.subagent(
                        "coder", "Codes.", "You are the probe coder.",
                        interrupt_on={"execute": False},
                    )],
                )]

            def register_agent(self):
                return self.build_deep_agent(
                    model=PROBE_MODEL,
                    system_prompt=self.instructions,
                    subagents=self.sub_agents,
                    interrupt_on={"execute": False},
                    middleware=[],
                )

        agent = Probe(config={
            "context": {"user_id": "user-1", "conversation_id": "conv-1", "run_id": "run-1",
                        "use_memory": False, "tool_config": {"approvals": {"execute": False}}},
            "run_config": {"configurable": {"thread_id": "probe-thread"}, "recursion_limit": 100},
        })
        agent.checkpointer = MemorySaver()
        # The run's conversation files over the in-memory store, no uploads.
        agent._conversation_files = importlib.import_module("harness.conversation_files").ConversationFiles(
            user_id="user-1", conversation_id="conv-1", agent_slug="sandbox-probe",
            store=memory_file_store, run_id="run-1",
        )
        agent._conversation_files.inputs = FakeInputs()
        return agent, model

    return _make


async def _drive(agent, *, on_pause, max_legs: int = 8) -> list[list[str]]:
    """Run until the graph finishes, calling ``on_pause(names)`` and then
    approving at every interrupt. Returns the tool names of each pause."""
    await agent.ensure_built()
    graph, config = agent.compiled, agent.run_config
    pauses: list[list[str]] = []
    payload: object = {"messages": [{"role": "user", "content": "Go."}]}
    for _ in range(max_legs):
        await graph.ainvoke(payload, config=config)
        snapshot = await graph.aget_state(config)
        if not snapshot.interrupts:
            return pauses
        requests = (snapshot.interrupts[0].value or {}).get("action_requests") or []
        names = [r.get("name") for r in requests]
        pauses.append(names)
        on_pause(names)
        payload = Command(resume={"decisions": [{"type": "approve"}] * max(len(requests), 1)})
    raise AssertionError(f"run did not finish: {pauses}")


async def _messages(agent) -> list:
    return (await agent.compiled.aget_state(agent.run_config)).values["messages"]


async def test_flag_off_the_model_is_never_offered_execute(agents_service, probe, skills_fs):
    agent, model = probe({"You are the probe main": [("Done.", [])]})
    await _drive(agent, on_pause=lambda _n: None)
    assert model.offered
    assert all("execute" not in names for names in model.offered)


async def test_execute_pauses_at_the_main_agent_then_round_trips(agents_service, probe, monkeypatch, skills_fs):
    _enable(agents_service)
    runner = _Runner(_ok(stdout="hi from the box\n"))
    _wire_runner(agents_service, monkeypatch, runner)
    agent, model = probe({"You are the probe main": [("", [_exec("call-1", "echo hi")]), ("Done.", [])]})

    def before_approval(names):
        # The pause comes BEFORE anything reaches the runner.
        assert names == ["execute"]
        assert runner.requests == []

    pauses = await _drive(agent, on_pause=before_approval)
    assert pauses == [["execute"]]
    assert any("execute" in names for names in model.offered)
    [body] = runner.bodies()
    assert (body["user_id"], body["agent_slug"], body["conversation_id"], body["command"]) == (
        "user-1", "sandbox-probe", "conv-1", "echo hi"
    )
    [result] = [m for m in await _messages(agent) if isinstance(m, ToolMessage) and m.name == "execute"]
    assert "hi from the box" in result.content and "exit code 0" in result.content


async def test_a_denied_command_never_reaches_the_runner(agents_service, probe, monkeypatch, skills_fs):
    _enable(agents_service)
    runner = _Runner()
    _wire_runner(agents_service, monkeypatch, runner)
    agent, _model = probe({"You are the probe main": [("", [_exec("call-1", "rm -rf /conversation/output")]),
                                                      ("Ok.", [])]})
    await agent.ensure_built()
    graph, config = agent.compiled, agent.run_config
    await graph.ainvoke({"messages": [{"role": "user", "content": "Go."}]}, config=config)
    assert (await graph.aget_state(config)).interrupts
    await graph.ainvoke(Command(resume={"decisions": [{"type": "reject", "message": "No."}]}), config=config)
    snapshot = await graph.aget_state(config)
    assert not snapshot.interrupts
    assert runner.requests == []
    assert snapshot.values["messages"][-1].content == "Ok."  # the run continued


async def test_a_runner_outage_is_an_error_result_and_the_run_continues(
    agents_service, probe, monkeypatch, skills_fs
):
    _enable(agents_service)
    runner = _Runner(httpx.ConnectError("refused"))
    _wire_runner(agents_service, monkeypatch, runner)
    agent, _model = probe({"You are the probe main": [("", [_exec("call-1", "echo hi")]), ("Sorry.", [])]})
    await _drive(agent, on_pause=lambda _n: None)
    messages = await _messages(agent)
    [result] = [m for m in messages if isinstance(m, ToolMessage) and m.name == "execute"]
    assert result.content.startswith("Error:") and "unreachable" in result.content
    assert messages[-1].content == "Sorry."
    assert len(runner.requests) == 1


async def test_execute_pauses_two_levels_down_although_the_spec_says_false(
    agents_service, probe, monkeypatch, skills_fs
):
    _enable(agents_service)
    # Nested delegation here is the blocking `task` path (plan 41 keeps it
    # behind ASYNC_SUBAGENTS_ENABLED=false).
    agents_service.settings_module.settings.async_tasks.enabled = False
    runner = _Runner(_ok(stdout="nested ok\n"))
    _wire_runner(agents_service, monkeypatch, runner)
    agent, _model = probe({
        "You are the probe main": [("", [_task("call-r", "researcher")]), ("Done.", [])],
        "You are the probe researcher": [("", [_task("call-c", "coder")]), ("Researched.", [])],
        "You are the probe coder": [("", [_exec("call-x", "python -c 'print(1)'")]), ("Coded.", [])],
    }, nested=True)

    def check(names):
        if "execute" in names:
            assert runner.requests == [], "execute reached the runner before approval"

    pauses = await _drive(agent, on_pause=check)
    assert ["execute"] in pauses, pauses
    [body] = runner.bodies()
    assert body["command"] == "python -c 'print(1)'"
    assert body["conversation_id"] == "conv-1"


# ---------------------------------------------------------------------------
# The files travel with the call (plan 36 rows ⇄ the request/response)
# ---------------------------------------------------------------------------
PNG = b"\x89PNG\r\n\x1a\n\x00\xff\xfe binary"
XLSX = b"PK\x03\x04\x00\x00\xde\xad\xbe\xef" * 300


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def _returned(path: str, data: bytes) -> dict:
    return {"path": path, "content_b64": _b64(data), "size": len(data)}


@pytest.fixture
def wired(agents_service, skills_fs, monkeypatch, conversation_files):
    """Execution on, a scripted runner, and this run's composite backend over
    the in-memory conversation store. Returns ``make(*answers)`` →
    ``(composite, runner)``."""
    _enable(agents_service)

    def make(*answers, uploads: dict[str, bytes] | None = None, uploads_down: bool = False):
        conversation_files.inputs = FakeInputs(uploads, down=uploads_down)
        runner = _Runner(*answers)
        workspace = _wire_runner(agents_service, monkeypatch, runner)
        composite = workspace.build_workspace_backend(
            user_id="u1", agent_slug="omni", files=conversation_files, use_memory=False
        )(None)
        return composite, runner

    return make


async def test_inputs_and_outputs_are_sent_text_and_binary(wired, conversation_files):
    await conversation_files.create("/conversation/output/draft.md", b"# draft\n")
    composite, runner = wired(_ok(), uploads={"data.csv": b"a,b\n1,2\n", "photo.png": PNG})

    await composite.aexecute("ls")

    [body] = runner.bodies()
    sent = {f["path"]: base64.b64decode(f["content_b64"]) for f in body["files"]}
    assert sent == {
        "input/data.csv": b"a,b\n1,2\n",
        "input/photo.png": PNG,
        "output/draft.md": b"# draft\n",
    }
    # Identity still comes from the run, never from a path.
    assert (body["user_id"], body["agent_slug"], body["conversation_id"]) == ("u1", "omni", "c1")


async def test_returned_outputs_land_in_conversation_output_and_read_back(wired, conversation_files):
    await conversation_files.create("/conversation/output/notes.md", b"old")
    composite, _runner = wired(_ok(stdout="done\n", files=[
        _returned("output/report.xlsx", XLSX),
        _returned("output/charts/plot.png", PNG),
        _returned("output/notes.md", b"new notes"),
    ]))

    result = await composite.aexecute("python make_report.py")

    assert await conversation_files.read_bytes("/conversation/output/report.xlsx") == XLSX
    assert await conversation_files.read_bytes("/conversation/output/charts/plot.png") == PNG
    assert await conversation_files.read_bytes("/conversation/output/notes.md") == b"new notes"  # replaced
    # Readable afterwards through the agent's own mount, as read_file sees it.
    [download] = await composite.adownload_files(["/conversation/output/report.xlsx"])
    assert download.error is None and download.content == XLSX
    assert "done" in result.output
    assert "Wrote /conversation/output/report.xlsx (" in result.output
    assert "/conversation/output/charts/plot.png" in result.output


async def test_a_returned_file_outside_output_is_never_written(wired, conversation_files, memory_file_store):
    composite, _runner = wired(_ok(files=[
        _returned("input/data.csv", b"overwrite the upload"),
        _returned("output/../../conversation_history/x.md", b"escape"),
        _returned("/conversation/output/abs.md", b"absolute"),
        _returned("output/.hidden", b"hidden"),
        {"path": "output/bad.bin", "content_b64": "%%% not base64 %%%", "size": 3},
        _returned("output/ok.txt", b"fine"),
    ]))

    result = await composite.aexecute("x")

    entries = await conversation_files.entries("/")
    assert [e.path for e in entries] == ["/conversation/output/ok.txt"]
    assert "Ignored returned files outside output/" in result.output


@pytest.mark.parametrize(
    "answer",
    [httpx.ConnectError("refused"), httpx.ReadTimeout("slow"), httpx.Response(503),
     httpx.Response(500), httpx.Response(200, text="garbage")],
)
async def test_a_failed_call_writes_nothing(wired, conversation_files, answer):
    composite, runner = wired(answer)
    result = await composite.aexecute("x")
    assert result.output.startswith("Error:")
    assert await conversation_files.entries("/conversation/output") == []
    assert len(runner.requests) == 1


async def test_a_disk_limit_kill_saves_no_outputs(wired, conversation_files):
    composite, _runner = wired(_ok(exit_code=None, killed_reason="disk_limit",
                                   files=[_returned("output/huge.bin", b"x" * 10)]))
    result = await composite.aexecute("x")
    assert await conversation_files.entries("/conversation/output") == []
    assert "not saved" in result.output


async def test_the_send_caps_skip_files_and_say_so(wired, conversation_files, agents_service, monkeypatch):
    sandbox = _sandbox(agents_service)
    monkeypatch.setattr(sandbox, "MAX_TRANSFER_FILES", 2)
    for name in ("a.txt", "b.txt", "c.txt"):
        await conversation_files.create(f"/conversation/output/{name}", b"x")
    composite, runner = wired(_ok())

    result = await composite.aexecute("x")

    assert [f["path"] for f in runner.bodies()[0]["files"]] == ["output/a.txt", "output/b.txt"]
    assert "Not copied into the sandbox" in result.output and "output/c.txt" in result.output


async def test_the_byte_cap_skips_a_file_that_would_cross_it(wired, conversation_files, agents_service, monkeypatch):
    sandbox = _sandbox(agents_service)
    monkeypatch.setattr(sandbox, "MAX_TRANSFER_BYTES", 10)
    await conversation_files.create("/conversation/output/big.bin", b"x" * 11)
    await conversation_files.create("/conversation/output/small.txt", b"y")
    composite, runner = wired(_ok())

    result = await composite.aexecute("x")

    assert [f["path"] for f in runner.bodies()[0]["files"]] == ["output/small.txt"]
    assert "output/big.bin" in result.output


async def test_the_return_caps_hold_too(wired, conversation_files, agents_service, monkeypatch):
    sandbox = _sandbox(agents_service)
    monkeypatch.setattr(sandbox, "MAX_TRANSFER_FILES", 1)
    composite, _runner = wired(_ok(files_truncated=True, files=[
        _returned("output/one.txt", b"1"), _returned("output/two.txt", b"2"),
    ]))
    result = await composite.aexecute("x")
    assert [e.path for e in await conversation_files.entries("/conversation/output")] == [
        "/conversation/output/one.txt"
    ]
    assert "Not every changed output file came back" in result.output


async def test_unreachable_uploads_still_run_and_say_so(wired, conversation_files):
    await conversation_files.create("/conversation/output/keep.md", b"k")
    composite, runner = wired(_ok(), uploads_down=True)
    result = await composite.aexecute("x")
    assert [f["path"] for f in runner.bodies()[0]["files"]] == ["output/keep.md"]
    assert "uploads could not be fetched" in result.output


class _ExplodingStore:
    """Any file IO at all fails the test."""

    def __getattr__(self, name):
        raise AssertionError(f"file IO ({name}) while it must not happen")


class _ExplodingInputs:
    def __getattr__(self, name):
        raise AssertionError(f"upload IO ({name}) while it must not happen")


@pytest.mark.parametrize("enabled", [False, True])
def test_minting_the_workspace_does_no_file_io(agents_service, skills_fs, enabled):
    """Flag off there is no sandbox backend to read anything; flag on it reads
    nothing until `execute` is called."""
    package = importlib.import_module("harness.conversation_files")
    workspace = importlib.import_module("harness.filesystem.workspace")
    if enabled:
        _enable(agents_service)
    files = package.ConversationFiles(
        user_id="user-1", conversation_id="conv-1", agent_slug="agent-1", store=_ExplodingStore()
    )
    files.inputs = _ExplodingInputs()
    backend = workspace.build_workspace_backend(
        user_id="user-1", agent_slug="agent-1", files=files, use_memory=False
    )(None)
    assert supports_execution(backend) is enabled


def test_the_backend_refuses_another_runs_files(agents_service, conversation_files):
    package = importlib.import_module("harness.conversation_files")
    mount = package.ConversationFilesBackend(conversation_files, "/conversation")
    with pytest.raises(ValueError, match="different run"):
        _sandbox(agents_service).RemoteSandboxBackend(
            user_id="u1", agent_slug="omni", conversation_id="other-conv",
            files=conversation_files, conversation_mount=mount, runner_url=RUNNER_URL,
        )
