"""The PDF export reads an answer the way the chat shows it (plan 42 era).

An orchestrator with background tasks answers in several runs, with a hidden
task notice before each later run. The PDF prints them as one answer, never the
notices as the user's messages, and "export this message" takes the whole
answer with its question.
"""
from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace

from utils.share_export import _answer_with_question, _markdown_blocks, conversation_turns

T0 = datetime(2026, 11, 13, 10, 0, tzinfo=UTC)


def msg(mid: str, sender: str, content: str = "", **extra):
    return SimpleNamespace(
        id=mid, sender=sender, content=content, created_at=T0, attachments=[],
        kind=extra.get("kind"), task_notice=extra.get("task_notice"),
    )


def notice(mid: str, name: str = "researcher", status: str = "success", duration_ms: int = 134_000):
    return msg(mid, "user", "<task notification for the model>", kind="task_notification",
               task_notice={"task_id": "t", "name": name, "status": status, "duration_ms": duration_ms})


BRANCH = [
    msg("u1", "user", "What caused the Greek debt crisis?"),
    msg("a1", "ai", "I'll research it."),
    notice("n1", "general-purpose", duration_ms=22_000),
    msg("a2", "ai", "The audit is in."),
    notice("n2", "coordinator", status="error"),
    msg("a3", "ai", "Final answer."),
]


def test_one_answer_is_one_block_and_notices_are_never_the_users_words():
    turns = conversation_turns(BRANCH)
    assert [t.sender for t in turns] == ["user", "ai"]
    answer = turns[1].content
    assert answer.startswith("I'll research it.") and answer.endswith("Final answer.")
    assert "\x0eGeneral purpose finished · 22s" in answer
    assert "\x0eCoordinator failed · 2m 14s" in answer
    assert "<task notification" not in answer


def test_an_answers_model_calls_become_paragraphs_again():
    glued = msg("a9", "ai", "Searching first.Here is the answer.")
    glued.raw_events = [
        {"type": "TEXT_MESSAGE_START"}, {"type": "TEXT_MESSAGE_CONTENT", "delta": "Searching first."},
        {"type": "TEXT_MESSAGE_END"},
        {"type": "CUSTOM", "name": "SUBAGENT_EVENT", "value": {"event": {"type": "TEXT_MESSAGE_CONTENT", "delta": "x"}}},
        {"type": "TEXT_MESSAGE_START"}, {"type": "TEXT_MESSAGE_CONTENT", "delta": "Here is the answer."},
    ]
    assert conversation_turns([glued])[0].content == "Searching first.\n\nHere is the answer."

    # Events that do not match the stored text are not trusted.
    glued.content = "Edited elsewhere."
    assert conversation_turns([glued])[0].content == "Edited elsewhere."


def test_a_notice_line_is_its_own_quiet_block():
    blocks = _markdown_blocks(conversation_turns(BRANCH)[1].content)
    notes = [b.text for b in blocks if b.kind == "notice"]
    assert notes == ["General purpose finished · 22s", "Coordinator failed · 2m 14s"]


def test_exporting_this_message_takes_the_whole_answer_and_its_question():
    assert [m.id for m in _answer_with_question(BRANCH)] == ["u1", "a1", "n1", "a2", "n2", "a3"]
    later = [*BRANCH, msg("u2", "user", "And now?"), msg("a4", "ai", "Now this.")]
    assert [m.id for m in _answer_with_question(later)] == ["u2", "a4"]

