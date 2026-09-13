"""The prebuilt-tool roster: every tool a deep agent has that is not an MCP tool.

Two origins, one roster. The **framework** tools are constructed inside
``create_deep_agent``, downstream of the tool list we hand it, so we never hold
them and cannot filter them — only ``interrupt_on`` reaches them. The **native**
tools are ours (``harness/tools/registry.py`` owns their builders), but the
Agents tab is not where their presence is decided either.

That is why a builtin's approval is configurable and its enablement never is.

Descriptions for native tools are not duplicated here — the catalog reads them
from the registry, which owns them.
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class Availability(str, Enum):
    """What a builtin's presence in a given run depends on."""

    ALWAYS = "always"
    USE_MEMORY = "use_memory"
    SEARCH_PAST_CONVS = "search_past_convs"
    CONVERSATION = "conversation"
    SANDBOX = "sandbox"


_UNAVAILABLE_REASON: dict[Availability, str] = {
    Availability.USE_MEMORY: "Memory is off in Personalization.",
    Availability.SEARCH_PAST_CONVS: "Past-conversation search is off in Personalization.",
    Availability.CONVERSATION: "Needs a conversation.",
    Availability.SANDBOX: "Sandboxed execution is disabled on this deployment.",
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
    availability: Availability = Availability.ALWAYS


BUILTIN_TOOLS: tuple[BuiltinTool, ...] = (
    BuiltinTool("write_todos", "Planning", "Track a structured task list for the run."),
    BuiltinTool("ls", "Filesystem", "List a directory."),
    BuiltinTool("read_file", "Filesystem", "Read a file, including images and PDFs."),
    BuiltinTool("glob", "Filesystem", "Find files by pattern."),
    BuiltinTool("grep", "Filesystem", "Search text across files."),
    BuiltinTool("write_file", "Filesystem", "Create a file in the conversation workspace.", hitl_default=True),
    BuiltinTool("edit_file", "Filesystem", "Replace text in an existing file.", hitl_default=True),
    BuiltinTool(
        "execute",
        "Execution",
        "Run code in the sandbox.",
        hitl_default=True,
        locked=True,
        availability=Availability.SANDBOX,
    ),
    BuiltinTool("task", "Delegation", "Delegate to a sub-agent.", hitl_default=True),
    BuiltinTool("remember", "Memory", availability=Availability.USE_MEMORY),
    BuiltinTool("forget", "Memory", hitl_default=True, availability=Availability.USE_MEMORY),
    BuiltinTool(
        "search_past_conversations", "Memory", availability=Availability.SEARCH_PAST_CONVS
    ),
    BuiltinTool("render_chart", "Output"),
    BuiltinTool("present_artifact", "Output", availability=Availability.CONVERSATION),
    BuiltinTool("create_skill", "Skills", hitl_default=True),
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


def resolve_availability(
    tool: BuiltinTool,
    *,
    use_memory: bool,
    search_past_convs: bool,
    has_conversation: bool,
    sandbox_enabled: bool,
) -> tuple[bool, str | None]:
    """Whether this run actually has ``tool``, and why not when it does not."""
    present = {
        Availability.ALWAYS: True,
        Availability.USE_MEMORY: use_memory,
        Availability.SEARCH_PAST_CONVS: search_past_convs,
        Availability.CONVERSATION: has_conversation,
        Availability.SANDBOX: sandbox_enabled,
    }[tool.availability]
    return present, None if present else _UNAVAILABLE_REASON[tool.availability]


__all__ = [
    "BUILTIN_BY_NAME",
    "BUILTIN_TOOLS",
    "Availability",
    "BuiltinTool",
    "builtin_hitl_defaults",
    "is_builtin",
    "locked_gates",
    "resolve_availability",
]
