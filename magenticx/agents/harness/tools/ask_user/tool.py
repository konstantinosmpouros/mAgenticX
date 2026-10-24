"""Agent tool: ask the user 1-3 clarifying questions, as a human-in-the-loop pause.

Calling it pauses the run with LangGraph ``interrupt`` and the questions as the
interrupt value::

    {"type": "ask_user", "questions": [{"id": "q1", "question": ..., "options": [...], "multiple": bool}, ...]}

The normalizer forwards that value unchanged inside ``HITL_INTERRUPT`` and emits
no tool lifecycle for the call — the question panel is its UI. The user's reply
comes back through the ordinary HITL resume path: the ``/resume`` endpoint
recognises the pending interrupt by its ``type`` and resumes with
``{"answers": [...], "skipped": bool}`` (:func:`resume_value`), which this tool
then turns into the result the model reads (:func:`format_reply`).

Main agent only. deepagents hands the general-purpose sub-agent the parent's full
tool list, so the tool refuses when it runs inside a sub-agent instead of
pausing a run on a question the orchestrator never saw (:func:`in_subagent`).
"""
from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

from langchain_core.runnables import RunnableConfig
from langchain_core.tools import StructuredTool
from langgraph.types import interrupt

from core.logging import get_logger
from harness.tools.ask_user.schema import AskUserInput

logger = get_logger(__name__)

ASK_USER_TOOL_NAME = "ask_user"

#: A free-text answer is the user's own writing; this only keeps a pasted
#: document from flooding the model's context.
_MAX_ANSWER_CHARS = 4000

SKIPPED_REPLY = (
    "The user skipped your questions. Continue with reasonable assumptions, "
    "and state them briefly in your answer."
)

SUBAGENT_REFUSAL = (
    "ask_user is not available to a sub-agent: only the main agent can pause to "
    "ask the user. Do not ask — continue with reasonable assumptions, and state "
    "them briefly in your result."
)

ASK_USER_DESCRIPTION = (
    "Ask the user 1-3 short clarifying questions and wait for the reply before you "
    "continue. Use it only when an answer would change what you do — the scope, "
    "which item is meant, how deep to go, a preference you cannot infer — and never "
    "for something you can find out yourself. Give each question 2-5 short suggested "
    "answers when sensible; the user can always write their own, so never add an "
    "'Other' option. Call it alone, once, before doing the work. The run pauses "
    "until the user answers, and this tool returns their reply."
)


def ask_user_payload(questions: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    """The interrupt value the UI reads: the questions, numbered ``q1``..``qN``."""
    return {
        "type": ASK_USER_TOOL_NAME,
        "questions": [
            {
                "id": f"q{index}",
                "question": str(question.get("question") or "").strip(),
                "options": [str(option).strip() for option in question.get("options") or [] if str(option).strip()],
                "multiple": bool(question.get("multiple", False)),
            }
            for index, question in enumerate(questions, start=1)
        ],
    }


def is_ask_user_interrupt(value: Any) -> bool:
    """Whether a pending interrupt's value is an ``ask_user`` question panel."""
    return isinstance(value, Mapping) and value.get("type") == ASK_USER_TOOL_NAME


def resume_value(interrupt_value: Mapping[str, Any], *, decision: str, value: Any) -> dict[str, Any]:
    """The ``Command(resume=...)`` value for a resume request against an ``ask_user`` pause.

    ``reject`` is a skip (``value`` ignored). ``approve`` needs
    ``value = {"answers": [{"id", "selected", "text"}, ...]}``: every id must be one
    of the asked questions, a question with no entry is unanswered. ``selected`` is
    kept as the user's strings, not matched against the suggestions — the panel may
    send them verbatim, and a stricter check would only turn a typo into a lost answer.

    Raises ``ValueError`` for a malformed value; the endpoint answers 422.
    """
    if decision == "reject":
        return {"answers": [], "skipped": True}
    if not isinstance(value, Mapping) or not isinstance(value.get("answers"), list):
        raise ValueError("An ask_user reply needs a value of the form {'answers': [...]}.")

    known = {q.get("id") for q in interrupt_value.get("questions") or () if isinstance(q, Mapping)}
    answers: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in value["answers"]:
        if not isinstance(item, Mapping):
            raise ValueError("Each ask_user answer must be an object.")
        question_id = item.get("id")
        if not isinstance(question_id, str) or question_id not in known:
            raise ValueError(f"Unknown question id {question_id!r}.")
        if question_id in seen:
            raise ValueError(f"Question {question_id!r} is answered twice.")
        seen.add(question_id)
        selected = item.get("selected") if item.get("selected") is not None else []
        if not isinstance(selected, list) or not all(isinstance(choice, str) for choice in selected):
            raise ValueError(f"'selected' of {question_id!r} must be a list of strings.")
        text = item.get("text") if item.get("text") is not None else ""
        if not isinstance(text, str):
            raise ValueError(f"'text' of {question_id!r} must be a string.")
        answers.append(
            {
                "id": question_id,
                "selected": [choice.strip()[:_MAX_ANSWER_CHARS] for choice in selected if choice.strip()],
                "text": text.strip()[:_MAX_ANSWER_CHARS],
            }
        )
    return {"answers": answers, "skipped": False}


def _answer_line(answer: Mapping[str, Any] | None) -> str:
    if not answer:
        return "(no answer)"
    selected = ", ".join(str(choice) for choice in answer.get("selected") or [])
    text = str(answer.get("text") or "").strip()
    return "; ".join(part for part in (selected, text) if part) or "(no answer)"


def format_reply(questions: list[Mapping[str, Any]], reply: Any) -> str:
    """The tool result the model reads: each question with the user's answer."""
    if not isinstance(reply, Mapping) or reply.get("skipped"):
        return SKIPPED_REPLY
    answers = {
        answer.get("id"): answer for answer in reply.get("answers") or () if isinstance(answer, Mapping)
    }
    lines = ["The user answered your questions:"]
    for index, question in enumerate(questions, start=1):
        lines.append(f"{index}. {question['question']}")
        lines.append(f"   → {_answer_line(answers.get(question['id']))}")
    # Vague answers invited a second round of questions in a live run.
    lines.append(
        "Now do the work with these answers. Do not ask again: state any "
        "assumption you still need to make."
    )
    return "\n".join(lines)


def in_subagent(config: Mapping[str, Any] | None) -> bool:
    """Whether this tool call runs inside a sub-agent.

    LangGraph runs a tool as a task in its agent's ``tools`` node, and deepagents
    runs a sub-agent inside the parent's ``task`` tool — so a main-agent tool's
    checkpoint namespace is one ``tools:<id>`` segment and a sub-agent's at least
    two (``tools:<id>|tools:<id>``). The full path is in ``configurable`` (and
    ``metadata.langgraph_checkpoint_ns``); ``metadata.checkpoint_ns`` holds only
    the first segment, so it cannot tell the two apart.
    """
    if not isinstance(config, Mapping):
        return False
    namespace = (config.get("configurable") or {}).get("checkpoint_ns") or (
        config.get("metadata") or {}
    ).get("langgraph_checkpoint_ns")
    if not isinstance(namespace, str):
        return False
    return sum(1 for segment in namespace.split("|") if segment.startswith("tools:")) > 1


def _as_dict(question: Any) -> dict[str, Any]:
    return question.model_dump() if hasattr(question, "model_dump") else dict(question)


def build_ask_user_tool() -> StructuredTool:
    """Return the ``ask_user`` tool. Stateless: the pause lives in the checkpoint."""

    async def _ask_user(questions: list[Any], config: RunnableConfig) -> str:
        if in_subagent(config):
            logger.info("ask_user_refused_in_subagent", "A sub-agent tried to ask the user; refused")
            return SUBAGENT_REFUSAL
        payload = ask_user_payload(_as_dict(question) for question in questions)
        # Pauses here on the first pass; on resume LangGraph re-runs the tool and
        # `interrupt` returns the resume value instead.
        reply = interrupt(payload)
        logger.info(
            "ask_user_answered",
            "The user replied to the agent's questions",
            question_count=len(payload["questions"]),
            skipped=bool(isinstance(reply, Mapping) and reply.get("skipped")),
        )
        return format_reply(payload["questions"], reply)

    return StructuredTool.from_function(
        coroutine=_ask_user,
        name=ASK_USER_TOOL_NAME,
        description=ASK_USER_DESCRIPTION,
        args_schema=AskUserInput,
    )


__all__ = [
    "ASK_USER_TOOL_NAME",
    "SKIPPED_REPLY",
    "SUBAGENT_REFUSAL",
    "ask_user_payload",
    "build_ask_user_tool",
    "format_reply",
    "in_subagent",
    "is_ask_user_interrupt",
    "resume_value",
]
