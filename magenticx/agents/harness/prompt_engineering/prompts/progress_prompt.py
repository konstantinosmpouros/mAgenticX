"""Working out loud: short updates to the user between tool calls.

Without guidance a model tends to go silent through every tool call and
delegation and speak only once, at the end. In the chat that reads as a wall
of tool rows with no explanation of why each one ran. This section asks for
the opposite rhythm: say what you are about to do, act, say what you found and
what comes next, act again, then answer.

The updates are ordinary assistant text, so the chat renders them between the
tool rows with no extra plumbing. The wording keeps them short and tied to real
progress, so the habit does not turn into filler or repeat the final answer.

Gated on ``narrate_progress``: the agent the user talks to in a conversation.
A background task's text is not the user's conversation (its last message is
the result handed back to its parent), so task runs leave it off.
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


def progress_prompt(context: PromptContext) -> str:
    """The narrate-your-work block for this run. Empty when it is off."""
    if not context.narrate_progress:
        return ""
    return f"{_HEADER}\n\n{_BODY}"


__all__ = ["progress_prompt"]
