"""Unit + DB tests for utils.search.

``clean_search_query`` and ``build_like_pattern`` are pure string helpers
(whitespace normalisation, LIKE-wildcard escaping). ``search_workspace_data``
runs the four ILIKE queries (conversations, messages, files, agents) against
the real SQLite session and is also exercised end-to-end through the
``GET /v1/search/{user}`` route.
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from sqlalchemy import select

from core.database import (
    AttachmentTable,
    ConversationTable,
    MessageTable,
)
from utils.search import build_like_pattern, clean_search_query, search_workspace_data


# ---------------------------------------------------------------------------
# clean_search_query
# ---------------------------------------------------------------------------

def test_clean_search_query_collapses_whitespace():
    assert clean_search_query("  hello   world\n\tfoo  ") == "hello world foo"


def test_clean_search_query_empty_and_none():
    assert clean_search_query("") == ""
    assert clean_search_query("   ") == ""
    assert clean_search_query(None) == ""  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# build_like_pattern
# ---------------------------------------------------------------------------

def test_build_like_pattern_wraps_with_percent():
    assert build_like_pattern("term") == "%term%"


def test_build_like_pattern_escapes_wildcards_and_backslash():
    # Backslash must be escaped first so the escapes of % and _ are not doubled.
    assert build_like_pattern("a%b_c\\d") == "%a\\%b\\_c\\\\d%"


# ---------------------------------------------------------------------------
# search_workspace_data (DB)
# ---------------------------------------------------------------------------

async def test_search_matches_conversation_title(session_factory, seeded_user, conversation_factory):
    await conversation_factory(title="Quarterly Finance Review")
    await conversation_factory(title="Unrelated topic")
    async with session_factory() as session:
        results = await search_workspace_data(
            db=session, current_user=seeded_user, query="finance", limit=20
        )
    convo_titles = [r.title for r in results if r.kind == "conversation"]
    assert "Quarterly Finance Review" in convo_titles
    assert "Unrelated topic" not in convo_titles


async def test_search_matches_message_content(session_factory, seeded_user, conversation_factory):
    await conversation_factory(
        title="Chat",
        messages=[{"sender": "user", "content": "Tell me about photosynthesis please"}],
    )
    async with session_factory() as session:
        results = await search_workspace_data(
            db=session, current_user=seeded_user, query="photosynthesis", limit=20
        )
    message_hits = [r for r in results if r.kind == "message"]
    assert message_hits
    assert message_hits[0].subtitle == "You message"


async def test_search_matches_agent_name_and_description(session_factory, seeded_user, seeded_agent):
    # seeded_agent: name="Test Agent", description="Agent used for dialogue bridge API tests"
    async with session_factory() as session:
        results = await search_workspace_data(
            db=session, current_user=seeded_user, query="dialogue bridge", limit=20
        )
    agent_hits = [r for r in results if r.kind == "agent"]
    assert any(r.id == seeded_agent.id for r in agent_hits)


async def test_search_matches_file_attachment(session_factory, seeded_user, conversation_factory):
    created = await conversation_factory(
        title="With file",
        messages=[{"sender": "user", "content": "see attached"}],
    )
    async with session_factory() as session:
        message_id = (
            await session.execute(
                select(MessageTable.id).where(MessageTable.conversation_id == created["conversation_id"])
            )
        ).scalars().first()
        session.add(
            AttachmentTable(
                message_id=message_id,
                file_name="budget_report.xlsx",
                mime_type="application/vnd.ms-excel",
            )
        )
        await session.commit()

    async with session_factory() as session:
        results = await search_workspace_data(
            db=session, current_user=seeded_user, query="budget_report", limit=20
        )
    file_hits = [r for r in results if r.kind == "file"]
    assert file_hits
    assert file_hits[0].title == "budget_report.xlsx"
    assert file_hits[0].snippet == "application/vnd.ms-excel"


async def test_search_excludes_private_and_archived_conversations(session_factory, seeded_user, seeded_agent):
    async with session_factory() as session:
        session.add(
            ConversationTable(
                user_id=seeded_user.id,
                agent_id=seeded_agent.id,
                agent_name=seeded_agent.name,
                title="Secret rocket plans",
                is_private=True,
                is_archived=False,
            )
        )
        session.add(
            ConversationTable(
                user_id=seeded_user.id,
                agent_id=seeded_agent.id,
                agent_name=seeded_agent.name,
                title="Archived rocket notes",
                is_private=False,
                is_archived=True,
            )
        )
        await session.commit()

    async with session_factory() as session:
        results = await search_workspace_data(
            db=session, current_user=seeded_user, query="rocket", limit=20
        )
    convo_hits = [r for r in results if r.kind == "conversation"]
    assert convo_hits == []


async def test_search_respects_limit(session_factory, seeded_user, conversation_factory):
    for i in range(5):
        await conversation_factory(title=f"alpha topic {i}")
    async with session_factory() as session:
        results = await search_workspace_data(
            db=session, current_user=seeded_user, query="alpha", limit=2
        )
    assert len(results) <= 2


async def test_search_underscore_is_literal_not_wildcard(session_factory, seeded_user, conversation_factory):
    # "_" is escaped in the LIKE pattern, so it must match a literal underscore,
    # not any single character.
    await conversation_factory(title="report_2026 summary")
    await conversation_factory(title="reportX2026 other")
    async with session_factory() as session:
        results = await search_workspace_data(
            db=session, current_user=seeded_user, query="report_2026", limit=20
        )
    titles = {r.title for r in results if r.kind == "conversation"}
    assert "report_2026 summary" in titles
    assert "reportX2026 other" not in titles


# ---------------------------------------------------------------------------
# GET /v1/search/{user} route
# ---------------------------------------------------------------------------

async def test_search_route_returns_empty_for_blank_query(client, seeded_user):
    response = await client.get(f"/v1/search/{seeded_user.id}?q=   ")
    assert response.status_code == 200
    assert response.json() == []


async def test_search_route_returns_matches(client, seeded_user, conversation_factory):
    await conversation_factory(title="Marketing roadmap")
    response = await client.get(f"/v1/search/{seeded_user.id}?q=marketing&limit=10")
    assert response.status_code == 200
    body = response.json()
    assert any(item["title"] == "Marketing roadmap" for item in body)
