"""The platform verbs a model cannot guess it has.

Scope rule for this section: a tool belongs here only when knowing *that it
exists* changes what the agent does, and its own description cannot convey that.
`read_file` needs no help. `present_artifact` does — an agent that has not been
told will write a report into `output/` and then paste it into the chat, and the
user never gets a file.

Everything here is gated on a conversation, because these tools point into
the conversation mounts (or, for `ask_user`, pause it) and are not attached
without one.
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
  once. The user cannot open a path: when they ask for a file, or where it is,
  present it (again, if they ask again) — never answer with a path alone.
- **Draw a chart** with `render_chart` when a comparison, trend or breakdown is
  the point. It renders inline in your reply and is **not a file** — it needs
  no `write_file` and no `present_artifact`. Prefer it to a column of numbers or
  an ASCII bar chart. Never set colors: they follow the user's theme and stay
  readable in both light and dark mode. After drawing one, say what it shows in
  a sentence or two rather than restating every value.
  The chart types and their modifiers are in the tool's own schema — read it
  there rather than guessing."""

#: Only for an interactive run (``has_ask_user``): a scheduled task has nobody
#: to answer, so the tool is not attached and the rule would describe nothing.
_ASK_USER = """\
- **Ask the user** with `ask_user` when an answer would change what you do —
  the scope, which item they mean, how deep to go, a preference you cannot
  infer. Never ask for something you can find out yourself, and never end an
  answer with questions in prose instead. Ask 1-3 questions, each about one
  thing, with 2-5 short suggested answers when sensible; the user can always
  write their own, so never add an "Other" option. Call it alone and once,
  before doing the work, after at most one short sentence to the user; then
  stop — the run pauses, and the tool's result is the user's reply. Ask at
  most once per user message: once they have answered, do the work with what
  they gave you, even if it is vague, and state any assumption you still make
  instead of asking again. If they skip, carry on with reasonable assumptions
  and state them briefly."""

_SANDBOX = """\
- **Run code** with `execute`: a shell command in a fresh, isolated sandbox. It
  requires the user's approval on every call, so prefer one complete script over
  many small commands.
  - The user's uploads are at `/conversation/input/` (read-only), the same paths
    you see; write every result to `/conversation/output/` — those files come
    back to the conversation (then `present_artifact` them). Nothing else persists.
  - Python 3.12 with pandas, numpy, openpyxl, matplotlib, python-docx,
    python-pptx, reportlab and Pillow. No network and no `pip install`.
  - Limits: about a minute per call by default, 1 GB of memory."""

#: Platform-wide, but only meaningful to an agent that can delegate: the AG-UI
#: normalizer emits PRESENT_ARTIFACT for the top-level agent only, so a
#: sub-agent's call reaches nobody. Stating it to an agent with no sub-agents
#: would describe a situation it cannot be in.
_ORCHESTRATOR = """\
- When a **sub-agent** produces a document, you present it. Its result names
  the file it wrote to `/conversation/output/`; in the same turn you report
  that result, review the file and call `present_artifact` yourself. A
  `present_artifact` call made by a sub-agent is ignored, and the user never
  sees the file."""

#: For an orchestrator whose sub-agents run as background tasks (plan 41,
#: ``async_subagents``). deepagents' own async middleware lists the sub-agent
#: types and the tools' mechanics; this says how a turn should go around them:
#: the launch does not block, so the conversation goes on, and the result
#: arrives by itself — polling for it only burns turns.
_ASYNC_SUBAGENTS = """\
- **Delegate in the background** with `start_async_task`. It starts the
  sub-agent and returns a task id at once, while the sub-agent works on its
  own; it starts with nothing but your description, so put everything it needs
  there and say what it should return. Then keep talking with the user — say
  what you started, and do not wait for it.
  - You are notified when a task, and every sub-task it started, has finished;
    the notification carries the result. Do not poll: never call
    `check_async_task` or `list_async_tasks` in a loop. Use them only when the
    user asks how a task is going, or when you need its status to answer.
  - To clarify or change what a running task should do, send it
    `update_async_task` with its task id; it carries on with your new
    instruction. To stop one, `cancel_async_task`.
  - To **resume, continue or restart** a task — one that was stopped,
    failed or already finished — also use `update_async_task` with its task
    id: it picks up on the same thread with everything it has done so far.
    Never start a new task with `start_async_task` for work an existing task
    was doing; start a new one only when the user asks for a fresh, separate
    task.
  - A notification is not a message from the user. Report the result in your
    own words. A task waiting for the user's approval is theirs to answer —
    you cannot approve it for them, and you must not send it
    `update_async_task` to get it moving: it is not stuck. Tell the user it is
    waiting for their approval, and carry on with anything else."""


#: For a sub-agent that has sub-agents of its own. deepagents' `task` guidance
#: (when to delegate, how a sub-agent's life goes) reaches it through its own
#: SubAgentMiddleware, exactly as it reaches the main agent; this adds what is
#: different one level down: its reply is not the user's answer, and it cannot
#: hand a document to the user itself.
DELEGATING_SUBAGENT_PROMPT = """\
## Your Own Sub-agents

You are a sub-agent, and you can delegate parts of your task to sub-agents of
your own with the `task` tool. Each one starts with nothing but the task you
give it: put everything it needs in the description and say exactly what it
should return. Launch independent tasks together, and wait for every result
before you reply. Only your final message goes back to the agent that called
you, so fold your sub-agents' findings into it — including the paths of any
files they wrote; neither you nor they can present a file to the user."""

#: The same, for a task whose sub-agents run as background tasks too (plan 41):
#: the launch returns at once and each result arrives as a notification, so
#: "wait for every result" becomes "do not poll, you will be told".
DELEGATING_ASYNC_SUBAGENT_PROMPT = """\
## Your Own Sub-agents

You are a sub-agent, and you can delegate parts of your task to sub-agents of
your own with `start_async_task`. It returns a task id at once. Each one starts
with nothing but the description you give it: put everything it needs there
and say exactly what it should return. Start independent tasks together. You
are notified with each result when that task, and its own sub-tasks, finish —
do not poll `check_async_task` in a loop; if you end your turn while tasks are
still running, you are woken with their results. Send a clarification with
`update_async_task` — and use it too to resume or continue a task that was
stopped, failed or finished, rather than starting a new one for the same work —
but never on a task waiting for the user's approval: it continues when they
answer. Stop a task you no longer need with `cancel_async_task`. Only your final message goes back to the agent that
started you, so fold your sub-agents' findings into it — including the paths
of any files they wrote; neither you nor they can present a file to the user."""


def delegating_subagent_prompt(system_prompt: str | None, *, async_subagents: bool = False) -> str:
    """A sub-agent's own instructions, plus how to use its sub-agents.

    ``async_subagents`` picks the background-task wording (plan 41); off, the
    blocking ``task`` wording stays exactly as before.
    """
    section = DELEGATING_ASYNC_SUBAGENT_PROMPT if async_subagents else DELEGATING_SUBAGENT_PROMPT
    base = (system_prompt or "").strip()
    return f"{base}\n\n{section}" if base else section


def capabilities_prompt(context: PromptContext) -> str:
    """The non-obvious tool verbs for this run. Empty without a conversation."""
    if not context.has_conversation:
        return ""
    body = _BODY
    if context.has_subagents:
        body = f"{body}\n{_ORCHESTRATOR}"
        if context.async_subagents:
            body = f"{body}\n{_ASYNC_SUBAGENTS}"
    if context.has_ask_user:
        body = f"{body}\n{_ASK_USER}"
    if context.sandbox_enabled:
        body = f"{body}\n{_SANDBOX}"
    return f"{_HEADER}\n\n{body}"


__all__ = [
    "DELEGATING_ASYNC_SUBAGENT_PROMPT",
    "DELEGATING_SUBAGENT_PROMPT",
    "capabilities_prompt",
    "delegating_subagent_prompt",
]
