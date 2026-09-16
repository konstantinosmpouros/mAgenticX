"""Mount-table invariants for a deep agent's workspace filesystem.

The agent's only view of disk is the ``CompositeBackend`` assembled in
``harness.filesystem.workspace``, so these tests pin two things that are easy to
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
    return importlib.import_module("harness.filesystem.workspace")


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


# ---------------------------------------------------------------------------
# The skill routes, now that skills are rows
# ---------------------------------------------------------------------------
def test_skills_is_a_store_route_not_a_directory(workspace, skills_fs):
    """``/skills/`` resolves per read against ``agent_runtime`` instead of a
    per-user folder. A ``FilesystemBackend`` here would mean the copy-and-
    reconcile the migration removed had quietly come back."""
    from deepagents.backends import FilesystemBackend, StoreBackend

    route = _backend(workspace).routes["/skills/"]
    assert isinstance(route, StoreBackend)
    assert not isinstance(route, FilesystemBackend)


def test_a_platform_agents_tier_one_is_mounted_straight_from_its_image_folder(
    workspace, skills_fs, tmp_path
):
    # Build-time content: identical for every user and not tamperable at
    # runtime, so it stays a directory rather than becoming rows.
    from deepagents.backends import FilesystemBackend

    defaults = tmp_path / "default_skills"
    defaults.mkdir()
    route = _backend(workspace, default_skills_dir=defaults).routes["/default_skills/"]
    assert isinstance(route, FilesystemBackend)


def test_a_user_authored_agents_tier_one_resolves_through_the_store(workspace, skills_fs):
    """A custom agent has no image folder, so its declared skills resolve out of
    the author's own pool. The names ride in the namespace, which is what lets
    the store answer without ever reading an agent definition."""
    from deepagents.backends import StoreBackend

    factory = workspace.build_workspace_backend(
        user_id="user-1", agent_slug="nova", conversation_id="conv-1",
        use_memory=False, declared_skills=("note-taker", "planner"),
    )
    route = factory(None).routes["/default_skills/"]
    assert isinstance(route, StoreBackend)
    assert route._namespace(None)[2:] == ("declared", "note-taker", "planner")


def test_the_two_skill_mounts_cannot_see_each_others_entries(workspace, skills_fs):
    """One store, two mounts: only the tier in the namespace separates tier ①
    from tier ②. If they collided, a user-authored agent's read-only declared
    skills and its user-toggled ones would be the same set."""
    factory = workspace.build_workspace_backend(
        user_id="user-1", agent_slug="nova", conversation_id="conv-1",
        use_memory=False, declared_skills=("planner",),
    )
    routes = factory(None).routes
    assigned = routes["/skills/"]._namespace(None)
    declared = routes["/default_skills/"]._namespace(None)
    assert assigned[2] != declared[2]


def test_a_declared_set_does_not_override_a_bundled_folder(workspace, skills_fs, tmp_path):
    # A platform agent that also carries declared names must keep reading its
    # image folder — the folder is the stronger claim.
    from deepagents.backends import FilesystemBackend

    defaults = tmp_path / "default_skills"
    defaults.mkdir()
    factory = workspace.build_workspace_backend(
        user_id="user-1", agent_slug="omni", conversation_id="conv-1",
        use_memory=False, default_skills_dir=defaults, declared_skills=("planner",),
    )
    assert isinstance(factory(None).routes["/default_skills/"], FilesystemBackend)


# ---------------------------------------------------------------------------
# /reference/ — a folder for a platform agent, rows for a user-authored one
# ---------------------------------------------------------------------------
def test_a_platform_agents_reference_is_mounted_from_its_image_folder(
    workspace, skills_fs, tmp_path
):
    from deepagents.backends import FilesystemBackend

    definition = tmp_path / "definition"
    definition.mkdir()
    route = _backend(workspace, reference_dir=definition).routes["/reference/"]
    assert isinstance(route, FilesystemBackend)


def test_a_user_authored_agents_reference_resolves_through_the_store(workspace, skills_fs):
    """Its definition is rows in ``agent_runtime``, so the mount is a store route
    namespaced by ``(user_id, agent_slug)`` — no directory to keep in step with
    the database, and nothing on disk a run could tamper with."""
    from deepagents.backends import StoreBackend

    factory = workspace.build_workspace_backend(
        user_id="user-1", agent_slug="nova", conversation_id="conv-1",
        use_memory=False, reference_namespace=("user-1", "nova"),
    )
    route = factory(None).routes["/reference/"]
    assert isinstance(route, StoreBackend)
    assert route._namespace(None) == ("user-1", "nova")


def test_an_image_folder_wins_over_a_namespace(workspace, skills_fs, tmp_path):
    # Exactly one of the two is ever set, but if both arrive the folder is the
    # stronger claim: a platform agent must never read a user's rows.
    from deepagents.backends import FilesystemBackend

    definition = tmp_path / "definition"
    definition.mkdir()
    factory = workspace.build_workspace_backend(
        user_id="user-1", agent_slug="omni", conversation_id="conv-1",
        use_memory=False, reference_dir=definition,
        reference_namespace=("user-1", "omni"),
    )
    assert isinstance(factory(None).routes["/reference/"], FilesystemBackend)


def test_no_reference_route_when_neither_source_is_given(workspace, skills_fs):
    # An agent defined in code has no definition to expose, and its package dir
    # holds source, which must never be readable from a run.
    assert "/reference/" not in _backend(workspace).routes
