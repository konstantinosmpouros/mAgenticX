"""Building a deep agent's system prompt.

The counterpart to ``harness/tools``: that package decides which tools a run
has, this one decides what the run is *told* it has. The two are driven by the
same flags, so the prompt can never advertise a mount or a verb the run lacks.

    from harness.prompt_engineering import PromptContext, compose_system_prompt

    prompt = compose_system_prompt(agent_instructions, PromptContext(...))

Scope is deliberately narrow. Only what is true of *every* deep agent lives
here — the workspace layout, the platform verbs, memory, the clock. Anything
that depends on how one agent is built (its delegation strategy, when it should
chart, its persona) stays in that agent's own instructions, which this package
appends to and never rewrites.
"""
from harness.prompt_engineering.composer import (
    compose_system_prompt,
    describe_sections,
    platform_sections,
)
from harness.prompt_engineering.context import PromptContext

__all__ = [
    "PromptContext",
    "compose_system_prompt",
    "describe_sections",
    "platform_sections",
]
