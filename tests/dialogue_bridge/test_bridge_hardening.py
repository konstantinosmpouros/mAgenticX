"""Hardening from the 2026-11-11 review: the API docs stay off the internet,
and an inline preview can never run as a page. (The PDF export off the event
loop: test_share_export.py.)"""

from __future__ import annotations

from pathlib import Path

import main as bridge_main
import pytest

from core.database import AttachmentTable, BlobTable, ConversationTable, MessageTable
from utils.attachments import ACTIVE_CONTENT_MIMES

REPO_ROOT = Path(__file__).resolve().parents[2]


# --- 2. API docs ------------------------------------------------------------------

def test_api_docs_exist_only_in_development_and_test():
    assert bridge_main.API_DOCS_ENABLED is (bridge_main.settings.app.env in {"development", "test"})
    source = (REPO_ROOT / "magenticx" / "dialogue_bridge" / "main.py").read_text(encoding="utf-8")
    for route in ('"/docs" if API_DOCS_ENABLED else None', '"/redoc" if API_DOCS_ENABLED else None',
                  '"/openapi.json" if API_DOCS_ENABLED else None'):
        assert route in source


def test_the_edge_never_serves_the_api_docs():
    nginx = (REPO_ROOT / "magenticx" / "agentic_ui" / "nginx.conf.template").read_text(encoding="utf-8")
    deny = "location ~ ^/api/(docs|redoc|openapi\\.json)(/|$) {\n    return 404;"
    assert deny in nginx
    # A regex location must come before nothing that would swallow it: only ^~
    # prefixes beat a regex, and none of them covers /api/docs.
    assert "location ^~ /api/ " not in nginx and "location ^~ /api/docs" not in nginx


# --- 5. inline preview ------------------------------------------------------------------

async def _attachment(db_session_factory, seeded_user, seeded_agent, file_name, mime_type, data=b"x"):
    async with db_session_factory() as session:
        conversation = ConversationTable(
            user_id=seeded_user.id, agent_id=seeded_agent.id, agent_name=seeded_agent.name,
            title="Preview", last_message_preview=file_name,
        )
        session.add(conversation)
        await session.flush()
        message = MessageTable(conversation_id=conversation.id, sender="assistant", content=file_name)
        session.add(message)
        await session.flush()
        blob = BlobTable(data=data)
        session.add(AttachmentTable(
            message_id=message.id, file_name=file_name, mime_type=mime_type, size_bytes=len(data), blob=blob,
        ))
        await session.commit()
        return f"/v1/attachments/preview/{seeded_user.id}/{conversation.id}/{message.id}/{blob.id}"


async def test_an_inline_preview_runs_nothing_if_opened_as_a_page(client, seeded_user, seeded_agent, db_session_factory):
    url = await _attachment(db_session_factory, seeded_user, seeded_agent, "brief.pdf", "application/pdf", b"%PDF")
    response = await client.get(url)
    assert response.status_code == 200
    assert response.headers["content-security-policy"] == "sandbox; default-src 'none'"
    assert response.headers["content-disposition"].startswith("inline")
    assert response.headers["x-content-type-options"] == "nosniff"


@pytest.mark.parametrize("file_name, mime", [
    ("report.html", "text/html"),
    ("report.html", "text/html; charset=utf-8"),
    ("page.xhtml", "application/xhtml+xml"),
    ("x.js", "text/javascript"),
    ("x.js", "application/javascript"),
    ("data.xml", "application/xml"),
])
async def test_active_content_is_never_served_inline(client, seeded_user, seeded_agent, db_session_factory, file_name, mime):
    url = await _attachment(db_session_factory, seeded_user, seeded_agent, file_name, mime, b"<script>alert(1)</script>")
    response = await client.get(url)
    assert response.status_code == 200
    assert response.headers["content-disposition"].startswith("attachment")
    assert response.headers["content-security-policy"] == "sandbox; default-src 'none'"


def test_the_active_types_cover_html_svg_js_and_xml():
    assert {"text/html", "image/svg+xml", "text/javascript", "application/javascript", "application/xml"} <= ACTIVE_CONTENT_MIMES


async def test_a_download_keeps_its_headers(client, seeded_user, seeded_agent, db_session_factory):
    url = await _attachment(db_session_factory, seeded_user, seeded_agent, "notes.txt", "text/plain", b"hello")
    response = await client.get(url.replace("/preview/", "/download/"))
    assert response.status_code == 200
    assert response.headers["content-disposition"].startswith("attachment")
    assert "content-security-policy" not in response.headers  # a download is saved, never rendered
