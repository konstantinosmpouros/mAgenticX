"""Assemble a deep agent's system prompt: the user's instructions, plus ours.

The instructions are the base and stay first. Everything this module adds is
appended after them, so a user-authored agent keeps its own voice at the top of
the prompt and gains a factual description of what it is underneath.

Section order is fixed here rather than at each call site, so there is exactly
one answer to "what does the prompt look like":

1. the agent's own instructions (``AGENT.md``, or a code agent's constant)
2. personalization — the user's preset + custom instructions
3. the workspace — which mounts exist, which refuse writes
4. the platform verbs — ``view_image`` / ``present_artifact`` / ``render_chart``
5. long-term memory
6. the current date and time

Stable sections first, volatile last: 1-5 are fixed for a given agent and run,
so a provider can cache that prefix, while 6 changes every minute. Reversing
those two would cost the cache on every request — see ``temporal_prompt``.

Every section returns "" when its feature is off, so an agent with nothing
enabled composes to exactly its own instructions.
"""
from __future__ import annotations

from harness.prompt_engineering.context import PromptContext
from harness.prompt_engineering.prompts.capabilities_prompt import capabilities_prompt
from harness.prompt_engineering.prompts.filesystem_prompt import filesystem_prompt
from harness.prompt_engineering.prompts.memory_prompt import memory_prompt
from harness.prompt_engineering.prompts.temporal_prompt import temporal_prompt

#: The platform sections, in composition order. A section is `(name, builder)`;
#: the name is what `describe_sections` reports, which is what makes "why does
#: this agent's prompt say X" answerable without re-deriving the order.
_SECTIONS = (
    ("filesystem", filesystem_prompt),
    ("capabilities", capabilities_prompt),
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


def describe_sections(context: PromptContext) -> list[str]:
    """Names of the sections this run would append. For logging, not for prompts."""
    return [name for name, _ in platform_sections(context)]


__all__ = ["compose_system_prompt", "describe_sections", "platform_sections"]
