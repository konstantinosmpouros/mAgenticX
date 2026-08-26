"""Sandbox-execution lockdown invariants.

While ``SANDBOX_EXECUTION_ENABLED`` is false there must be no code-execution
path: the workspace's composite default backend must not be sandbox-capable
(that is exactly what makes deepagents surface its built-in ``execute`` tool),
and the host-shell backend must never even be imported in service code. These
tests pin the invariant so a dependency bump or refactor cannot reopen it
silently.
"""
from __future__ import annotations

import importlib
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
AGENTS_SRC = ROOT / "src" / "agents"

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


def test_workspace_factory_builds_with_sandbox_execution_disabled(agents_service, skills_fs):
    """The normal path: flag off + StateBackend default builds cleanly."""
    workspace = importlib.import_module("runtime.filesystem.workspace")
    assert agents_service.settings_module.settings.filesystem.sandbox_execution_enabled is False
    factory = workspace.build_workspace_backend(
        user_id="user-1", agent_slug="agent-1", conversation_id="conv-1", use_memory=True
    )
    backend = factory(None)
    assert backend is not None


def test_workspace_factory_refuses_sandbox_default_when_disabled(
    agents_service, skills_fs, monkeypatch
):
    """The guard's teeth: if a refactor ever swaps the default backend for a
    sandbox-capable one while the flag is off, minting the backend must raise
    instead of silently exposing `execute`."""
    workspace = importlib.import_module("runtime.filesystem.workspace")
    from deepagents.backends.protocol import SandboxBackendProtocol

    class _SandboxLookalike(workspace.StateBackend):
        """StateBackend subclass registered as a virtual SandboxBackendProtocol."""

    SandboxBackendProtocol.register(_SandboxLookalike)
    monkeypatch.setattr(workspace, "StateBackend", _SandboxLookalike)

    factory = workspace.build_workspace_backend(
        user_id="user-1", agent_slug="agent-1", conversation_id="conv-1", use_memory=False
    )
    with pytest.raises(RuntimeError, match="SANDBOX_EXECUTION_ENABLED"):
        factory(None)


def test_execute_stays_a_reserved_tool_name(agents_service):
    """The built-in `execute` is injected by deepagents itself (never via
    self.tools), but dynamically-attached MCP tools are name-filtered against
    this set — 'execute' must stay in it so an external tool can't smuggle the
    name in."""
    deep_agent = importlib.import_module("runtime.abstractions.deep_agent")
    assert "execute" in deep_agent.RESERVED_DEEPAGENT_TOOL_NAMES


def test_write_deny_ladder_regressions(agents_service):
    """The FilesystemPermission lockdown that is already load-bearing: input/
    (plus skills and the offload dirs) must stay write-denied."""
    workspace = importlib.import_module("runtime.filesystem.workspace")

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
