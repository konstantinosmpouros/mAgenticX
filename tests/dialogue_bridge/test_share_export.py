from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest
from sqlalchemy import select
from sqlalchemy.orm import selectinload

import utils.share_export as share_export
from core.database import AgentTable, AttachmentTable, ConversationTable, MessageTable
from utils.share_export import (
    _FontRegistry,
    _UnicodeFont,
    _clean_inline_markdown,
    _clean_text,
    _is_table_separator,
    _markdown_blocks,
    _messages_from_branch_path,
    _split_table_row,
    _wrap_text,
    conversation_pdf_filename,
    render_conversation_pdf,
    select_scoped_messages,
)


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


# The real _FontRegistry.load() only probes WSL (/mnt/c/...) and Linux font
# paths, so it raises on a native-Windows test host. We swap discovery for a
# real local TrueType font so every downstream render/encode/subset/build path
# still runs against genuine font machinery.
_FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
    "C:/Windows/Fonts/arial.ttf",
    "C:/Windows/Fonts/ARIALUNI.TTF",
    "C:/Windows/Fonts/segoeui.ttf",
]


def _find_font() -> Path | None:
    for candidate in _FONT_CANDIDATES:
        path = Path(candidate)
        if path.exists():
            return path
    return None


@pytest.fixture(autouse=True)
def patch_font_registry(monkeypatch):
    font_path = _find_font()
    if font_path is None:
        pytest.skip("No local TrueType font available to drive PDF font machinery.")

    def fake_load(cls) -> _FontRegistry:
        return _FontRegistry([_UnicodeFont(font_path, font_number=0, resource_name="F1")])

    monkeypatch.setattr(_FontRegistry, "load", classmethod(fake_load))
    return font_path


def _msg(
    *,
    sender: str = "ai",
    content: str | None = "Hello",
    created_at: datetime | None = None,
    attachments: list | None = None,
    message_id: str = "m1",
    parent_message_id: str | None = None,
) -> MessageTable:
    message = MessageTable(
        id=message_id,
        conversation_id="conv-1",
        parent_message_id=parent_message_id,
        sender=sender,
        content=content,
    )
    message.created_at = created_at if created_at is not None else utcnow()
    message.attachments = attachments or []
    return message


def _conv(*, title: str | None = "My Conversation", agent_name: str | None = "Test Agent") -> ConversationTable:
    conversation = ConversationTable(
        id="conv-1",
        user_id="user-1",
        agent_id="agent-1",
        agent_name=agent_name,
        title=title,
    )
    conversation.agent = None
    return conversation


# ---------------------------------------------------------------------------
# Markdown / text helpers (direct unit)
# ---------------------------------------------------------------------------


def test_clean_text_collapses_whitespace_and_nulls():
    assert _clean_text("  a\t\n b\x00c  ") == "a b c"


def test_clean_inline_markdown_strips_formatting():
    raw = (
        "**bold** _italic_ `code` [link](http://x) ![alt](http://i.png) "
        "<!-- comment --> <span>tag</span> [^fn] __strong__ *em*"
    )
    cleaned = _clean_inline_markdown(raw)
    assert "**" not in cleaned
    assert "`" not in cleaned
    assert "bold" in cleaned
    assert "italic" in cleaned
    assert "code" in cleaned
    assert "link" in cleaned
    assert "alt" in cleaned
    # HTML tags are stripped but their inner text survives
    assert "<span>" not in cleaned and "</span>" not in cleaned
    assert "tag" in cleaned
    assert "comment" not in cleaned


def test_clean_inline_markdown_image_without_alt_uses_placeholder():
    assert _clean_inline_markdown("![](http://i.png)") == "[image]"


def test_wrap_text_handles_empty_and_multiline():
    assert _wrap_text("", 10) == [""]
    wrapped = _wrap_text("line one\nline two that is fairly long and should wrap nicely here", 20)
    assert len(wrapped) >= 2


def test_is_table_separator():
    assert _is_table_separator("| --- | :---: |") is True
    assert _is_table_separator("---") is False
    assert _is_table_separator("| not a sep |") is False


def test_split_table_row():
    assert _split_table_row("| a | **b** | c |") == ["a", "b", "c"]


def test_markdown_blocks_covers_all_branches():
    text = (
        "# Heading One\n"
        "## Heading Two\n"
        "### Heading Three\n"
        "\n"
        "A normal paragraph with **bold** and `code`.\n"
        "\n"
        "- bullet one\n"
        "* bullet two\n"
        "1. ordered one\n"
        "2) ordered two\n"
        "- [x] done task\n"
        "- [ ] open task\n"
        "\n"
        "> a quote line\n"
        "> continued quote\n"
        "\n"
        "---\n"
        "\n"
        "| Col A | Col B |\n"
        "| --- | --- |\n"
        "| 1 | 2 |\n"
        "| 3 | 4 |\n"
        "\n"
        "```python\n"
        "print('hi')\n"
        "x = 1\n"
        "```\n"
        "\n"
        "[^note]: a footnote definition\n"
    )
    blocks = _markdown_blocks(text)
    kinds = {b.kind for b in blocks}
    assert {"heading", "paragraph", "bullet", "task", "quote", "hr", "table", "code", "footnote"} <= kinds
    table = next(b for b in blocks if b.kind == "table")
    assert table.data["headers"] == ["Col A", "Col B"]
    assert table.data["rows"] == [["1", "2"], ["3", "4"]]
    assert table.estimated_lines == len(table.data["rows"]) + 2
    code = next(b for b in blocks if b.kind == "code")
    assert code.data["language"] == "python"
    hr = next(b for b in blocks if b.kind == "hr")
    assert hr.estimated_lines == 1


def test_markdown_blocks_unterminated_code_block_and_trailing_blanks():
    blocks = _markdown_blocks("```\nno closing fence\nmore code\n\n\n")
    assert any(b.kind == "code" for b in blocks)
    assert blocks[-1].kind != "blank"


def test_markdown_blocks_empty_string():
    assert _markdown_blocks("") == []


def test_messages_from_branch_path_valid_and_invalid():
    root = _msg(sender="user", content="q", message_id="r", parent_message_id=None)
    child = _msg(sender="ai", content="a", message_id="c", parent_message_id="r")
    messages = [root, child]

    assert _messages_from_branch_path(messages, None) == []
    assert _messages_from_branch_path(messages, ["r", "c"]) == [root, child]
    # broken chain (parent mismatch) returns empty
    assert _messages_from_branch_path(messages, ["c", "r"]) == []
    # unknown id returns empty
    assert _messages_from_branch_path(messages, ["missing"]) == []


# ---------------------------------------------------------------------------
# conversation_pdf_filename
# ---------------------------------------------------------------------------


def test_conversation_pdf_filename_modes_and_sanitization():
    conv = _conv(title="Weird/Title: *with* chars!")
    assert conversation_pdf_filename(conv, "full").endswith("-conversation.pdf")
    assert conversation_pdf_filename(conv, "branch").endswith("-up-to-message.pdf")
    assert conversation_pdf_filename(conv, "message").endswith("-message.pdf")
    # forbidden characters collapsed to hyphens
    assert "/" not in conversation_pdf_filename(conv, "full")
    assert "*" not in conversation_pdf_filename(conv, "full")


def test_conversation_pdf_filename_falls_back_to_agent_then_default():
    conv = _conv(title=None, agent_name="AgentX")
    assert conversation_pdf_filename(conv, "full").startswith("AgentX")
    conv_no_names = _conv(title=None, agent_name=None)
    assert conversation_pdf_filename(conv_no_names, "full") == "conversation-conversation.pdf"


# ---------------------------------------------------------------------------
# select_scoped_messages (full / branch / message) — needs DB-backed lineage
# ---------------------------------------------------------------------------


async def _seed_lineage(session_factory, seeded_user, seeded_agent):
    async with session_factory() as session:
        conversation = ConversationTable(
            user_id=seeded_user.id,
            agent_id=seeded_agent.id,
            agent_name=seeded_agent.name,
            title="Scoped conversation",
            last_message_preview="answer",
        )
        session.add(conversation)
        await session.flush()

        user_msg = MessageTable(
            conversation_id=conversation.id,
            sender="user",
            content="What is up?",
        )
        session.add(user_msg)
        await session.flush()

        ai_msg = MessageTable(
            conversation_id=conversation.id,
            parent_message_id=user_msg.id,
            sender="ai",
            content="Plenty is up.",
            agent_id=seeded_agent.id,
            agent_name=seeded_agent.name,
        )
        session.add(ai_msg)
        await session.commit()
        return {
            "conversation_id": conversation.id,
            "user_message_id": user_msg.id,
            "ai_message_id": ai_msg.id,
        }


async def _load_conversation(session_factory, conversation_id: str) -> ConversationTable:
    async with session_factory() as session:
        q = (
            select(ConversationTable)
            .options(
                selectinload(ConversationTable.agent),
                selectinload(ConversationTable.messages).selectinload(MessageTable.attachments),
            )
            .where(ConversationTable.id == conversation_id)
        )
        return (await session.execute(q)).scalar_one()


async def test_select_scoped_messages_modes(session_factory, seeded_user, seeded_agent):
    ids = await _seed_lineage(session_factory, seeded_user, seeded_agent)
    conv = await _load_conversation(session_factory, ids["conversation_id"])

    full = select_scoped_messages(conv, ids["ai_message_id"], "full")
    assert [m.id for m in full] == [ids["user_message_id"], ids["ai_message_id"]]

    branch = select_scoped_messages(conv, ids["ai_message_id"], "branch")
    assert [m.id for m in branch] == [ids["user_message_id"], ids["ai_message_id"]]

    # message mode keeps the user prompt + AI answer pair
    message = select_scoped_messages(conv, ids["ai_message_id"], "message")
    assert [m.id for m in message] == [ids["user_message_id"], ids["ai_message_id"]]


async def test_select_scoped_messages_full_with_branch_path(session_factory, seeded_user, seeded_agent):
    ids = await _seed_lineage(session_factory, seeded_user, seeded_agent)
    conv = await _load_conversation(session_factory, ids["conversation_id"])

    branch_path = [ids["user_message_id"], ids["ai_message_id"]]
    full = select_scoped_messages(conv, ids["ai_message_id"], "full", branch_path)
    assert [m.id for m in full] == branch_path


async def test_select_scoped_messages_message_mode_single(session_factory, seeded_user, seeded_agent):
    async with session_factory() as session:
        conversation = ConversationTable(
            user_id=seeded_user.id,
            agent_id=seeded_agent.id,
            agent_name=seeded_agent.name,
            title="Orphan AI",
        )
        session.add(conversation)
        await session.flush()
        ai_msg = MessageTable(
            conversation_id=conversation.id,
            sender="ai",
            content="standalone answer",
        )
        session.add(ai_msg)
        await session.commit()
        conv_id, ai_id = conversation.id, ai_msg.id

    conv = await _load_conversation(session_factory, conv_id)
    scoped = select_scoped_messages(conv, ai_id, "message")
    assert [m.id for m in scoped] == [ai_id]


# ---------------------------------------------------------------------------
# render_conversation_pdf (direct unit) — exercise every render branch
# ---------------------------------------------------------------------------


def _assert_pdf(data: bytes) -> None:
    assert isinstance(data, bytes)
    assert data.startswith(b"%PDF")
    assert b"%%EOF" in data
    assert len(data) > 500


def test_render_conversation_pdf_all_markdown_branches():
    conv = _conv()
    rich = (
        "# Title Heading\n"
        "## Sub Heading\n"
        "### Smaller Heading\n"
        "\n"
        "Intro paragraph with **bold**, _italics_, and `inline code`.\n"
        "\n"
        "- first bullet\n"
        "- second bullet\n"
        "1. ordered first\n"
        "2. ordered second\n"
        "- [x] completed task item\n"
        "- [ ] pending task item\n"
        "\n"
        "> A blockquote that spans\n"
        "> more than a single line.\n"
        "\n"
        "---\n"
        "\n"
        "| Name | Value | Notes |\n"
        "| --- | --- | --- |\n"
        "| alpha | 1 | first |\n"
        "| beta | 2 | second very long note that should wrap inside the cell |\n"
        "\n"
        "```python\n"
        "def f(x):\n"
        "    return x * 2\n"
        "```\n"
        "\n"
        "```\n"
        "plain fenced block without a language tag\n"
        "```\n"
        "\n"
        "A link to [example](https://example.com) and an image ![diagram](data:image/png;base64,AAAA).\n"
        "\n"
        "[^src]: footnote source text\n"
    )
    user = _msg(sender="user", content="Please summarize.", message_id="u1", parent_message_id=None)
    ai = _msg(sender="ai", content=rich, message_id="a1", parent_message_id="u1")
    pdf = render_conversation_pdf(conv, [user, ai], "full")
    _assert_pdf(pdf)


def test_render_conversation_pdf_pagination_long_content():
    conv = _conv(title="Long")
    long_text = "\n\n".join(f"Paragraph {i}: " + ("word " * 40) for i in range(120))
    ai = _msg(sender="ai", content=long_text, message_id="a1")
    pdf = render_conversation_pdf(conv, [ai], "full")
    _assert_pdf(pdf)
    # Multi-page document: more than one /Type /Page object
    assert pdf.count(b"/Type /Page") >= 2


def test_render_conversation_pdf_empty_messages():
    conv = _conv()
    pdf = render_conversation_pdf(conv, [], "full")
    _assert_pdf(pdf)


def test_render_conversation_pdf_empty_message_content():
    conv = _conv()
    ai = _msg(sender="ai", content="", message_id="a1")
    pdf = render_conversation_pdf(conv, [ai], "message")
    _assert_pdf(pdf)


def test_render_conversation_pdf_none_content():
    conv = _conv()
    ai = _msg(sender="ai", content=None, message_id="a1")
    ai.created_at = None
    pdf = render_conversation_pdf(conv, [ai], "message")
    _assert_pdf(pdf)


def test_render_conversation_pdf_with_attachments():
    conv = _conv()
    ai = _msg(
        sender="ai",
        content="See attached.",
        message_id="a1",
        attachments=[
            AttachmentTable(file_name="report.pdf", mime_type="application/pdf"),
            AttachmentTable(file_name="image.png", mime_type="image/png"),
        ],
    )
    pdf = render_conversation_pdf(conv, [ai], "full")
    _assert_pdf(pdf)


def test_render_conversation_pdf_with_agent_relationship():
    conv = _conv(title=None, agent_name=None)
    conv.agent = AgentTable(slug="linked-agent", name="Linked Agent")
    ai = _msg(sender="ai", content="Answer body", message_id="a1")
    pdf = render_conversation_pdf(conv, [ai], "full")
    _assert_pdf(pdf)


def test_render_conversation_pdf_unicode_and_fallback_glyphs():
    conv = _conv(title="Unicode 日本語 ✓ test")
    ai = _msg(
        sender="ai",
        content="Mixed scripts: café, naïve, 日本語, emoji 😀, math ∑∞, check ✓ box □",
        message_id="a1",
    )
    pdf = render_conversation_pdf(conv, [ai], "full")
    _assert_pdf(pdf)


def test_render_conversation_pdf_without_logo(monkeypatch):
    monkeypatch.setattr(share_export, "_load_logo", lambda: None)
    conv = _conv()
    ai = _msg(sender="ai", content="No logo path exercised.", message_id="a1")
    pdf = render_conversation_pdf(conv, [ai], "full")
    _assert_pdf(pdf)


def test_render_conversation_pdf_empty_table_rows():
    conv = _conv()
    only_header = "| H1 | H2 |\n| --- | --- |\n"
    ai = _msg(sender="ai", content=only_header, message_id="a1")
    pdf = render_conversation_pdf(conv, [ai], "full")
    _assert_pdf(pdf)


# ---------------------------------------------------------------------------
# Endpoint tests
# ---------------------------------------------------------------------------


async def _seed_endpoint_conversation(session_factory, seeded_user, seeded_agent, *, content: str):
    async with session_factory() as session:
        conversation = ConversationTable(
            user_id=seeded_user.id,
            agent_id=seeded_agent.id,
            agent_name=seeded_agent.name,
            title="Endpoint conversation",
            last_message_preview="answer",
        )
        session.add(conversation)
        await session.flush()
        user_msg = MessageTable(
            conversation_id=conversation.id,
            sender="user",
            content="Question for the endpoint",
        )
        session.add(user_msg)
        await session.flush()
        ai_msg = MessageTable(
            conversation_id=conversation.id,
            parent_message_id=user_msg.id,
            sender="ai",
            content=content,
            agent_id=seeded_agent.id,
            agent_name=seeded_agent.name,
        )
        session.add(ai_msg)
        await session.commit()
        return {
            "conversation_id": conversation.id,
            "user_message_id": user_msg.id,
            "ai_message_id": ai_msg.id,
        }


async def test_export_pdf_endpoint_full_mode(client, session_factory, seeded_user, seeded_agent):
    ids = await _seed_endpoint_conversation(
        session_factory,
        seeded_user,
        seeded_agent,
        content="# Report\n\nA paragraph with a `table`.\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n",
    )
    response = await client.post(
        f"/v1/conversations/{seeded_user.id}/{ids['conversation_id']}/share/export-pdf",
        json={"mode": "full", "messageId": ids["ai_message_id"]},
    )
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/pdf"
    assert response.content.startswith(b"%PDF")
    assert int(response.headers["content-length"]) == len(response.content)
    assert "attachment" in response.headers["content-disposition"]


async def test_export_pdf_endpoint_branch_mode(client, session_factory, seeded_user, seeded_agent):
    ids = await _seed_endpoint_conversation(
        session_factory, seeded_user, seeded_agent, content="Branch answer body."
    )
    response = await client.post(
        f"/v1/conversations/{seeded_user.id}/{ids['conversation_id']}/share/export-pdf",
        json={
            "mode": "branch",
            "messageId": ids["ai_message_id"],
            "branchPath": [ids["user_message_id"], ids["ai_message_id"]],
        },
    )
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/pdf"
    assert response.content.startswith(b"%PDF")


async def test_export_pdf_endpoint_message_mode(client, session_factory, seeded_user, seeded_agent):
    ids = await _seed_endpoint_conversation(
        session_factory, seeded_user, seeded_agent, content="Single message answer."
    )
    response = await client.post(
        f"/v1/conversations/{seeded_user.id}/{ids['conversation_id']}/share/export-pdf",
        json={"mode": "message", "messageId": ids["ai_message_id"]},
    )
    assert response.status_code == 200
    assert response.content.startswith(b"%PDF")


async def test_export_pdf_endpoint_unknown_message_returns_400(client, session_factory, seeded_user, seeded_agent):
    ids = await _seed_endpoint_conversation(
        session_factory, seeded_user, seeded_agent, content="Some answer."
    )
    response = await client.post(
        f"/v1/conversations/{seeded_user.id}/{ids['conversation_id']}/share/export-pdf",
        json={"mode": "full", "messageId": "does-not-exist"},
    )
    # build_message_lineage rejects an unknown target with a 400
    assert response.status_code == 400


async def test_export_pdf_endpoint_user_message_target_rejected(client, session_factory, seeded_user, seeded_agent):
    ids = await _seed_endpoint_conversation(
        session_factory, seeded_user, seeded_agent, content="Answer."
    )
    response = await client.post(
        f"/v1/conversations/{seeded_user.id}/{ids['conversation_id']}/share/export-pdf",
        json={"mode": "full", "messageId": ids["user_message_id"]},
    )
    # only AI messages are valid scope targets
    assert response.status_code == 400


async def test_export_pdf_endpoint_bad_mode_returns_422(client, session_factory, seeded_user, seeded_agent):
    ids = await _seed_endpoint_conversation(
        session_factory, seeded_user, seeded_agent, content="Answer."
    )
    response = await client.post(
        f"/v1/conversations/{seeded_user.id}/{ids['conversation_id']}/share/export-pdf",
        json={"mode": "sideways", "messageId": ids["ai_message_id"]},
    )
    assert response.status_code == 422


async def test_export_pdf_endpoint_missing_message_id_returns_422(client, session_factory, seeded_user, seeded_agent):
    ids = await _seed_endpoint_conversation(
        session_factory, seeded_user, seeded_agent, content="Answer."
    )
    response = await client.post(
        f"/v1/conversations/{seeded_user.id}/{ids['conversation_id']}/share/export-pdf",
        json={"mode": "full"},
    )
    assert response.status_code == 422


async def test_export_pdf_endpoint_unknown_conversation_returns_404(client, seeded_user):
    response = await client.post(
        f"/v1/conversations/{seeded_user.id}/missing-conversation/share/export-pdf",
        json={"mode": "full", "messageId": "whatever"},
    )
    assert response.status_code == 404
