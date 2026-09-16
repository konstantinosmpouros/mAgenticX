"""Deepagents workspace assembly for a deep agent's filesystem.

This is the deepagents-*aware* layer on top of the framework-free
``provisioner`` (which owns paths + on-disk provisioning). It assembles the two
things a deep agent hands to ``create_deep_agent`` for its filesystem:

* the ``CompositeBackend`` factory — the map of virtual routes (``/memories/``,
  ``/skills/``, ``/conversation/...``) onto the per-(user, agent, conversation)
  physical roots the provisioner computes, and
* ``WORKSPACE_WRITE_DENY`` — the write-deny permission ladder.

These live together on purpose: each write-deny rule targets a mount route by
path, and deepagents rejects a permission pointing at an unmounted route, so
the routes and their permissions **must stay in sync**. Keeping both here (next
to the route strings) removes the footgun of editing one without the other.
``provisioner.py`` deliberately stays import-free of deepagents so it remains
reusable by the rest of the agents service; the framework dependency enters
only here.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Callable, Sequence

from deepagents import FilesystemPermission
from deepagents.backends import (
    CompositeBackend,
    FilesystemBackend,
    StateBackend,
    StoreBackend,
)
from deepagents.backends.protocol import SandboxBackendProtocol

from core.settings import settings
from harness.agent_registry.store import AgentDefinitionStore
from harness.memory import AgentMemoryStore, get_memory_pool
from harness.skill_registry.store import TIER_ASSIGNED, TIER_DECLARED, SkillStore
from harness.filesystem.provisioner import (
    conversation_root,
    ensure_user_agent_filesystem,
)


# Write-deny rules over the built-in filesystem tools, shared by every deep agent.
# Confinement is mainly structural (CompositeBackend + virtual_mode); these only
# pin the read-only surfaces: /skills/ (UI-managed), the deepagents offload/archive
# dirs, and /conversation/input/ (uploads — the agent writes to output/). No
# catch-all deny, which would block reading those. Revisit when execute lands.
WORKSPACE_WRITE_DENY: list[FilesystemPermission] = [
    FilesystemPermission(operations=["write"], paths=["/skills{,/**}"], mode="deny"),
    FilesystemPermission(operations=["write"], paths=["/large_tool_results{,/**}"], mode="deny"),
    FilesystemPermission(operations=["write"], paths=["/conversation_history{,/**}"], mode="deny"),
    # User uploads are read-only; the agent writes artifacts to /conversation/output/ instead.
    FilesystemPermission(operations=["write"], paths=["/conversation/input{,/**}"], mode="deny"),
]

# The agent's own definition folder, when it has one. Read-only: it is authored
# through the builder UI (which enforces its own type/size limits), so letting a
# run rewrite its own definition would both bypass that validation and let an
# agent edit its next system prompt.
_REFERENCE_WRITE_DENY = FilesystemPermission(
    operations=["write"], paths=["/reference{,/**}"], mode="deny"
)

# Tier-① skills: the ones an agent ships with. Read-only is what makes "the user
# may add skills but never remove these" structural rather than a UI rule — the
# per-agent enable/disable endpoint only ever touches the separate `/skills/`
# tree, so there is no path through which a default can be dropped.
_DEFAULT_SKILLS_WRITE_DENY = FilesystemPermission(
    operations=["write"], paths=["/default_skills{,/**}"], mode="deny"
)


def workspace_write_deny(
    *, include_reference: bool = False, include_default_skills: bool = False
) -> list[FilesystemPermission]:
    """The write-deny ladder for a run, matched to the routes it actually mounts.

    Kept a function rather than a bare constant because ``/reference/`` is
    conditional: deepagents refuses a permission whose path is outside every
    mounted route (``_all_paths_scoped_to_routes``) once the default backend
    supports execution, so a rule for an unmounted route would become a hard
    failure the day sandbox execute lands. Callers derive both the mount and the
    rule from the same flag.
    """
    rules = list(WORKSPACE_WRITE_DENY)
    if include_reference:
        rules.append(_REFERENCE_WRITE_DENY)
    if include_default_skills:
        rules.append(_DEFAULT_SKILLS_WRITE_DENY)
    return rules


def build_workspace_backend(
    *,
    user_id: str,
    agent_slug: str,
    conversation_id: str,
    use_memory: bool,
    reference_dir: Path | None = None,
    reference_namespace: tuple[str, ...] | None = None,
    default_skills_dir: Path | None = None,
    declared_skills: Sequence[str] = (),
) -> Callable[[Any], CompositeBackend]:
    """Provision the tree and return a factory minting a fresh ``CompositeBackend``
    per tool call.

    The deepagents library accepts ``backend=callable(ToolRuntime) -> Backend``
    and invokes it on every tool call so ``StateBackend`` can bind to the live
    runtime. FilesystemBackends are mounted at structurally disjoint roots so no
    route can resolve into another's tree:

        /memories/            → agent_runtime rows                  (AGENTS.md + entries/)
        /skills/              → agent_runtime rows                  (user-enabled skills)
        /conversation/input/  → <conv_id>/input/                     (user uploads, read-only)
        /conversation/output/ → <conv_id>/output/                    (agent artifacts, read-write)
        /conversation/        → <user_root>/agents/<slug>/<conv_id>/ (this chat only)
        /default_skills/      → image folder OR agent_runtime rows   (read-only, optional)
        /reference/           → image folder OR agent_runtime rows   (read-only, optional)
        default               → StateBackend(rt)                     (ephemeral scratch)

    Only the ``/conversation/`` family is a real directory. Everything a *user*
    authored is a virtual route over ``agent_runtime``; everything the platform
    ships is a directory in the image.

    Per-conversation isolation: ``/conversation/`` is rooted at a single
    ``<conv_id>`` directory, so files written in one chat are not visible from
    the next. Durable cross-conversation context lives in the per-(user, agent)
    ``/memories/`` tree (the ``remember`` tool maintains ``AGENTS.md`` +
    ``entries/``). ``input/`` holds user-uploaded files (bridge-seeded, the agent
    reads them — write-denied); ``output/`` is where the agent writes artifacts.
    Both are subdirs of ``<conv_id>`` so they also surface under
    ``/conversation/``; the dedicated longer-prefix routes give the write-deny a
    clean target.

    Memory is per-run: when ``use_memory`` is false the ``/memories/`` mount is
    dropped entirely so the agent can neither read nor write its AGENTS.md /
    entries. Safe to omit standalone — no ``WORKSPACE_WRITE_DENY`` rule targets
    ``/memories/``, so the permission ladder needs no change.

    The central skills catalogue is intentionally **not mounted** — the agent
    only ever sees the skills the user has explicitly enabled, resolved per read
    from their ``agent_skills`` rows.

    ``/reference/`` mounts the agent's own definition read-only, so material
    shipped alongside the prompt (notes, checklists, examples) is readable on
    demand instead of being inlined into every turn's context. It arrives by one
    of two routes and never both: ``reference_dir`` for a **platform** agent,
    whose definition is a directory in the image, and ``reference_namespace`` for
    a **user-authored** one, whose definition is rows in ``agent_runtime``. An
    agent defined in code passes neither and the route is simply absent. Keep the
    write-deny in step via :func:`workspace_write_deny`.
    """
    ensure_user_agent_filesystem(
        user_id=user_id, agent_slug=agent_slug, conversation_id=conversation_id
    )
    conv_path = conversation_root(user_id, agent_slug, conversation_id)
    # Per-conversation, on-disk homes for deepagents' offloaded artifacts.
    # Created eagerly so `ls` works before the first offload write.
    large_tool_results_path = conv_path / "large_tool_results"
    conversation_history_path = conv_path / "conversation_history"
    large_tool_results_path.mkdir(parents=True, exist_ok=True)
    conversation_history_path.mkdir(parents=True, exist_ok=True)
    # input/ (read-only uploads, bridge-seeded) + output/ (agent artifacts);
    # subdirs of conv_path, with longer-prefix routes winning the overlap.
    input_path = conv_path / "input"
    output_path = conv_path / "output"
    input_path.mkdir(parents=True, exist_ok=True)
    output_path.mkdir(parents=True, exist_ok=True)

    def factory(rt: Any) -> CompositeBackend:
        # Sandbox-execution kill switch (fail-closed). deepagents exposes its
        # `execute` tool exactly when the composite DEFAULT backend implements
        # SandboxBackendProtocol — StateBackend does not, LocalShellBackend
        # (host-shell execution!) does. While sandbox execution is disabled,
        # refuse to mint a sandbox-capable default so a future refactor
        # swapping this class can never silently open a code-execution path.
        # Raising here fails the tool call (and the run) rather than degrading
        # open.
        default_backend = StateBackend()
        if not settings.filesystem.sandbox_execution_enabled and isinstance(
            default_backend, SandboxBackendProtocol
        ):
            raise RuntimeError(
                "Workspace default backend is sandbox-capable but SANDBOX_EXECUTION_ENABLED "
                "is false — refusing to expose an execution path."
            )
        # Every other route is a real directory; this one is not. `/memories/`
        # is a virtual view over the `agent_memories` table in agent_runtime, so
        # the agent's read_file/write_file on it are queries. Nothing about how
        # the agent *uses* memory changes — there is simply no disk to lose.
        routes: dict[str, Any] = {}
        if use_memory:
            routes["/memories/"] = StoreBackend(
                store=AgentMemoryStore(get_memory_pool()),
                # Per-(user, agent): the namespace is what stops one agent's
                # accumulated memory reaching another's context. Safe to close
                # over the identity — a fresh backend is minted per tool call
                # from this run's own factory.
                namespace=lambda _rt: (user_id, agent_slug),
            )
        routes.update({
            # Tier ②, resolved rather than copied: the store dispatches per
            # skill — a custom one reads its rows, a global one reads the
            # catalogue on the volume — so no per-user directory exists to
            # write, hash or reconcile.
            "/skills/": StoreBackend(
                store=SkillStore(get_memory_pool()),
                namespace=lambda _rt: (user_id, agent_slug, TIER_ASSIGNED),
            ),
            "/conversation/input/": FilesystemBackend(
                root_dir=str(input_path), virtual_mode=True
            ),
            "/conversation/output/": FilesystemBackend(
                root_dir=str(output_path), virtual_mode=True
            ),
            "/conversation/": FilesystemBackend(
                root_dir=str(conv_path), virtual_mode=True
            ),
            # deepagents' offload prefixes routed to per-conversation disk
            # so they persist instead of the ephemeral StateBackend default.
            "/large_tool_results/": FilesystemBackend(
                root_dir=str(large_tool_results_path), virtual_mode=True
            ),
            "/conversation_history/": FilesystemBackend(
                root_dir=str(conversation_history_path), virtual_mode=True
            ),
        })
        if default_skills_dir is not None:
            # A platform agent's tier ① ships in its image folder, so it is
            # mounted straight from there — build-time content, identical for
            # every user, and impossible to tamper with.
            routes["/default_skills/"] = FilesystemBackend(
                root_dir=str(default_skills_dir), virtual_mode=True
            )
        elif declared_skills:
            # A user-authored agent's tier ① is its spec's `skills:` list
            # resolved against the author's own pool. The names ride in the
            # namespace so the store never has to read an agent definition.
            routes["/default_skills/"] = StoreBackend(
                store=SkillStore(get_memory_pool()),
                namespace=lambda _rt: (
                    user_id, agent_slug, TIER_DECLARED, *declared_skills
                ),
            )
        if reference_dir is not None:
            # A platform agent's definition ships in the image — build-time
            # content, identical for every user and not writable at runtime.
            routes["/reference/"] = FilesystemBackend(
                root_dir=str(reference_dir), virtual_mode=True
            )
        elif reference_namespace is not None:
            # A user-authored agent's definition is rows. Same read-only mount,
            # no directory to keep in step with the database.
            routes["/reference/"] = StoreBackend(
                store=AgentDefinitionStore(get_memory_pool()),
                namespace=lambda _rt, ns=reference_namespace: ns,
            )
        return CompositeBackend(default=default_backend, routes=routes)

    return factory
