"""Deepagents workspace assembly for a deep agent's filesystem.

It assembles the two things a deep agent hands to ``create_deep_agent`` for its
filesystem:

* the ``CompositeBackend`` factory — the map of virtual routes (``/memories/``,
  ``/skills/``, ``/conversation/...``) onto the stores and image folders that
  back them, and
* ``WORKSPACE_WRITE_DENY`` — the write-deny permission ladder.

These live together on purpose: each write-deny rule targets a mount route by
path, and deepagents rejects a permission pointing at an unmounted route, so
the routes and their permissions **must stay in sync**. Keeping both here (next
to the route strings) removes the footgun of editing one without the other.
"""
from __future__ import annotations

import asyncio
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

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
from harness.conversation_files import ConversationFiles, ConversationFilesBackend
from harness.conversation_files.paths import (
    CONVERSATION_HISTORY_ROOT,
    CONVERSATION_ROOT,
    LARGE_TOOL_RESULTS_ROOT,
)
from harness.memory import AgentMemoryStore, get_memory_pool
# Bound as a module, resolved at call time: the skill store imports
# `harness.filesystem` (for the legacy catalogue path) while this package is
# still initialising, so a `from ... import` of its names here is a cycle.
import harness.skill_registry.store as skill_store


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
    files: ConversationFiles,
    use_memory: bool,
    reference_dir: Path | None = None,
    reference_namespace: tuple[str, ...] | None = None,
    default_skills_dir: Path | None = None,
    declared_skills: Sequence[str] = (),
) -> Callable[[Any], CompositeBackend]:
    """Return a factory minting a fresh ``CompositeBackend`` per tool call.

    The deepagents library accepts ``backend=callable(ToolRuntime) -> Backend``
    and invokes it on every tool call so ``StateBackend`` can bind to the live
    runtime. Nothing here is a directory a run can write to:

        /memories/              → agent_runtime rows        (AGENTS.md + entries/)
        /skills/                → agent_runtime rows        (user-enabled skills)
        /conversation/          → agent_runtime rows        (this chat's files)
          /conversation/input/  → the bridge's attachments  (user uploads, read-only)
        /large_tool_results/    → agent_runtime rows        (offloaded tool results)
        /conversation_history/  → agent_runtime rows        (offloaded history)
        /default_skills/        → image folder OR agent_runtime rows (read-only, optional)
        /reference/             → image folder OR agent_runtime rows (read-only, optional)
        default                 → StateBackend(rt)          (ephemeral scratch)

    Per-conversation isolation: ``files`` is bound to one conversation, so
    files written in one chat are not visible from the next. Every agent of
    the conversation sees the same files. Durable cross-conversation context
    lives in the per-(user, agent) ``/memories/`` tree. ``output/`` is where
    the agent writes deliverables; ``input/`` is write-denied.

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
    try:
        # The conversation mounts bridge their sync methods onto this loop.
        loop: asyncio.AbstractEventLoop | None = asyncio.get_running_loop()
    except RuntimeError:
        loop = None

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
        # `/memories/` is a virtual view over the `agent_memories` table in
        # agent_runtime, so the agent's read_file/write_file on it are queries.
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
                store=skill_store.SkillStore(get_memory_pool()),
                namespace=lambda _rt: (user_id, agent_slug, skill_store.TIER_ASSIGNED),
            ),
            # One route for the whole conversation (uploads included), so a
            # grep from the root sees each file once.
            "/conversation/": ConversationFilesBackend(files, CONVERSATION_ROOT, loop=loop),
            # deepagents' offload prefixes: the conversation's too, kept out of
            # /conversation/ so its write-deny cannot be sidestepped from there.
            "/large_tool_results/": ConversationFilesBackend(files, LARGE_TOOL_RESULTS_ROOT, loop=loop),
            "/conversation_history/": ConversationFilesBackend(files, CONVERSATION_HISTORY_ROOT, loop=loop),
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
                store=skill_store.SkillStore(get_memory_pool()),
                namespace=lambda _rt: (
                    user_id, agent_slug, skill_store.TIER_DECLARED, *declared_skills
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
