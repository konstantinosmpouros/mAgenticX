"""Assemble a deep agent's system prompt: the user's instructions, plus ours.

The instructions are the base and stay first. Everything this module adds is
appended after them, so a user-authored agent keeps its own voice at the top of
the prompt and gains a factual description of what it is underneath.

Section order is fixed here rather than at each call site, so there is exactly
one answer to "what does the prompt look like":

1. the agent's own instructions (``AGENT.md``, or a code agent's constant)
2. personalization — the user's preset + custom instructions
3. the workspace — which mounts exist, which refuse writes
4. the platform verbs — ``view_image`` / ``present_artifact`` / ``render_chart`` / ``ask_user``,
   and background delegation (``start_async_task``) when async sub-agents are on
5. citations — how to cite the ``[src:ID]`` sources a search tool returns
6. efficient file work
7. working out loud — short updates to the user between tool calls
8. long-term memory
9. the current date and time

Stable sections first, volatile last: 1-8 are fixed for a given agent and run,
so a provider can cache that prefix, while 9 changes every minute. Reversing
those two would cost the cache on every request — see ``temporal_prompt``.

Every section returns "" when its feature is off, so an agent with nothing
enabled composes to exactly its own instructions.
"""
from __future__ import annotations

from harness.prompt_engineering.context import PromptContext
from harness.prompt_engineering.prompts.capabilities_prompt import capabilities_prompt
from harness.prompt_engineering.prompts.citations_prompt import citations_prompt
from harness.prompt_engineering.prompts.efficiency_prompt import efficiency_prompt
from harness.prompt_engineering.prompts.filesystem_prompt import filesystem_prompt
from harness.prompt_engineering.prompts.memory_prompt import memory_prompt
from harness.prompt_engineering.prompts.progress_prompt import progress_prompt
from harness.prompt_engineering.prompts.temporal_prompt import temporal_prompt

#: The platform sections, in composition order. A section is `(name, builder)`;
#: the name is what `describe_sections` reports, which is what makes "why does
#: this agent's prompt say X" answerable without re-deriving the order.
_SECTIONS = (
    ("filesystem", filesystem_prompt),
    ("capabilities", capabilities_prompt),
    ("citations", citations_prompt),
    ("efficiency", efficiency_prompt),
    ("progress", progress_prompt),
    ("memory", memory_prompt),
    ("temporal", temporal_prompt),
)


def platform_sections(context: PromptContext) -> list[tuple[str, str]]:
    """The non-empty platform sections for this run, in order, with their names."""
    out: list[tuple[str, str]] = []
    if context.personalization:
        out.append(("personalization", context.personalization))
    for name, build in _SECTIONS:
        text = build(context)
        if text:
            out.append((name, text))
    return out


def compose_system_prompt(instructions: str | None, context: PromptContext) -> str:
    """Return the agent's full system prompt for this run.

    ``instructions`` is the agent's own — it leads, and is never rewritten or
    trimmed. Passing nothing is legitimate (a run with no authored prompt) and
    yields the platform sections alone.
    """
    parts = [text for _, text in platform_sections(context)]
    base = (instructions or "").strip()
    if base:
        parts.insert(0, base)
    return "\n\n".join(parts)


#: What a background sub-agent task adds to its own instructions. Not the main
#: agent's whole set: the workspace, the platform verbs (``present_artifact``
#: is ignored from a sub-agent) and memory are the main agent's; a task gets
#: how to cite what it searched (its result keeps the markers, so the
#: orchestrator can carry them into its answer), how to work with the shared
#: files and how to narrate for its task panel.
_TASK_SECTIONS = (
    ("citations", citations_prompt),
    ("efficiency", efficiency_prompt),
    ("progress", progress_prompt),
)


def task_sections(context: PromptContext) -> list[tuple[str, str]]:
    """The non-empty sections a background task's prompt gets, in order."""
    return [(name, text) for name, build in _TASK_SECTIONS if (text := build(context))]


def compose_task_prompt(instructions: str | None, context: PromptContext) -> str:
    """A background task's system prompt: its own instructions (already with
    its delegation section, if it delegates), then the task sections."""
    parts = [text for _, text in task_sections(context)]
    base = (instructions or "").strip()
    if base:
        parts.insert(0, base)
    return "\n\n".join(parts)


def describe_sections(context: PromptContext) -> list[str]:
    """Names of the sections this run would append. For logging, not for prompts."""
    return [name for name, _ in platform_sections(context)]


__all__ = ["compose_system_prompt", "compose_task_prompt", "describe_sections", "platform_sections", "task_sections"]
