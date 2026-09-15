"""The platform verbs a model cannot guess it has.

Scope rule for this section: a tool belongs here only when knowing *that it
exists* changes what the agent does, and its own description cannot convey that.
`read_file` needs no help. `present_artifact` does — an agent that has not been
told will write a report into `output/` and then paste it into the chat, and the
user never gets a file.

Everything here is gated on a conversation, because all three tools point into
the conversation mounts and are not attached without one.
"""
from __future__ import annotations

from harness.prompt_engineering.context import PromptContext

_HEADER = "## What You Can Do Beyond Text"

_BODY = """\
- **Look at an image** with `view_image` on a path under `/conversation/input/`
  or `/conversation/output/`. It shows you the picture directly. When a detail
  is too small to read, call it again on the same path with a `region` to zoom
  in — the result tells you the pixel dimensions to aim at, and each call is a
  fresh look.
- **Hand over a document** with `present_artifact`, after writing the file to
  `/conversation/output/`. A file left in `output/` is invisible to the user;
  presenting it drops a downloadable card into the conversation at that point,
  so do it as each document becomes ready and keep writing around it. Never
  paste a document's full contents into the chat instead. Present only finished
  work — never scratch notes or intermediate drafts — and present a given file
  once.
- **Draw a chart** with `render_chart` when a comparison, trend or breakdown is
  the point. It renders inline in your reply and is **not a file** — it needs
  no `write_file` and no `present_artifact`. Prefer it to a column of numbers or
  an ASCII bar chart. Never set colors: they follow the user's theme and stay
  readable in both light and dark mode. After drawing one, say what it shows in
  a sentence or two rather than restating every value.
  The chart types and their modifiers are in the tool's own schema — read it
  there rather than guessing."""

_SANDBOX = """\
- **Run code** with `execute`. It requires the user's approval on every call."""

#: Platform-wide, but only meaningful to an agent that can delegate: the AG-UI
#: normalizer emits PRESENT_ARTIFACT for the top-level agent only, so a
#: sub-agent's call reaches nobody. Stating it to an agent with no sub-agents
#: would describe a situation it cannot be in.
_ORCHESTRATOR = """\
- When a **sub-agent** produces a document, you present it. Its `write` returns
  a filename; you review that file, then call `present_artifact` yourself. A
  `present_artifact` call made by a sub-agent is ignored, and the user never
  sees the file."""


def capabilities_prompt(context: PromptContext) -> str:
    """The non-obvious tool verbs for this run. Empty without a conversation."""
    if not context.has_conversation:
        return ""
    body = _BODY
    if context.has_subagents:
        body = f"{body}\n{_ORCHESTRATOR}"
    if context.sandbox_enabled:
        body = f"{body}\n{_SANDBOX}"
    return f"{_HEADER}\n\n{body}"


__all__ = ["capabilities_prompt"]
