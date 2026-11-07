"""The prebuilt-tool roster: every tool a deep agent has that is not an MCP tool.

Two origins, one roster. The **framework** tools are constructed inside
``create_deep_agent``, downstream of the tool list we hand it, so we never hold
them and cannot filter them — only ``interrupt_on`` reaches them. The **native**
tools are ours (``harness/tools/registry.py`` owns their builders), but the
Agents tab is not where their presence is decided either.

That is why a builtin's approval is configurable and its enablement never is —
with one exception: a tool whose call *is* the human step (``ask_user``) is
never gated, since an approval in front of a question would ask twice.

Descriptions for native tools are not duplicated here — the catalog reads them
from the registry, which owns them.
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any


class Availability(str, Enum):
    """What a builtin's presence in a given run depends on."""

    ALWAYS = "always"
    USE_MEMORY = "use_memory"
    SEARCH_PAST_CONVS = "search_past_convs"
    CONVERSATION = "conversation"
    SANDBOX = "sandbox"
    #: The async task tools (plan 41): only where async sub-agents are on.
    ASYNC_SUBAGENTS = "async_subagents"
    #: The blocking ``task`` tool: only while async sub-agents are off.
    SYNC_SUBAGENTS = "sync_subagents"


_UNAVAILABLE_REASON: dict[Availability, str] = {
    Availability.USE_MEMORY: "Memory is off in Personalization.",
    Availability.SEARCH_PAST_CONVS: "Past-conversation search is off in Personalization.",
    Availability.CONVERSATION: "Needs a conversation.",
    Availability.SANDBOX: "Sandboxed execution is disabled on this deployment.",
    Availability.ASYNC_SUBAGENTS: "Background sub-agents are off on this deployment.",
    Availability.SYNC_SUBAGENTS: "Replaced by start_async_task: sub-agents run in the background.",
}


@dataclass(frozen=True)
class BuiltinTool:
    """One prebuilt tool: where it belongs, how it gates, when it exists."""

    name: str
    group: str
    description: str = ""
    hitl_default: bool = False
    #: Approval cannot be turned off by anyone. Enforced last in the merge.
    locked: bool = False
    #: Approval can never be turned on: the call is itself a pause for the user.
    #: Stripped after every layer of the merge, so no gate can reach it.
    gateable: bool = True
    availability: Availability = Availability.ALWAYS


#: deepagents' tool that starts a background sub-agent (plan 41). It owns the
#: delegation gate ``task`` had.
START_ASYNC_TASK_TOOL_NAME = "start_async_task"

#: Gate keys that are one gate under two names: ``task`` (blocking delegation)
#: and ``start_async_task`` (its async successor) both mean "ask before
#: delegating". The bridge migrated stored preferences ``task`` ->
#: ``start_async_task`` and stored agent definitions may still say ``task``, so
#: whichever spelling a layer uses must gate whichever tool the run has —
#: ``task`` while ``ASYNC_SUBAGENTS_ENABLED`` is off, ``start_async_task`` once
#: it is on. Symmetric on purpose (see ``gates.with_gate_aliases``).
GATE_ALIASES: dict[str, str] = {
    "task": START_ASYNC_TASK_TOOL_NAME,
    START_ASYNC_TASK_TOOL_NAME: "task",
}

#: Deprecated gate keys an agent definition may still use, and the key they are
#: rewritten to on load (``AgentSpec``). Accepted for one release after plan 41.
DEPRECATED_GATE_KEYS: dict[str, str] = {"task": START_ASYNC_TASK_TOOL_NAME}

#: deepagents' sandbox tool. Named once so the approval merge can force its
#: gate by name (``gates.resolve_interrupt_on``) and validation can refuse a
#: definition that tries to clear it.
EXECUTE_TOOL_NAME = "execute"

BUILTIN_TOOLS: tuple[BuiltinTool, ...] = (
    BuiltinTool("write_todos", "Planning", "Track a structured task list for the run."),
    BuiltinTool("ls", "Filesystem", "List a directory."),
    BuiltinTool("read_file", "Filesystem", "Read a file, including images and PDFs."),
    BuiltinTool("glob", "Filesystem", "Find files by pattern."),
    BuiltinTool("grep", "Filesystem", "Search text across files."),
    BuiltinTool("write_file", "Filesystem", "Create a file in the conversation workspace.", hitl_default=True),
    BuiltinTool("edit_file", "Filesystem", "Replace text in an existing file.", hitl_default=True),
    BuiltinTool(
        EXECUTE_TOOL_NAME,
        "Execution",
        "Run a shell command in an isolated sandbox (no network; the conversation's "
        "input/ read-only, output/ writable). Always asks for approval.",
        hitl_default=True,
        locked=True,
        availability=Availability.SANDBOX,
    ),
    BuiltinTool(
        "task",
        "Delegation",
        "Delegate to a sub-agent.",
        hitl_default=True,
        availability=Availability.SYNC_SUBAGENTS,
    ),
    # deepagents' async sub-agent tools (plan 41). Starting a task takes over
    # `task`'s gate; following one up is driven by the user through the
    # orchestrator, so those are not gated by default.
    BuiltinTool(
        START_ASYNC_TASK_TOOL_NAME,
        "Delegation",
        "Start a sub-agent in the background; it returns at once.",
        hitl_default=True,
        availability=Availability.ASYNC_SUBAGENTS,
    ),
    BuiltinTool(
        "check_async_task",
        "Delegation",
        "Check a background sub-agent's status and result.",
        availability=Availability.ASYNC_SUBAGENTS,
    ),
    BuiltinTool(
        "update_async_task",
        "Delegation",
        "Send a background sub-agent a follow-up instruction.",
        availability=Availability.ASYNC_SUBAGENTS,
    ),
    BuiltinTool(
        "cancel_async_task",
        "Delegation",
        "Stop a background sub-agent.",
        availability=Availability.ASYNC_SUBAGENTS,
    ),
    BuiltinTool(
        "list_async_tasks",
        "Delegation",
        "List the background sub-agents and their status.",
        availability=Availability.ASYNC_SUBAGENTS,
    ),
    BuiltinTool("remember", "Memory", availability=Availability.USE_MEMORY),
    BuiltinTool("forget", "Memory", hitl_default=True, availability=Availability.USE_MEMORY),
    BuiltinTool(
        "search_past_conversations", "Memory", availability=Availability.SEARCH_PAST_CONVS
    ),
    BuiltinTool("view_image", "Filesystem", availability=Availability.CONVERSATION),
    BuiltinTool("render_chart", "Output"),
    BuiltinTool("present_artifact", "Output", availability=Availability.CONVERSATION),
    BuiltinTool("create_skill", "Skills", hitl_default=True),
    BuiltinTool("ask_user", "Interaction", gateable=False, availability=Availability.CONVERSATION),
)

BUILTIN_BY_NAME: dict[str, BuiltinTool] = {t.name: t for t in BUILTIN_TOOLS}


def is_builtin(name: str) -> bool:
    """Whether ``name`` is a prebuilt tool rather than an MCP one."""
    return name in BUILTIN_BY_NAME


def builtin_hitl_defaults() -> dict[str, bool]:
    """Approval gates every deep agent starts with, before any user choice."""
    return {t.name: True for t in BUILTIN_TOOLS if t.hitl_default or t.locked}


def locked_gates() -> dict[str, bool]:
    """Gates no layer may clear. Merged last, after the user's choices."""
    return {t.name: True for t in BUILTIN_TOOLS if t.locked}


#: Tools only the main agent has: sub-agents are built without them
#: (``deep_agent._without_ask_user``) — a question goes to the person, and only
#: the main agent talks to them.
MAIN_ONLY_TOOLS: frozenset[str] = frozenset({"ask_user"})


def _deployment_has(tool: BuiltinTool, *, sandbox_enabled: bool, async_subagents: bool) -> bool:
    """Whether this deployment can give any run ``tool`` at all."""
    if tool.availability is Availability.SANDBOX:
        return sandbox_enabled
    if tool.availability is Availability.ASYNC_SUBAGENTS:
        return async_subagents
    if tool.availability is Availability.SYNC_SUBAGENTS:
        return not async_subagents
    return True


def replaced_by_delegation_mode(tool: BuiltinTool, *, async_subagents: bool) -> bool:
    """Whether ``tool`` belongs to the delegation mode this deployment does not
    run: ``task`` while async sub-agents are on, the five async task tools while
    they are off. Such a tool is not "unavailable for this run" — no run here
    can have it — so the tool lists leave it out rather than greying it."""
    if tool.availability is Availability.SYNC_SUBAGENTS:
        return async_subagents
    if tool.availability is Availability.ASYNC_SUBAGENTS:
        return not async_subagents
    return False


def builtin_tool_catalog(
    *, sandbox_enabled: bool = False, async_subagents: bool = False
) -> list[dict[str, Any]]:
    """Every prebuilt tool as the agent builder lists it (``GET /builtin-tools``):
    what it does, its group, and how its approval behaves.

    A sandbox-only tool (``execute``) is listed only where sandboxed execution
    is active, and the delegation tools only in the mode the deployment runs —
    ``task`` while async sub-agents are off, the five async task tools once
    they are on — so the builder never offers a gate for a tool no run can
    have. They all stay in :data:`BUILTIN_BY_NAME` either way — that roster is
    also the reserved-name list MCP tools are filtered against."""
    return [
        {
            "name": t.name,
            "description": t.description,
            "group": t.group,
            "hitlDefault": t.hitl_default or t.locked,
            "locked": t.locked,
            "gateable": t.gateable,
            "mainOnly": t.name in MAIN_ONLY_TOOLS,
        }
        for t in BUILTIN_TOOLS
        if _deployment_has(t, sandbox_enabled=sandbox_enabled, async_subagents=async_subagents)
    ]


def ungateable_tools() -> frozenset[str]:
    """Tools no layer may gate. Removed after the merge, locked gates included."""
    return frozenset(t.name for t in BUILTIN_TOOLS if not t.gateable)


def resolve_availability(
    tool: BuiltinTool,
    *,
    use_memory: bool,
    search_past_convs: bool,
    has_conversation: bool,
    sandbox_enabled: bool,
    async_subagents: bool = False,
) -> tuple[bool, str | None]:
    """Whether this run actually has ``tool``, and why not when it does not.

    ``async_subagents`` defaults to off — today's blocking ``task`` — until the
    caller reads the deployment flag (plan 41)."""
    present = {
        Availability.ALWAYS: True,
        Availability.USE_MEMORY: use_memory,
        Availability.SEARCH_PAST_CONVS: search_past_convs,
        Availability.CONVERSATION: has_conversation,
        Availability.SANDBOX: sandbox_enabled,
        Availability.ASYNC_SUBAGENTS: async_subagents,
        Availability.SYNC_SUBAGENTS: not async_subagents,
    }[tool.availability]
    return present, None if present else _UNAVAILABLE_REASON[tool.availability]


__all__ = [
    "BUILTIN_BY_NAME",
    "BUILTIN_TOOLS",
    "MAIN_ONLY_TOOLS",
    "Availability",
    "BuiltinTool",
    "DEPRECATED_GATE_KEYS",
    "EXECUTE_TOOL_NAME",
    "GATE_ALIASES",
    "START_ASYNC_TASK_TOOL_NAME",
    "builtin_hitl_defaults",
    "replaced_by_delegation_mode",
    "builtin_tool_catalog",
    "is_builtin",
    "locked_gates",
    "resolve_availability",
    "ungateable_tools",
]
