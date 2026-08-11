"""Unit tests for the pure inference message-path helpers.

These functions never touch the DB — they operate on lists of message-like
objects and enforce the backend's trust rules for branch resolution:

- ``build_path_to_message`` walks ``parent_message_id`` links to the root and
  rejects cyclic / incomplete / unknown lineages.
- ``validate_and_order_message_path`` validates a client-supplied id list
  (blank ids, duplicates, unknown ids) and returns messages in requested order.
- ``resolve_inference_message_path`` cross-checks a client branch hint against
  the authoritative DB lineage.
- ``prepare_inference_history`` strips a trailing empty AI placeholder and
  serialises the branch.
- ``serialise_message_with_images_for_agent`` produces LangChain multimodal
  content (inline image data-URLs + attachment note text).

Lightweight stand-ins are used in place of ``MessageTable`` so the tests stay
DB-free; the helpers only read attributes, never ORM behaviour.
"""

from __future__ import annotations

import base64
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from utils.inference import (
    build_path_to_message,
    prepare_inference_history,
    resolve_inference_message_path,
    serialise_message_with_images_for_agent,
    validate_and_order_message_path,
)


def make_msg(
    msg_id: str,
    *,
    parent: str | None = None,
    sender: str = "user",
    content: str | None = "hi",
    attachments=None,
):
    return SimpleNamespace(
        id=msg_id,
        parent_message_id=parent,
        sender=sender,
        content=content,
        attachments=attachments or [],
    )


class _Logger:
    def __init__(self):
        self.calls: list[tuple] = []

    def info(self, event, message, **kwargs):
        self.calls.append((event, message, kwargs))


# ---------------------------------------------------------------------------
# build_path_to_message
# ---------------------------------------------------------------------------

def test_build_path_to_message_returns_root_to_target_order():
    m1 = make_msg("m1")
    m2 = make_msg("m2", parent="m1")
    m3 = make_msg("m3", parent="m2")
    path = build_path_to_message([m3, m1, m2], "m3")
    assert [m.id for m in path] == ["m1", "m2", "m3"]


def test_build_path_to_message_single_root():
    m1 = make_msg("m1")
    assert [m.id for m in build_path_to_message([m1], "m1")] == ["m1"]


def test_build_path_to_message_unknown_target_raises_400():
    with pytest.raises(HTTPException) as exc:
        build_path_to_message([make_msg("m1")], "missing")
    assert exc.value.status_code == 400
    assert "does not belong" in exc.value.detail


def test_build_path_to_message_incomplete_branch_raises_400():
    # m2 references a parent that is not in the list.
    m2 = make_msg("m2", parent="ghost")
    with pytest.raises(HTTPException) as exc:
        build_path_to_message([m2], "m2")
    assert exc.value.status_code == 400
    assert "incomplete" in exc.value.detail


def test_build_path_to_message_cyclic_branch_raises_400():
    m1 = make_msg("m1", parent="m2")
    m2 = make_msg("m2", parent="m1")
    with pytest.raises(HTTPException) as exc:
        build_path_to_message([m1, m2], "m1")
    assert exc.value.status_code == 400
    assert "cyclic" in exc.value.detail


# ---------------------------------------------------------------------------
# validate_and_order_message_path
# ---------------------------------------------------------------------------

def test_validate_and_order_returns_all_messages_when_no_ids():
    msgs = [make_msg("a"), make_msg("b")]
    assert validate_and_order_message_path(msgs, None) is msgs
    assert validate_and_order_message_path(msgs, []) is msgs


def test_validate_and_order_returns_requested_order():
    m1, m2, m3 = make_msg("m1"), make_msg("m2"), make_msg("m3")
    ordered = validate_and_order_message_path([m1, m2, m3], ["m3", "m1"])
    assert [m.id for m in ordered] == ["m3", "m1"]


def test_validate_and_order_strips_whitespace_in_ids():
    m1 = make_msg("m1")
    ordered = validate_and_order_message_path([m1], ["  m1  "])
    assert [m.id for m in ordered] == ["m1"]


def test_validate_and_order_blank_id_raises_400():
    with pytest.raises(HTTPException) as exc:
        validate_and_order_message_path([make_msg("m1")], ["   "])
    assert exc.value.status_code == 400
    assert "invalid ids" in exc.value.detail


def test_validate_and_order_non_string_id_raises_400():
    with pytest.raises(HTTPException) as exc:
        validate_and_order_message_path([make_msg("m1")], [123])  # type: ignore[list-item]
    assert exc.value.status_code == 400


def test_validate_and_order_duplicate_ids_raises_400():
    with pytest.raises(HTTPException) as exc:
        validate_and_order_message_path([make_msg("m1")], ["m1", "m1"])
    assert exc.value.status_code == 400
    assert "duplicates" in exc.value.detail


def test_validate_and_order_unknown_id_raises_400():
    with pytest.raises(HTTPException) as exc:
        validate_and_order_message_path([make_msg("m1")], ["m1", "ghost"])
    assert exc.value.status_code == 400
    assert "outside this conversation" in exc.value.detail


# ---------------------------------------------------------------------------
# resolve_inference_message_path
# ---------------------------------------------------------------------------

def test_resolve_without_hint_returns_db_lineage():
    m1 = make_msg("m1")
    m2 = make_msg("m2", parent="m1")
    assert resolve_inference_message_path([m1, m2], "m2", None) == ["m1", "m2"]


def test_resolve_with_valid_hint_returns_db_lineage():
    m1 = make_msg("m1")
    m2 = make_msg("m2", parent="m1")
    result = resolve_inference_message_path([m1, m2], "m2", ["m1", "m2"])
    assert result == ["m1", "m2"]


def test_resolve_hint_not_a_valid_lineage_raises_400():
    # m2 and m3 are siblings (both parented to m1) so the hint is not a chain.
    m1 = make_msg("m1")
    m2 = make_msg("m2", parent="m1")
    m3 = make_msg("m3", parent="m1")
    with pytest.raises(HTTPException) as exc:
        resolve_inference_message_path([m1, m2, m3], "m3", ["m2", "m3"])
    assert exc.value.status_code == 400
    assert "valid message lineage" in exc.value.detail


def test_resolve_hint_not_ending_at_parent_raises_400():
    m1 = make_msg("m1")
    m2 = make_msg("m2", parent="m1")
    with pytest.raises(HTTPException) as exc:
        resolve_inference_message_path([m1, m2], "m2", ["m1"])
    assert exc.value.status_code == 400
    assert "end at the inference parent" in exc.value.detail


# ---------------------------------------------------------------------------
# prepare_inference_history
# ---------------------------------------------------------------------------

def test_prepare_history_strips_trailing_empty_ai_placeholder():
    logger = _Logger()
    user = make_msg("u1", sender="user", content="hello")
    placeholder = make_msg("a1", sender="ai", content="", attachments=[])
    history_messages, history = prepare_inference_history(
        logger=logger,
        messages=[user, placeholder],
        message_ids=["u1", "a1"],
    )
    assert [m.id for m in history_messages] == ["u1"]
    assert history == [{"role": "user", "content": "hello"}]
    event, _msg, kwargs = logger.calls[0]
    assert event == "inference_branch_resolved"
    assert kwargs["placeholder_stripped"] is True
    assert kwargs["branch_source"] == "message_path"


def test_prepare_history_keeps_ai_message_with_content():
    logger = _Logger()
    user = make_msg("u1", sender="user", content="hello")
    ai = make_msg("a1", sender="ai", content="answer")
    history_messages, history = prepare_inference_history(
        logger=logger,
        messages=[user, ai],
        message_ids=None,
    )
    assert [m.id for m in history_messages] == ["u1", "a1"]
    assert history[-1] == {"role": "ai", "content": "answer"}
    _event, _msg, kwargs = logger.calls[0]
    assert kwargs["placeholder_stripped"] is False
    assert kwargs["branch_source"] == "conversation"


def test_prepare_history_empty_messages_is_safe():
    logger = _Logger()
    history_messages, history = prepare_inference_history(
        logger=logger,
        messages=[],
        message_ids=None,
    )
    assert history_messages == []
    assert history == []


# ---------------------------------------------------------------------------
# serialise_message_with_images_for_agent
# ---------------------------------------------------------------------------

def test_serialise_plain_text_user_message():
    msg = make_msg("m1", sender="user", content="  hello world  ")
    assert serialise_message_with_images_for_agent(msg) == {
        "role": "user",
        "content": "hello world",
    }


def test_serialise_ai_role_mapping():
    msg = make_msg("m1", sender="ai", content="ack")
    assert serialise_message_with_images_for_agent(msg)["role"] == "ai"


def test_serialise_empty_message_yields_empty_text():
    msg = make_msg("m1", sender="user", content=None, attachments=[])
    assert serialise_message_with_images_for_agent(msg) == {"role": "user", "content": ""}


def test_serialise_inlines_image_attachment_as_data_url():
    raw = b"\x89PNG\r\n"
    blob = SimpleNamespace(data=raw)
    attachment = SimpleNamespace(mime_type="image/png", blob=blob, file_name="pic.png")
    msg = make_msg("m1", sender="user", content="see this", attachments=[attachment])

    result = serialise_message_with_images_for_agent(msg)
    assert result["role"] == "user"
    parts = result["content"]
    assert isinstance(parts, list)
    assert parts[0] == {"type": "text", "text": "see this"}
    image_part = parts[1]
    assert image_part["type"] == "image_url"
    expected_b64 = base64.b64encode(raw).decode("ascii")
    assert image_part["image_url"]["url"] == f"data:image/png;base64,{expected_b64}"
    assert image_part["image_url"]["detail"] == "auto"


def test_serialise_non_image_attachment_listed_as_note():
    attachment = SimpleNamespace(mime_type="application/pdf", blob=None, file_name="report.pdf")
    msg = make_msg("m1", sender="user", content="doc attached", attachments=[attachment])

    parts = serialise_message_with_images_for_agent(msg)["content"]
    assert parts[0] == {"type": "text", "text": "doc attached"}
    note = parts[1]
    assert note["type"] == "text"
    assert "Attachments:" in note["text"]
    assert "report.pdf (application/pdf)" in note["text"]


def test_serialise_image_without_blob_falls_back_to_note():
    # An image-typed attachment with no blob bytes cannot be inlined; it is
    # listed as a textual note instead. With empty text content the single
    # note block collapses back to a plain string payload.
    attachment = SimpleNamespace(mime_type="image/png", blob=None, file_name="broken.png")
    msg = make_msg("m1", sender="user", content="", attachments=[attachment])
    content = serialise_message_with_images_for_agent(msg)["content"]
    assert isinstance(content, str)
    assert "broken.png" in content


def test_serialise_image_without_blob_with_text_stays_list():
    attachment = SimpleNamespace(mime_type="image/png", blob=None, file_name="broken.png")
    msg = make_msg("m1", sender="user", content="here", attachments=[attachment])
    parts = serialise_message_with_images_for_agent(msg)["content"]
    assert isinstance(parts, list)
    assert any("broken.png" in part["text"] for part in parts if part["type"] == "text")


def test_serialise_attachment_without_name_is_skipped():
    attachment = SimpleNamespace(mime_type="application/pdf", blob=None, file_name=None)
    msg = make_msg("m1", sender="user", content="just text", attachments=[attachment])
    # No note added because the attachment has no file_name.
    assert serialise_message_with_images_for_agent(msg) == {
        "role": "user",
        "content": "just text",
    }
