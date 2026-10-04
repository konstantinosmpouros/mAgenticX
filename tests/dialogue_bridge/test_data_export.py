"""Export my data (plan 27) — the bridge side, end to end over a real archive.

Every test that streams an export collects the bytes the client would receive,
opens them with the standard library's ``zipfile``, and asserts on what is (and
is not) inside. The agents service is played by an ``httpx.MockTransport`` that
speaks the framed protocol, so no network is involved.

What these pin is the contract the user relies on:

* the archive holds their data and only their data — no tokens, no share-link
  secrets, no raw event logs, nothing from another user;
* a text-only export carries no attachment bytes;
* a download cut short is not a valid zip, and gives the cooldown back;
* the cooldown, the token and the concurrency limit cannot be walked around.
"""
from __future__ import annotations

import asyncio
import io
import json
import zipfile
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from pydantic import ValidationError

import utils.data_export as data_export
from core.database import AttachmentTable, BlobTable, ConversationShareTable, MessageTable, UserTable
from core.settings import ExportSettings, settings

BLOB_BYTES = bytes(range(256)) * 9000  # ~2.3 MB, so it spans several slices


@pytest.fixture(autouse=True)
def _export_env(monkeypatch, session_factory):
    """Point the module at the test database, switch exports on, small pages."""
    monkeypatch.setattr(data_export, "SessionLocal", session_factory)
    monkeypatch.setattr(settings.export, "enabled", True)
    monkeypatch.setattr(settings.export, "page_rows", 2)          # force real paging
    monkeypatch.setattr(settings.export, "chunk_bytes", 1024 * 1024)
    data_export.SLOTS._leases.clear()


def _agents_handler(frames):
    lines = "".join(json.dumps(f) + "\n" for f in frames).encode()
    return lambda request: httpx.Response(200, content=lines)


AGENT_FRAMES = [
    {"op": "open", "path": "agents/agents.ndjson", "encoding": "utf-8"},
    {"op": "data", "text": json.dumps({"slug": "my-bot", "spec": {"name": "My Bot"}}) + "\n"},
    {"op": "close"},
    {"op": "open", "path": "skills/notes/SKILL.md", "encoding": "utf-8"},
    {"op": "data", "text": "---\nname: notes\n---\nBody."},
    {"op": "close"},
    {"op": "open", "path": "skills/notes/logo.png", "encoding": "base64"},
    {"op": "data", "text": "iVBORw0KGgo="},
    {"op": "close"},
    {"op": "end", "counts": {"agents": 1, "skills": 1}},
]


@pytest.fixture()
def agents_upstream(monkeypatch):
    """Serve ``frames`` (or a raw handler) as the agents service's export stream."""
    real = httpx.AsyncClient

    def install(frames=None, handler=None):
        transport = httpx.MockTransport(handler or _agents_handler(frames or AGENT_FRAMES))
        monkeypatch.setattr(data_export.httpx, "AsyncClient",
                            lambda *a, **k: real(transport=transport, timeout=k.get("timeout")))

    install()
    return install


async def _seed(session_factory, user, agent):
    """One conversation with three messages (one carrying an attachment), a share
    and — belonging to someone else — a conversation that must never appear."""
    async with session_factory() as session:
        from_db = await session.get(UserTable, user.id)
        other = UserTable(username="someone-else", oidc_subject="oid-other", is_active=True)
        session.add(other)
        await session.flush()
        conv = data_export.ConversationTable(user_id=from_db.id, agent_id=agent.id, title="Mine")
        foreign = data_export.ConversationTable(user_id=other.id, agent_id=agent.id, title="NOT MINE")
        session.add_all([conv, foreign])
        await session.flush()
        msgs = [MessageTable(conversation_id=conv.id, sender="user" if i % 2 == 0 else "ai",
                             content=f"message {i}", raw_events=[{"secret": "internal-event-log"}])
                for i in range(3)]
        session.add_all(msgs)
        session.add(MessageTable(conversation_id=foreign.id, sender="user", content="FOREIGN MESSAGE"))
        await session.flush()
        blob = BlobTable(data=BLOB_BYTES)
        session.add(blob)
        await session.flush()
        session.add(AttachmentTable(message_id=msgs[0].id, file_name="../../report.pdf",
                                    mime_type="application/pdf", size_bytes=len(BLOB_BYTES), blob_id=blob.id))
        session.add(ConversationShareTable(token="SHARE-TOKEN-SECRET", conversation_id=conv.id,
                                           owner_user_id=from_db.id, snapshot_json={"copy": "SNAPSHOT"}))
        await session.commit()
        return conv.id


async def _collect(user_id, include_attachments=True):
    claim = await data_export.claim_export(user_id)
    assert claim is not None
    assert data_export.SLOTS.try_acquire(user_id)
    out = bytearray()
    async for chunk in data_export.stream_export(user_id, include_attachments=include_attachments, claim=claim):
        out += chunk
    return bytes(out)


# ---------------------------------------------------------------------------
# The archive
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_a_full_export_holds_the_users_data_and_nothing_else(
    session_factory, seeded_user, seeded_agent, agents_upstream
):
    await _seed(session_factory, seeded_user, seeded_agent)
    archive = await _collect(seeded_user.id)

    with zipfile.ZipFile(io.BytesIO(archive)) as zf:
        assert zf.testzip() is None
        names = zf.namelist()
        manifest = json.loads(zf.read("manifest.json"))
        messages = [json.loads(l) for l in zf.read("conversations/messages.ndjson").splitlines()]
        attachments = [json.loads(l) for l in zf.read("conversations/attachments.ndjson").splitlines()]
        everything = b"".join(zf.read(n) for n in names)

        assert names[-1] == "manifest.json"                       # written last
        assert {"README.md", "account/profile.json", "account/preferences.json",
                "conversations/conversations.ndjson", "conversations/shares.ndjson",
                "agents/agents.ndjson", "skills/notes/SKILL.md", "skills/notes/logo.png"} <= set(names)
        assert sorted(m["content"] for m in messages) == ["message 0", "message 1", "message 2"]
        assert len({m["id"] for m in messages}) == 3                  # none skipped, none twice
        # The attachment's bytes, intact, at a path that cannot escape the folder.
        [att] = attachments
        assert att["archive_path"].startswith(f"attachments/{att['id']}/") and ".." not in att["archive_path"]
        assert zf.read(att["archive_path"]) == BLOB_BYTES
        assert zf.read("skills/notes/logo.png") == bytes.fromhex("89504e470d0a1a0a")
        assert manifest["complete"] is True and manifest["records"]["conversations/messages.ndjson"] == 3

    # Never in an export: share-link tokens and snapshots, raw event logs, and
    # anything belonging to another user.
    for forbidden in (b"SHARE-TOKEN-SECRET", b"SNAPSHOT", b"internal-event-log", b"NOT MINE", b"FOREIGN MESSAGE"):
        assert forbidden not in everything, forbidden
    # Text entries are deflated; attachment bytes are stored as-is.
    with zipfile.ZipFile(io.BytesIO(archive)) as zf:
        info = {i.filename: i for i in zf.infolist()}
        assert info["conversations/messages.ndjson"].compress_type == zipfile.ZIP_DEFLATED
        assert info[att["archive_path"]].compress_type == zipfile.ZIP_STORED


@pytest.mark.asyncio
async def test_a_text_only_export_carries_no_attachment_bytes(
    session_factory, seeded_user, seeded_agent, agents_upstream
):
    await _seed(session_factory, seeded_user, seeded_agent)
    archive = await _collect(seeded_user.id, include_attachments=False)
    with zipfile.ZipFile(io.BytesIO(archive)) as zf:
        assert not [n for n in zf.namelist() if n.startswith("attachments/")]
        [att] = [json.loads(l) for l in zf.read("conversations/attachments.ndjson").splitlines()]
        assert att["archive_path"] is None and att["file_name"] == "../../report.pdf"
        assert BLOB_BYTES[:1000] not in b"".join(zf.read(n) for n in zf.namelist())


@pytest.mark.asyncio
async def test_without_the_agents_service_the_export_says_so(
    session_factory, seeded_user, seeded_agent, agents_upstream
):
    agents_upstream(handler=lambda request: httpx.Response(503))
    archive = await _collect(seeded_user.id)
    with zipfile.ZipFile(io.BytesIO(archive)) as zf:
        manifest = json.loads(zf.read("manifest.json"))
    assert manifest["complete"] is False
    assert manifest["missing"] and "agents" in manifest["missing"][0]


@pytest.mark.asyncio
async def test_upstream_cannot_write_outside_agents_and_skills(
    session_factory, seeded_user, seeded_agent, agents_upstream
):
    agents_upstream([{"op": "open", "path": "../outside.txt", "encoding": "utf-8"}])
    archive = await _collect(seeded_user.id)
    with zipfile.ZipFile(io.BytesIO(archive)) as zf:
        assert not [n for n in zf.namelist() if "outside" in n]
        assert json.loads(zf.read("manifest.json"))["complete"] is False


@pytest.mark.asyncio
async def test_a_cut_upstream_stream_aborts_and_gives_the_cooldown_back(
    session_factory, seeded_user, seeded_agent, agents_upstream
):
    """Once a file from the agents service is half-written it cannot be rolled
    back, so the export is aborted: no central directory, so not a valid zip —
    and the user's cooldown is restored so they can simply try again."""
    agents_upstream([{"op": "open", "path": "agents/agents.ndjson", "encoding": "utf-8"},
                     {"op": "data", "text": "partial"}])        # no close, no end
    claim = await data_export.claim_export(seeded_user.id)
    assert data_export.SLOTS.try_acquire(seeded_user.id)
    out = bytearray()
    with pytest.raises(data_export.ExportAborted):
        async for chunk in data_export.stream_export(seeded_user.id, include_attachments=True, claim=claim):
            out += chunk
    with pytest.raises(zipfile.BadZipFile):
        zipfile.ZipFile(io.BytesIO(bytes(out)))
    assert await data_export.claim_export(seeded_user.id) is not None    # cooldown given back
    assert data_export.SLOTS.try_acquire(seeded_user.id)                  # slot released


# ---------------------------------------------------------------------------
# Cooldown, slots, token
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_the_cooldown_admits_one_export_per_window(seeded_user):
    first = await data_export.claim_export(seeded_user.id)
    assert first is not None
    assert await data_export.claim_export(seeded_user.id) is None
    status = await data_export.export_status(seeded_user.id)
    assert status["enabled"] is True and status["availableAt"] is not None


@pytest.mark.asyncio
async def test_two_racing_claims_cannot_both_win(seeded_user):
    results = await asyncio.gather(*(data_export.claim_export(seeded_user.id) for _ in range(5)))
    assert sum(1 for r in results if r is not None) == 1


@pytest.mark.asyncio
async def test_an_expired_cooldown_frees_the_slot(session_factory, seeded_user):
    async with session_factory() as session:
        user = await session.get(UserTable, seeded_user.id)
        user.last_export_at = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(
            minutes=settings.export.cooldown_minutes + 1
        )
        await session.commit()
    assert await data_export.claim_export(seeded_user.id) is not None


def test_the_cooldown_defaults_to_one_week_and_is_bounded():
    """One export per user per week; a zero or absurd window is refused at boot."""
    assert ExportSettings.model_fields["cooldown_minutes"].default == 7 * 24 * 60
    for bad in (0, 30 * 24 * 60 + 1):
        with pytest.raises(ValidationError):
            ExportSettings.model_validate({"EXPORT_COOLDOWN_MINUTES": bad})


def test_slots_bound_concurrency_and_one_per_user(monkeypatch):
    monkeypatch.setattr(settings.export, "max_concurrent", 2)
    slots = data_export._ExportSlots()
    assert slots.try_acquire("a") and not slots.try_acquire("a")       # one per user
    assert slots.try_acquire("b") and not slots.try_acquire("c")       # two in total
    slots.release("a")
    assert slots.try_acquire("c")


def test_a_lease_whose_stream_never_ran_expires(monkeypatch):
    slots = data_export._ExportSlots()
    assert slots.try_acquire("a")
    slots._leases["a"] -= settings.export.max_seconds + 120             # an abandoned lease
    assert slots.try_acquire("a")


def test_the_download_token_is_bound_to_user_kind_and_time():
    token = data_export.mint_export_token("u1", True, now=1000)
    assert data_export.verify_export_token(token, "u1", now=1001) is True
    assert data_export.verify_export_token(data_export.mint_export_token("u1", False, now=1000), "u1", now=1001) is False
    assert data_export.verify_export_token(token, "someone-else", now=1001) is None
    assert data_export.verify_export_token(token, "u1", now=1000 + settings.export.token_ttl_seconds + 1) is None
    assert data_export.verify_export_token(token[:-2] + "AA", "u1", now=1001) is None
    assert data_export.verify_export_token("not-a-token", "u1") is None


def test_a_docx_preview_token_is_not_an_export_token():
    """Both are signed with the same key; the purpose tag keeps them apart."""
    from utils.attachments import generate_docx_preview_token

    docx = generate_docx_preview_token("blob-1", "application/pdf", settings.session.token_secret.get_secret_value())
    assert data_export.verify_export_token(docx, "blob-1") is None


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_routes_refuse_while_exports_are_off(client, seeded_user, monkeypatch):
    monkeypatch.setattr(settings.export, "enabled", False)
    status_ = await client.get(f"/v1/export/{seeded_user.id}/status")
    assert status_.status_code == 200 and status_.json()["enabled"] is False
    token = await client.post(f"/v1/export/{seeded_user.id}/token", json={"includeAttachments": True})
    assert token.status_code == 503


@pytest.mark.asyncio
async def test_a_token_is_refused_during_the_cooldown(client, seeded_user):
    assert (await client.post(f"/v1/export/{seeded_user.id}/token", json={})).status_code == 200
    await data_export.claim_export(seeded_user.id)
    refused = await client.post(f"/v1/export/{seeded_user.id}/token", json={})
    assert refused.status_code == 429 and int(refused.headers["Retry-After"]) > 0


@pytest.mark.asyncio
async def test_a_bad_download_token_is_refused_and_costs_no_cooldown(client, seeded_user):
    bad = await client.get(f"/v1/export/{seeded_user.id}/download", params={"token": "x" * 40})
    assert bad.status_code == 403
    assert (await data_export.export_status(seeded_user.id))["availableAt"] is None


@pytest.mark.asyncio
async def test_the_download_streams_a_zip_with_no_proxy_buffering(
    client, session_factory, seeded_user, seeded_agent, agents_upstream
):
    await _seed(session_factory, seeded_user, seeded_agent)
    token = (await client.post(f"/v1/export/{seeded_user.id}/token", json={"includeAttachments": False})).json()["token"]
    response = await client.get(f"/v1/export/{seeded_user.id}/download", params={"token": token})
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/zip"
    assert response.headers["x-accel-buffering"] == "no"
    assert "attachment" in response.headers["content-disposition"]
    with zipfile.ZipFile(io.BytesIO(response.content)) as zf:
        assert "manifest.json" in zf.namelist()
    # The same token cannot start a second export inside the cooldown.
    again = await client.get(f"/v1/export/{seeded_user.id}/download", params={"token": token})
    assert again.status_code == 429
