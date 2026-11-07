"""Working with files without wasting steps.

Without guidance a model writes a document from inside a shell command
(a `python -c` script holding the whole text), runs it, counts the words, and
writes the whole file again to change a few — six sandbox calls, each needing the user's
approval, for a 150-word note. It also reads "about 150 words" as "exactly
150" and keeps rewriting until it lands on the number.

This section asks for the cheap loop instead: write with `write_file`, measure
once, fix with `edit_file`, and treat a target as a target. It applies to the
agent the user talks to and to every background sub-agent (they share the
conversation's files), so it is gated on a conversation only; the `execute`
line is added only where the sandbox is on.
"""
from __future__ import annotations

from harness.prompt_engineering.context import PromptContext

_HEADER = "## Work Efficiently With Files"

_BODY = """\
- **Write a file with `write_file`** and change it with `edit_file`. Never build
  a file's content inside a shell command (`python -c`, heredocs): it is slow,
  error-prone, and every such call can need the user's approval.
- **Revise in small steps**: write the draft once, check it, then fix only what
  is off with `edit_file`. Don't rewrite the whole file to change a few words.
- **Treat a target as a target**: "about 150 words" or "around two pages" means
  roughly that, within about 10%; be exact only when asked for an exact number.
  After two revisions, stop and say where it landed."""

_SANDBOX = """\
- **Use `execute` to check, not to write**: one short command such as
  `wc -w /conversation/output/brief.md` measures a file you wrote with
  `write_file`."""


def efficiency_prompt(context: PromptContext) -> str:
    """The file-work habits block for this run. Empty without a conversation."""
    if not context.has_conversation:
        return ""
    body = f"{_BODY}\n{_SANDBOX}" if context.sandbox_enabled else _BODY
    return f"{_HEADER}\n\n{body}"


__all__ = ["efficiency_prompt"]
