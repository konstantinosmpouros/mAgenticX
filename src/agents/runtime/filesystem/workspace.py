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
from typing import Any, Callable

from deepagents import FilesystemPermission
from deepagents.backends import CompositeBackend, FilesystemBackend, StateBackend
from deepagents.backends.protocol import SandboxBackendProtocol

from core.settings import settings
from runtime.filesystem.provisioner import (
    conversation_root,
    ensure_user_agent_filesystem,
    memory_root,
    skills_root,
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


def workspace_write_deny(*, include_reference: bool = False) -> list[FilesystemPermission]:
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
    return rules


def build_workspace_backend(
    *,
    user_id: str,
    agent_slug: str,
    conversation_id: str,
    use_memory: bool,
    reference_dir: Path | None = None,
) -> Callable[[Any], CompositeBackend]:
    """Provision the tree and return a factory minting a fresh ``CompositeBackend``
    per tool call.

    The deepagents library accepts ``backend=callable(ToolRuntime) -> Backend``
    and invokes it on every tool call so ``StateBackend`` can bind to the live
    runtime. FilesystemBackends are mounted at structurally disjoint roots so no
    route can resolve into another's tree:

        /memories/            → <user_root>/agents/<slug>/memory/    (AGENTS.md + entries/)
        /skills/              → <user_root>/agents/<slug>/skills/    (user-enabled skills)
        /conversation/input/  → <conv_id>/input/                     (user uploads, read-only)
        /conversation/output/ → <conv_id>/output/                    (agent artifacts, read-write)
        /conversation/        → <user_root>/agents/<slug>/<conv_id>/ (this chat only)
        /reference/           → the agent's definition folder        (read-only, optional)
        default               → StateBackend(rt)                     (ephemeral scratch)

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

    The central skills registry is intentionally **not mounted** — the agent
    only ever sees the skills the user has explicitly enabled, copied into
    ``skills/`` by the bridge's PUT endpoint.

    ``reference_dir`` mounts the agent's own definition folder read-only at
    ``/reference/``, so material shipped alongside the prompt (notes, checklists,
    examples) is readable on demand instead of being inlined into every turn's
    context. Declarative agents pass their source directory; agents defined in
    code pass nothing and the route is simply absent. Keep the write-deny in
    step via :func:`workspace_write_deny`.
    """
    ensure_user_agent_filesystem(
        user_id=user_id, agent_slug=agent_slug, conversation_id=conversation_id
    )
    memory_path = memory_root(user_id, agent_slug)
    skills_path = skills_root(user_id, agent_slug)
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
        routes: dict[str, FilesystemBackend] = {}
        if use_memory:
            routes["/memories/"] = FilesystemBackend(
                root_dir=str(memory_path), virtual_mode=True
            )
        routes.update({
            "/skills/": FilesystemBackend(
                root_dir=str(skills_path), virtual_mode=True
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
        if reference_dir is not None:
            routes["/reference/"] = FilesystemBackend(
                root_dir=str(reference_dir), virtual_mode=True
            )
        return CompositeBackend(default=default_backend, routes=routes)

    return factory
