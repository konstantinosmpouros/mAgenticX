"""What the agent's workspace is, described only where it exists.

This is the section whose absence caused an agent with a thin prompt to tell
the user it "cannot browse the local filesystem" — it had every mount and every
file tool, and had simply never been told. The platform agents did not hit it
because their hand-written prompts documented the layout; a user-authored agent
inherits nothing.

Deliberately not a tool manual. The file tools carry their own descriptions, so
restating them burns context for nothing; what the model cannot infer is the
*layout* — which route holds what, and which ones refuse writes.
"""
from __future__ import annotations

from harness.prompt_engineering.context import PromptContext

_HEADER = "## Your Workspace"

_INTRO = (
    "You have a real filesystem. Use `ls`, `read_file`, `glob` and `grep` on it "
    "rather than assuming you cannot reach files — these paths exist for this "
    "run:"
)

_CONVERSATION = """\
- `/conversation/input/` — files the user attached to THIS conversation.
  **Read-only.** An attached image also arrives inline in the message, but the
  file is here too, at full resolution.
- `/conversation/output/` — where you write anything the user should end up
  with. Writing here does not show it to them; see below.
- `/conversation/` — the rest of this conversation's scratch space. It is
  per-conversation: nothing you write here is visible in another chat."""

_REFERENCE = """\
- `/reference/` — your own definition folder: the notes, checklists and
  examples bundled with your instructions. **Read-only.** Worth an `ls` when a
  task sounds like something you were set up for."""

_DEFAULT_SKILLS = """\
- `/default_skills/` — the skills you ship with. **Read-only.**"""

_SKILLS = """\
- `/skills/` — skills the user enabled for you. **Read-only.**"""

_OUTRO = (
    "Before starting a task, `ls /conversation/input/` to see what the user "
    "gave you, and `ls /conversation/output/` for work already done in this "
    "chat."
)


def filesystem_prompt(context: PromptContext) -> str:
    """Describe the mounts this run has. Empty when it has none."""
    lines: list[str] = []
    if context.has_conversation:
        lines.append(_CONVERSATION)
    if context.has_reference:
        lines.append(_REFERENCE)
    if context.has_default_skills:
        lines.append(_DEFAULT_SKILLS)
    lines.append(_SKILLS)

    if not context.has_conversation and len(lines) == 1:
        # Only `/skills/` — a warmup or registry build, not a real run. A whole
        # section about one read-only mount is noise.
        return ""

    body = "\n".join(lines)
    outro = f"\n\n{_OUTRO}" if context.has_conversation else ""
    return f"{_HEADER}\n\n{_INTRO}\n\n{body}{outro}"


__all__ = ["filesystem_prompt"]
