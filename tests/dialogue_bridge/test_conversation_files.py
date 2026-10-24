"""Conversation files in Postgres — the bridge's half (plan 43).

The agent's ``/conversation/input/`` folder is a view of this database's
uploads, so the bridge now owns three promises:

* every upload has a **stable name** — assigned once, unique per conversation,
  by the rule the agents service used to apply on its volume (migration 0042
  backfills old rows with a frozen copy of it), and the history the agent reads
  points at that name;
* the uploads are **served** to the agents service only — every upload of the
  conversation, every branch, scoped to its owner;
* deleting a conversation **reaps** its agents-service state through an outbox
  row written in the delete's own transaction, retried until it succeeds.
"""
from __future__ import annotations

import base64
import hashlib
import importlib.util
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import select

import utils.runtime_reaps as runtime_reaps
from core.database import (
    AttachmentTable,
    BlobTable,
    ConversationTable,
    MessageTable,
    PendingRuntimeReapTable,
)
from core.settings import settings
from schema import AttachmentIn, MessageIn
from utils.conversations import init_conv, init_message
from utils.inference import serialise_message_with_images_for_agent
from utils.workspace_names import WorkspaceNames, safe_workspace_name

MIGRATION = (
    Path(__file__).resolve().parents[2] / "magenticx" / "dialogue_bridge"
    / "core" / "database" / "migrations" / "versions" / "0042_conversation_files.py"
)


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _upload(name: str, data: bytes) -> AttachmentIn:
    return AttachmentIn(name=name, mime="text/plain", dataB64=base64.b64encode(data).decode())


@pytest.fixture
def internal_headers():
    return {settings.proxy.header_name: settings.proxy.secret.get_secret_value()}


# ---------------------------------------------------------------------------
# Stable names
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("report.pdf", "report.pdf"),
        ("../../etc/passwd", "_.._etc_passwd"),
        ("a\\b.txt", "a_b.txt"),
        (".env", "env"),
        ("...", "file"),
        ("", "file"),
        ("tab\there.csv", "tab_here.csv"),
        ("Café.txt", "Café.txt"),  # NFC, as the agents service compares
    ],
)
def test_an_upload_name_becomes_one_safe_segment(raw, expected):
    assert safe_workspace_name(raw) == expected


def test_a_long_name_keeps_its_extension():
    name = safe_workspace_name("x" * 500 + ".xlsx")
    assert len(name) == 200 and name.endswith(".xlsx")


def test_names_follow_the_rule_the_volume_used():
    """First holder keeps the name, different bytes are suffixed, the same
    bytes reuse it — browsers name every pasted image ``image.png``."""
    names = WorkspaceNames()
    assert names.assign("image.png", _sha(b"one")) == "image.png"
    assert names.assign("image.png", _sha(b"two")) == "image_1.png"
    assert names.assign("image.png", _sha(b"one")) == "image.png"
    assert names.assign("image.png", _sha(b"three")) == "image_2.png"
    assert names.assign("image.png", _sha(b"two")) == "image_1.png"
    assert names.assign("notes", _sha(b"a")) == "notes"
    assert names.assign("notes", _sha(b"b")) == "notes_1"


def _migration():
    spec = importlib.util.spec_from_file_location("migration_0042", MIGRATION)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_migration_freezes_the_same_rule():
    """The backfill holds its own copy of the rule (a migration must not move
    with application code); today the two must agree."""
    migration = _migration()
    cases = [("image.png", "a"), ("image.png", "b"), ("image.png", "a"), ("../x", "c"), (".env", "d"),
             ("x" * 300 + ".md", "e"), ("x" * 300 + ".md", "f")]
    live, frozen = WorkspaceNames(), {}
    for raw, digest in cases:
        assert migration._assign(frozen, raw, digest) == live.assign(raw, digest)


async def test_the_backfill_names_uploads_in_upload_order_per_conversation(db_engine, session_factory, seeded_user,
                                                                             seeded_agent):
    start = datetime.now(UTC).replace(tzinfo=None)
    async with session_factory() as s:
        conversations = [ConversationTable(user_id=seeded_user.id, agent_id=seeded_agent.id, title=t) for t in "ab"]
        s.add_all(conversations)
        await s.flush()
        uploads = [(0, "img.png", "x"), (0, "img.png", "y"), (0, "img.png", "x"), (1, "img.png", "y")]
        for minute, (index, name, digest) in enumerate(uploads):
            message = MessageTable(conversation_id=conversations[index].id, sender="user", content="",
                                   created_at=start + timedelta(minutes=minute))
            s.add(message)
            await s.flush()
            s.add(AttachmentTable(message_id=message.id, file_name=name, mime_type="image/png",
                                  content_sha256=digest, blob=BlobTable(data=b"")))
        generated = MessageTable(conversation_id=conversations[0].id, sender="ai", content="", created_at=start)
        s.add(generated)
        await s.flush()
        s.add(AttachmentTable(message_id=generated.id, file_name="img.png", mime_type="image/png",
                              origin="generated", blob=BlobTable(data=b"")))
        await s.commit()

    migration = _migration()

    def backfill(connection):
        with Operations.context(MigrationContext.configure(connection)):
            migration._backfill_workspace_names()

    async with db_engine.begin() as connection:
        await connection.run_sync(backfill)

    async with session_factory() as s:
        rows = (await s.execute(
            select(MessageTable.conversation_id, AttachmentTable.workspace_name, AttachmentTable.origin)
            .join(MessageTable, AttachmentTable.message_id == MessageTable.id)
            .order_by(MessageTable.created_at, AttachmentTable.created_at)
        )).all()
    by_conversation = {}
    for conversation_id, name, origin in rows:
        by_conversation.setdefault((conversation_id, origin), []).append(name)
    assert by_conversation[(conversations[0].id, "upload")] == ["img.png", "img_1.png", "img.png"]
    assert by_conversation[(conversations[1].id, "upload")] == ["img.png"]
    assert by_conversation[(conversations[0].id, "generated")] == [None]


async def test_uploads_get_their_name_and_hash_when_they_arrive(session_factory, seeded_user, seeded_agent):
    async with session_factory() as s:
        conversation = await init_conv(
            s, seeded_user, seeded_agent, False, "t",
            MessageIn(sender="user", content="two images", attachments=[
                _upload("image.png", b"first"), _upload("image.png", b"second"),
            ]),
        )
        await s.commit()
        conversation_id = conversation.id
    async with session_factory() as s:
        conversation = await s.get(ConversationTable, conversation_id)
        await init_message(s, conversation, MessageIn(sender="user", content="again", attachments=[
            _upload("image.png", b"first"), _upload(".hidden", b"third"),
        ]))
        await s.commit()

    async with session_factory() as s:
        rows = (await s.execute(select(AttachmentTable.workspace_name, AttachmentTable.content_sha256))).all()
    assert sorted(rows) == sorted([
        ("image.png", _sha(b"first")), ("image_1.png", _sha(b"second")),
        ("image.png", _sha(b"first")), ("hidden", _sha(b"third")),
    ])


def test_the_history_points_at_an_upload_by_its_stable_name():
    upload = SimpleNamespace(origin="upload", file_name="image.png", workspace_name="image_1.png",
                             mime_type="text/plain", blob=None)
    generated = SimpleNamespace(origin="generated", file_name="report.md", workspace_name=None,
                                mime_type="text/markdown", blob=None)
    message = SimpleNamespace(sender="user", content="look", attachments=[upload, generated])

    text = str(serialise_message_with_images_for_agent(message, include_input_paths=True)["content"])

    assert "image.png (text/plain) — /conversation/input/image_1.png" in text
    # A generated file is no upload: no input path to send the agent looking.
    assert "report.md (text/markdown)" in text and "/conversation/input/report.md" not in text


# ---------------------------------------------------------------------------
# The internal endpoints
# ---------------------------------------------------------------------------
async def _conversation_with_branches(session_factory, user, agent):
    """Two sibling branches, each with an upload, plus a generated file."""
    async with session_factory() as s:
        conversation = await init_conv(s, user, agent, False, "t", MessageIn(
            sender="user", content="first", attachments=[_upload("a.txt", b"alpha")]))
        await s.flush()
        root = (await s.execute(select(MessageTable).where(MessageTable.conversation_id == conversation.id))).scalar_one()
        await init_message(s, conversation, MessageIn(sender="user", content="edit",
                                                      attachments=[_upload("a.txt", b"beta")]))
        answer = await init_message(s, conversation, MessageIn(sender="ai", content="done"), parent_message_id=root.id)
        s.add(AttachmentTable(message_id=answer.id, file_name="out.md", mime_type="text/markdown",
                              origin="generated", presented=True, blob=BlobTable(data=b"out")))
        await s.commit()
        return conversation.id


async def test_the_agent_lists_every_upload_of_every_branch(client, session_factory, seeded_user, seeded_agent,
                                                            internal_headers):
    conversation_id = await _conversation_with_branches(session_factory, seeded_user, seeded_agent)

    response = await client.get(f"/v1/internal/conversations/{conversation_id}/input-files",
                                params={"user_id": seeded_user.id}, headers=internal_headers)

    assert response.status_code == 200
    files = response.json()["files"]
    assert [(f["name"], f["size"], f["sha256"]) for f in files] == [
        ("a.txt", 5, _sha(b"alpha")), ("a_1.txt", 4, _sha(b"beta")),
    ]

    read = await client.get(f"/v1/internal/conversations/{conversation_id}/input-files/{files[1]['attachment_id']}",
                            params={"user_id": seeded_user.id}, headers=internal_headers)
    assert read.status_code == 200 and read.content == b"beta"


async def test_uploads_are_served_to_internal_callers_and_the_owner_only(client, session_factory, seeded_user,
                                                                         seeded_agent, internal_headers):
    conversation_id = await _conversation_with_branches(session_factory, seeded_user, seeded_agent)
    url = f"/v1/internal/conversations/{conversation_id}/input-files"

    assert (await client.get(url, params={"user_id": seeded_user.id})).status_code == 403
    assert (await client.get(url, params={"user_id": "someone-else"}, headers=internal_headers)).status_code == 404

    async with session_factory() as s:
        generated_id = (await s.execute(
            select(AttachmentTable.id).where(AttachmentTable.origin == "generated"))).scalar_one()
    generated = await client.get(f"{url}/{generated_id}", params={"user_id": seeded_user.id}, headers=internal_headers)
    assert generated.status_code == 404  # the agent's own output is not an upload


async def test_the_migration_asks_which_conversations_still_exist(client, session_factory, seeded_user,
                                                                  seeded_agent, internal_headers):
    conversation_id = await _conversation_with_branches(session_factory, seeded_user, seeded_agent)

    response = await client.post("/v1/internal/conversations/existing", headers=internal_headers,
                                 json={"user_id": seeded_user.id, "conversation_ids": [conversation_id, "gone"]})

    assert response.status_code == 200 and response.json() == {"conversation_ids": [conversation_id]}


# ---------------------------------------------------------------------------
# The reap outbox
# ---------------------------------------------------------------------------
@pytest.fixture
def agents_reap(monkeypatch, session_factory):
    """The agents service's reap route, answering ``status`` (a list, so a test can change it)."""
    calls: list[tuple[str, str, list[str]]] = []
    status = [204]

    async def send(_client, row):
        calls.append((row.user_id, row.conversation_id, list(row.thread_ids)))
        if status[0] >= 400:
            raise httpx.ConnectError("agents down")

    monkeypatch.setattr(runtime_reaps, "SessionLocal", session_factory)
    monkeypatch.setattr(runtime_reaps, "_send", send)
    return SimpleNamespace(calls=calls, status=status)


async def _conversation_with_threads(session_factory, user, agent):
    async with session_factory() as s:
        conversation = ConversationTable(user_id=user.id, agent_id=agent.id, title="t")
        s.add(conversation)
        await s.flush()
        for thread in ("thread-a", "thread-b", "thread-a"):
            s.add(MessageTable(conversation_id=conversation.id, sender="ai", content="",
                               checkpoint_thread_id=thread))
        await s.commit()
        return conversation.id


async def _outbox(session_factory):
    async with session_factory() as s:
        return list((await s.execute(select(PendingRuntimeReapTable))).scalars())


async def test_deleting_a_conversation_reaps_its_runtime_by_id(client, session_factory, seeded_user, seeded_agent,
                                                               agents_reap):
    conversation_id = await _conversation_with_threads(session_factory, seeded_user, seeded_agent)

    response = await client.delete(f"/v1/conversations/{seeded_user.id}/{conversation_id}")

    assert response.status_code == 204
    # No agent lookup: an inactive or deleted agent can no longer leave orphans.
    assert agents_reap.calls == [(seeded_user.id, conversation_id, ["thread-a", "thread-b"])]
    assert await _outbox(session_factory) == []


async def test_a_failed_reap_is_kept_and_sent_again_later(client, session_factory, seeded_user, seeded_agent,
                                                          agents_reap):
    conversation_id = await _conversation_with_threads(session_factory, seeded_user, seeded_agent)
    agents_reap.status[0] = 503

    response = await client.delete(f"/v1/conversations/{seeded_user.id}/{conversation_id}")

    assert response.status_code == 204  # the delete itself never waits on the agents service
    [pending] = await _outbox(session_factory)
    assert (pending.conversation_id, pending.attempts, pending.last_error) == (conversation_id, 1, "ConnectError")

    agents_reap.status[0] = 204
    assert await runtime_reaps.drain_runtime_reaps() == 1  # what the bridge does at boot
    assert await _outbox(session_factory) == []
    assert len(agents_reap.calls) == 2
