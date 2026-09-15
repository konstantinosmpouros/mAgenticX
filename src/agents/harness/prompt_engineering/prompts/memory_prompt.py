"""Long-term memory, described only when it is actually mounted.

Gated on ``use_memory`` for a reason that predates this package: with the
toggle off, an agent told about `/memories/` would confidently claim to read
`/memories/AGENTS.md` and fail. The section and the mount come from one flag.

Cross-conversation search is a separate opt-in and therefore a separate
paragraph — a run can have memory without it, and the reverse.
"""
from __future__ import annotations

from harness.prompt_engineering.context import PromptContext

_HEADER = "## Your Long-Term Memory"

_BODY = """\
You have a persistent memory about THIS user, private to you and carried across
every conversation you have with them:

- `/memories/AGENTS.md` — your memory **index**, loaded into your context
  automatically at the start of each conversation. Each row is
  `- **<name>** — <summary>`, one per saved memory.
- When a row looks relevant, read its full detail with
  `read_file /memories/entries/<name>.yml`.
- To save something durable (a preference, an ongoing project, a key person, a
  decision, an important date), call `remember` with a short `name`, a one-line
  `summary`, and the full `content`. Re-using a `name` updates that memory in
  place.
- To drop one that is wrong or obsolete, call `forget` with its `name`. That is
  permanent — to correct a memory instead, `remember` it again under the same
  name.

Save only durable, reusable facts — never transient chatter. This memory is the
only thing that outlives the current conversation (your `/conversation/`
workspace does not carry over)."""

_PAST_CONVERSATIONS = """\

You can also search what you and this user said in **earlier conversations**
with `search_past_conversations`. Reach for it when they refer back to
something that is not in your memory index and not in this chat."""


def memory_prompt(context: PromptContext) -> str:
    """The memory block for this run. Empty when memory is off."""
    if not context.use_memory:
        # `search_past_conversations` is its own gate, but with memory off there
        # is no memory section to hang it on; the tool's own description carries
        # it in that case.
        return ""
    body = _BODY
    if context.search_past_convs:
        body = f"{body}\n{_PAST_CONVERSATIONS}"
    return f"{_HEADER}\n\n{body}"


__all__ = ["memory_prompt"]
