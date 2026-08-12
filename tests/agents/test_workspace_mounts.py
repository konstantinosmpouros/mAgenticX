"""Mount-table invariants for a deep agent's workspace filesystem.

The agent's only view of disk is the ``CompositeBackend`` assembled in
``runtime.filesystem.workspace``, so these tests pin two things that are easy to
break silently:

* a route that is *supposed* to exist actually resolves to the directory it
  claims (a missing route degrades to the ephemeral ``StateBackend`` default and
  every read of it returns "not found" — inert, with no error anywhere), and
* the write-deny ladder stays scoped to mounted routes, which deepagents itself
  requires as soon as the default backend supports execution.
"""
from __future__ import annotations

import importlib

import pytest


@pytest.fixture()
def workspace(agents_service):
    return importlib.import_module("runtime.filesystem.workspace")


def _backend(workspace, *, reference_dir=None, default_skills_dir=None):
    factory = workspace.build_workspace_backend(
        user_id="user-1",
        agent_slug="agent-1",
        conversation_id="conv-1",
        use_memory=True,
        reference_dir=reference_dir,
        default_skills_dir=default_skills_dir,
    )
    return factory(None)


def test_reference_route_absent_without_a_definition_dir(workspace, skills_fs):
    """An agent defined in code has no definition folder — and its package dir
    holds source, which must never be mountable.

    Absence is the whole assertion: an unrouted path falls through to the
    ephemeral ``StateBackend`` default, which answers "not found" without any
    misconfiguration being reported anywhere.
    """
    assert "/reference/" not in _backend(workspace).routes


def test_agent_can_read_a_file_from_its_definition_dir(workspace, skills_fs, tmp_path):
    """The whole point of the mount: material shipped beside AGENT.md is readable
    at ``/reference/<path>`` during a run.

    Asserted through an actual backend read rather than the route table, because
    "the route exists" and "the file is reachable" are not the same claim.
    """
    definition = tmp_path / "custom_agents" / "my-agent"
    definition.mkdir(parents=True)
    (definition / "notes.md").write_text("house style", encoding="utf-8")

    result = _backend(workspace, reference_dir=definition).read("/reference/notes.md")
    assert result.error is None
    assert result.file_data["content"] == "house style"


def test_reference_write_deny_tracks_the_mount(workspace):
    """Routes and permissions are derived from one flag, so they cannot drift:
    no mount → no rule; mount → read-only."""

    def has_reference_deny(rules) -> bool:
        return any(
            rule.mode == "deny"
            and "write" in rule.operations
            and any("/reference" in path for path in rule.paths)
            for rule in rules
        )

    assert not has_reference_deny(workspace.workspace_write_deny())
    assert has_reference_deny(workspace.workspace_write_deny(include_reference=True))


@pytest.mark.parametrize("include_reference", [False, True])
def test_every_deny_rule_targets_a_mounted_route(
    workspace, skills_fs, tmp_path, include_reference
):
    """No write-deny rule may name a route this run didn't mount.

    A rule for an unmounted route is dead config today, and becomes a hard
    failure the day the default backend gains execution support (deepagents'
    ``_all_paths_scoped_to_routes`` runs only in that case). Compared on the
    leading path segment rather than by literal prefix, because the rules are
    brace patterns (``/skills{,/**}``) that never literally start with a route
    string (``/skills/``) — see this module's note in the repo tests README.
    """
    definition = tmp_path / "definition"
    definition.mkdir()
    backend = _backend(
        workspace,
        reference_dir=definition if include_reference else None,
        default_skills_dir=definition if include_reference else None,
    )
    mounted = {prefix.strip("/").split("/")[0] for prefix in backend.routes}
    rules = workspace.workspace_write_deny(
        include_reference=include_reference, include_default_skills=include_reference
    )

    unscoped = [
        path
        for rule in rules
        for path in rule.paths
        if path.lstrip("/").split("{")[0].split("/")[0] not in mounted
    ]
    assert not unscoped, f"deny rules outside every mounted route: {unscoped}"


def test_default_skills_route_is_conditional(workspace, skills_fs, tmp_path):
    """Tier ① is optional: an agent that ships with no skills of its own must not
    advertise an empty mount."""
    defaults = tmp_path / "default_skills"
    defaults.mkdir()
    assert "/default_skills/" not in _backend(workspace).routes
    assert "/default_skills/" in _backend(workspace, default_skills_dir=defaults).routes


def test_default_skills_are_read_only(workspace):
    """The rule that makes "add to, never remove" structural rather than a UI
    convention — a run cannot delete or overwrite a skill it ships with."""

    def has_default_skills_deny(rules) -> bool:
        return any(
            rule.mode == "deny"
            and "write" in rule.operations
            and any("/default_skills" in path for path in rule.paths)
            for rule in rules
        )

    assert not has_default_skills_deny(workspace.workspace_write_deny())
    assert has_default_skills_deny(workspace.workspace_write_deny(include_default_skills=True))
