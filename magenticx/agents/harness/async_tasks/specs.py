"""Sub-agent trees as async tasks: graph ids, tree paths, and the specs the middleware gets.

A task is one node of an agent's sub-agent tree, run on its own thread. Its
``graph_id`` names that node exactly (plan 41 §3.2)::

    <agent_slug>@<definition_version>:<sub>/<subsub>/...

Path segments are URL-quoted, so a sub-agent name may hold any character. The
version is the agent definition's fingerprint at the moment the root run was
built, which is what lets the runner rebuild the *same* tree for every later
run of the task even if the agent is edited meanwhile (``utils.agents``).

This module is pure: no I/O, no runner. ``harness.abstractions.deep_agent``
imports it, so it must stay import-cycle free (it never imports the runner).
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote, unquote

from deepagents import GeneralPurposeSubagentProfile, HarnessProfile, register_harness_profile
from deepagents.middleware.subagents import GENERAL_PURPOSE_SUBAGENT

from core.logging import get_logger
from core.security.internal_trust import internal_service_headers
from core.settings import settings
from harness.abstractions.subagent_tree import SUBAGENTS_KEY
from harness.async_tasks.token import LAUNCH_TOKEN_HEADER, InheritedContext

logger = get_logger(__name__)

#: deepagents' general-purpose sub-agent. Every agent has it at the top level,
#: declared or not, exactly as with the blocking ``task`` tool.
GENERAL_PURPOSE_NAME: str = GENERAL_PURPOSE_SUBAGENT["name"]

#: The path prefix the Agent Protocol router is mounted at.
PROTOCOL_PREFIX = "/ap"

# Model specs whose auto-added *blocking* general-purpose sub-agent has been
# switched off in deepagents' harness profile (process-wide, flag on only).
_gp_disabled: set[str] = set()


class UnknownTaskNode(ValueError):
    """A graph id or path names no node of the agent's sub-agent tree."""


@dataclass(frozen=True)
class TaskNode:
    """The node of the tree a task run builds, set on the agent by the runner.

    With it set, ``DeepAgent.build_deep_agent`` builds that sub-agent — its
    model, tools, prompt and gates resolved down the tree exactly as the
    blocking path resolves them — instead of the agent's main loop. The
    identity fields are the task row's; they sign the launch token its own
    children are started with.
    """
    task_id: str
    depth: int
    path: tuple[str, ...]
    user_id: str
    conversation_id: str
    root_run_id: str
    branch_thread_id: str
    agent_slug: str
    definition_version: str
    inherited: InheritedContext


def encode_path(path: Sequence[str]) -> str:
    """A tree path as the ``graph_id`` tail: quoted segments joined by ``/``."""
    return "/".join(quote(str(segment), safe="") for segment in path)


def decode_path(text: str) -> list[str]:
    """The inverse of :func:`encode_path`."""
    return [unquote(segment) for segment in text.split("/")] if text else []


def display_path(path: Sequence[str]) -> str:
    """The path as people read it (``researcher/helper``), for ``TaskOut``."""
    return "/".join(str(segment) for segment in path)


def graph_id_for(agent_slug: str, definition_version: str, path: Sequence[str]) -> str:
    """The ``graph_id`` of one node of one agent's tree."""
    return f"{agent_slug}@{definition_version}:{encode_path(path)}"


def protocol_url() -> str:
    """The base URL the middleware's client is given (served in process)."""
    return f"{settings.async_tasks.self_url.rstrip('/')}{PROTOCOL_PREFIX}"


def general_purpose_spec(skills: Sequence[Any] | None) -> dict[str, Any]:
    """deepagents' general-purpose sub-agent as a tree node: inherits the model
    and tools above it, and gets the agent's skills, as the blocking one does."""
    spec: dict[str, Any] = dict(GENERAL_PURPOSE_SUBAGENT)
    if skills:
        spec["skills"] = list(skills)
    return spec


def top_level(subagents: Sequence[Any] | None, skills: Sequence[Any] | None) -> list[Mapping[str, Any]]:
    """The agent's own sub-agents, with the general-purpose one added when the
    agent does not declare it (the same rule as the blocking path)."""
    level = [spec for spec in (subagents or []) if isinstance(spec, Mapping)]
    if not any(spec.get("name") == GENERAL_PURPOSE_NAME for spec in level):
        level.insert(0, general_purpose_spec(skills))
    return level


def supports_async(subagents: Any) -> bool:
    """Whether every node of the tree can run as a task.

    A pre-compiled sub-agent (``runnable``) is an opaque in-memory graph the
    runner cannot rebuild from a path, so a tree that holds one keeps the
    blocking path whole (logged), rather than half of it running async.
    """
    if subagents is None:
        return True
    if not isinstance(subagents, (list, tuple)):
        return False

    def check(level: Sequence[Any]) -> bool:
        for spec in level:
            if not isinstance(spec, Mapping) or "runnable" in spec:
                return False
            if not check(spec.get(SUBAGENTS_KEY) or []):
                return False
        return True

    return check(subagents)


def resolve_chain(
    subagents: Sequence[Any] | None, skills: Sequence[Any] | None, path: Sequence[str]
) -> list[Mapping[str, Any]]:
    """The specs from the top of the tree down to the node at ``path``.

    Raises :class:`UnknownTaskNode` for a path the tree does not hold, so a
    graph id can never name something the agent does not declare.
    """
    if not path:
        raise UnknownTaskNode("empty path")
    chain: list[Mapping[str, Any]] = []
    level: Sequence[Mapping[str, Any]] = top_level(subagents, skills)
    for segment in path:
        found = next((spec for spec in level if spec.get("name") == segment), None)
        if found is None:
            raise UnknownTaskNode(f"no sub-agent {segment!r} at this level")
        chain.append(found)
        level = [spec for spec in (found.get(SUBAGENTS_KEY) or []) if isinstance(spec, Mapping)]
    return chain


def disable_blocking_general_purpose(model: Any) -> None:
    """Switch off deepagents' auto-added blocking general-purpose sub-agent for ``model``.

    ``create_deep_agent`` adds it (and the ``task`` tool) to every agent unless
    the model's harness profile says otherwise; with async sub-agents on, the
    general-purpose sub-agent is an async task instead, so the blocking copy
    must not exist. The profile is the only override surface and is keyed by
    model spec (registration merges with the summarization exclusion). Only a
    string spec can be keyed; a model instance (tests) keeps the stock agent.
    """
    if not isinstance(model, str) or not model or model in _gp_disabled:
        return
    register_harness_profile(
        model, HarnessProfile(general_purpose_subagent=GeneralPurposeSubagentProfile(enabled=False))
    )
    _gp_disabled.add(model)
    logger.info("blocking_general_purpose_disabled", "Disabled the blocking general-purpose sub-agent", model=model)


def async_subagent_specs(
    children: Sequence[Mapping[str, Any]],
    *,
    agent_slug: str,
    definition_version: str,
    parent_path: Sequence[str],
    launch_token: str,
) -> list[dict[str, Any]]:
    """One deepagents ``AsyncSubAgent`` per child node.

    ``url`` is set on purpose (§3.2): deepagents then forwards no run context
    and gives the child no way to wake its parent itself — this service does
    both, from the task row. ``notify_parent=False`` says the same. The token
    rides every call; the internal-caller header satisfies ``/ap``'s gate.
    """
    headers = {**internal_service_headers(), LAUNCH_TOKEN_HEADER: launch_token}
    return [
        {
            "name": str(child["name"]),
            "description": str(child.get("description") or ""),
            "graph_id": graph_id_for(agent_slug, definition_version, [*parent_path, str(child["name"])]),
            "url": protocol_url(),
            "headers": dict(headers),
            "update_strategy": "interrupt",
            "notify_parent": False,
        }
        for child in children
    ]


def parse_graph_id(graph_id: str) -> tuple[str, str, list[str]] | None:
    """``(slug, version, path)`` of a graph id, or ``None`` when malformed."""
    head, sep, tail = graph_id.partition(":")
    slug, at, version = head.partition("@")
    if not sep or not at or not slug or not version or not tail:
        return None
    return slug, version, decode_path(tail)


__all__ = [
    "GENERAL_PURPOSE_NAME",
    "PROTOCOL_PREFIX",
    "TaskNode",
    "UnknownTaskNode",
    "async_subagent_specs",
    "decode_path",
    "disable_blocking_general_purpose",
    "display_path",
    "encode_path",
    "general_purpose_spec",
    "graph_id_for",
    "parse_graph_id",
    "protocol_url",
    "resolve_chain",
    "supports_async",
    "top_level",
]
