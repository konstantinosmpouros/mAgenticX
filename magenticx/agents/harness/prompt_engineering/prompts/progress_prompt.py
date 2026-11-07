"""Working out loud: short updates to the user between tool calls.

Without guidance a model tends to go silent through every tool call and
delegation and speak only once, at the end. In the chat that reads as a wall
of tool rows with no explanation of why each one ran. This section asks for
the opposite rhythm: say what you are about to do, act, say what you found and
what comes next, act again, then answer.

The updates are ordinary assistant text, so the chat renders them between the
tool rows with no extra plumbing. The wording keeps them short and tied to real
progress, so the habit does not turn into filler or repeat the final answer.

Gated on ``narrate_progress``: every deep agent run in a conversation. A
background task (``narrate_as_subagent``) narrates too, for its task panel, in
its own wording: its last message is the result handed back to its parent, not
an answer in the user's chat.
"""
from __future__ import annotations

from harness.prompt_engineering.context import PromptContext

_HEADER = "## Keep the User in the Loop While You Work"

_BODY = """\
The user watches your work live: every message you write appears in the chat
between your tool calls. Narrate it briefly instead of working in silence and
speaking only at the end.

- **Before you start** a task that needs tools, say in one sentence what you are
  going to do first.
- **Between steps**, after a tool call or a group of related calls, write one or
  two sentences: what you found or what changed, and what you will do next.
  Group related calls (several reads, a batch of searches) under one update;
  don't comment on every trivial call.
- **Before you delegate** to sub-agents, say what you are handing off, to whom,
  and why. When their results come back, say what they changed before you
  continue.
- **When the plan changes**, because a result surprised you or something
  failed, say so and say what you will try instead.
- **At the end**, give the complete final answer. Don't repeat the progress
  updates; the answer should stand on its own.

Keep the updates short, concrete and in the user's language. They are for a
person following along, not a log: no filler such as "Let me now…" or "Great!",
and no restating of the request. For a simple question you can answer without
tools, just answer."""


_SUBAGENT_HEADER = "## Narrate Your Work as You Go"

#: For a background sub-agent task. The user follows it in its task panel; its
#: final message is not a chat answer but the result its parent receives.
_SUBAGENT_BODY = """\
You are a sub-agent working in the background. The user can follow your work
live in your task panel: every message you write between tool calls appears
there. Narrate it briefly instead of working in silence.

- **Before you start** work that needs tools, say in one sentence what you are
  going to do first.
- **Between steps**, after a tool call or a group of related calls, write one or
  two sentences: what you found or what changed, and what you will do next.
  Group related calls under one update; don't comment on every trivial call.
- **Before you delegate** to sub-agents of your own, say what you are handing
  off, to whom, and why. When their results come back, say what they changed.
- **When the plan changes**, because a result surprised you or something
  failed, say so and say what you will try instead.
- **Your final message is your result**: it is handed back to the agent that
  started you. Make it complete and self-contained, in the format you were
  asked for, and don't repeat the progress updates in it.

Keep the updates short and concrete, in the language of your task. No filler
such as "Let me now…" or "Great!". For a task you can finish without tools,
just return the result."""


def progress_prompt(context: PromptContext) -> str:
    """The narrate-your-work block for this run. Empty when it is off."""
    if not context.narrate_progress:
        return ""
    if context.narrate_as_subagent:
        return f"{_SUBAGENT_HEADER}\n\n{_SUBAGENT_BODY}"
    return f"{_HEADER}\n\n{_BODY}"


__all__ = ["progress_prompt"]
