"""The files an agent presented are snapshotted on its answer (plan 43).

A conversation's files are durable in the agents service, so the bridge stores
only what the agent *presented*: in the finalize transaction, so the card finds
its file the moment the terminal frame reaches the UI. Only the agents
service's file read is stubbed; the database and the finalize path are real.
Pinned:

* presented files are stored before the terminal frame, with title, summary and
  the SHA-256 of the bytes received; nothing else the agent wrote is fetched;
* the read is keyed by user and conversation, never by agent;
* fetches are batched; failed and cancelled runs are captured too;
* a failed fetch or bad base64 never fails the run;
* a fork keeps generated files generated, and share links drop files that were
  never presented (rows captured before plan 43 can be such files).
"""
from __future__ import annotations

import base64
import hashlib

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.orm import selectinload

import utils.inference_runs as ir
import utils.output_capture as oc
from core.database import AttachmentTable, BlobTable, ConversationTable, MessageTable
from core.settings import settings
from utils.conversations import build_share_snapshot, clone_branch_to_conversation, is_shareable
from utils.inference_runs import InferenceRunRuntime


class FakeAgents:
    """The agents service's conversation files — a dict of path → bytes — and the calls made to it."""

    def __init__(self, files: dict[str, bytes]):
        self.files = dict(files)
        self.fetches: list[list[str]] = []
        self.urls: list[str] = []

    async def fetch(self, url, paths):
        self.urls.append(url)
        self.fetches.append(list(paths))
        return [
            {"path": p, "filename": p.rsplit("/", 1)[-1], "mime": "text/plain",
             "size": len(self.files[p]), "base64": base64.b64encode(self.files[p]).decode()}
            for p in paths if p in self.files
        ]


@pytest.fixture
def agents(monkeypatch):
    fake = FakeAgents({})
    monkeypatch.setattr(oc, "fetch_output_files", fake.fetch)
    return fake


@pytest.fixture
def patch_session_local(monkeypatch, session_factory):
    monkeypatch.setattr(ir, "SessionLocal", session_factory)


async def _new_run(session_factory, user, agent):
    async with session_factory() as s:
        conversation = ConversationTable(user_id=user.id, agent_id=agent.id, agent_name=agent.name, title="t")
        s.add(conversation)
        await s.flush()
        run = MessageTable(conversation_id=conversation.id, sender="ai", content="", streaming_status="running",
                           streaming_started_at=ir._now())
        s.add(run)
        await s.commit()
        return conversation.id, run.id


async def _generated(session_factory, run_id):
    async with session_factory() as s:
        rows = (await s.execute(select(AttachmentTable).where(AttachmentTable.message_id == run_id))).scalars().all()
        return {a.file_name: a for a in rows}


def _presented(*paths, title="Report", summary="The Q3 numbers"):
    runtime = InferenceRunRuntime()
    runtime.presented_artifacts = [
        {"artifact_id": f"a{i}", "path": path, "title": title, "summary": summary} for i, path in enumerate(paths)
    ]
    return runtime


async def test_presented_files_are_stored_before_the_terminal_frame(
    agents, patch_session_local, session_factory, seeded_user, seeded_agent
):
    agents.files = {"/conversation/output/report.md": b"# Q3", "/conversation/output/scratch.csv": b"a,b"}
    conversation_id, run_id = await _new_run(session_factory, seeded_user, seeded_agent)

    await ir._mark_run_completed(run_id, _presented("/conversation/output/report.md"))

    stored = await _generated(session_factory, run_id)
    assert set(stored) == {"report.md"}  # what was only written stays in the agents service
    report = stored["report.md"]
    assert (report.title, report.summary, report.origin, report.presented) == (
        "Report", "The Q3 numbers", "generated", True
    )
    assert report.content_sha256 == hashlib.sha256(b"# Q3").hexdigest()
    assert agents.fetches == [["/conversation/output/report.md"]]
    assert agents.urls == [
        f"http://agents.test/users/{seeded_user.id}/conversations/{conversation_id}/files"
    ]


async def test_a_run_that_presented_nothing_fetches_nothing(
    agents, patch_session_local, session_factory, seeded_user, seeded_agent
):
    agents.files = {"/conversation/output/scratch.csv": b"a,b"}
    _, run_id = await _new_run(session_factory, seeded_user, seeded_agent)
    await ir._mark_run_completed(run_id, InferenceRunRuntime())
    assert await _generated(session_factory, run_id) == {}
    assert agents.fetches == []


@pytest.mark.parametrize("finish", ["_mark_run_failed", "_mark_run_cancelled"])
async def test_failed_and_cancelled_runs_are_captured_too(
    agents, patch_session_local, session_factory, seeded_user, seeded_agent, finish
):
    agents.files = {"/conversation/output/partial.md": b"half"}
    _, run_id = await _new_run(session_factory, seeded_user, seeded_agent)
    runtime = _presented("/conversation/output/partial.md")
    if finish == "_mark_run_failed":
        await ir._mark_run_failed(run_id, runtime, "stream died")
    else:
        await ir._mark_run_cancelled(run_id, runtime)
    assert set(await _generated(session_factory, run_id)) == {"partial.md"}


async def test_fetches_are_batched(agents, patch_session_local, session_factory, seeded_user, seeded_agent, monkeypatch):
    monkeypatch.setattr(settings.output_capture, "batch_files", 2)
    agents.files = {f"/conversation/output/f{i}.txt": f"file {i}".encode() for i in range(3)}
    _, run_id = await _new_run(session_factory, seeded_user, seeded_agent)

    await ir._mark_run_completed(run_id, _presented(*agents.files))

    assert len(await _generated(session_factory, run_id)) == 3
    assert [len(batch) for batch in agents.fetches] == [2, 1]


async def test_failures_never_fail_the_run(agents, patch_session_local, session_factory, seeded_user, seeded_agent, monkeypatch):
    async def broken_fetch(url, paths):
        raise httpx.ConnectError("agents down")

    monkeypatch.setattr(oc, "fetch_output_files", broken_fetch)
    _, run_id = await _new_run(session_factory, seeded_user, seeded_agent)
    runtime = _presented("/conversation/output/report.md")
    runtime.content = "the answer"
    await ir._mark_run_completed(run_id, runtime)

    async with session_factory() as s:
        run = await s.get(MessageTable, run_id)
        assert run.streaming_status == "completed" and run.content == "the answer"


async def test_bad_base64_is_skipped(agents, patch_session_local, session_factory, seeded_user, seeded_agent, monkeypatch):
    agents.files = {"/conversation/output/ok.txt": b"ok", "/conversation/output/bad.txt": b"x"}
    real_fetch = agents.fetch

    async def corrupting_fetch(url, paths):
        files = await real_fetch(url, paths)
        for f in files:
            if f["path"].endswith("bad.txt"):
                f["base64"] = "%%% not base64"
        return files

    monkeypatch.setattr(oc, "fetch_output_files", corrupting_fetch)
    _, run_id = await _new_run(session_factory, seeded_user, seeded_agent)
    await ir._mark_run_completed(run_id, _presented(*agents.files))
    assert set(await _generated(session_factory, run_id)) == {"ok.txt"}


async def test_a_fork_keeps_generated_files_generated_and_shares_drop_unpresented_ones(
    agents, patch_session_local, session_factory, seeded_user, seeded_agent
):
    """The clone used to copy name, type and bytes only, so a presented file came
    back as an "upload" (in the user's file stack, its card broken). A generated
    file that was never presented — captured before plan 43 — stays private."""
    agents.files = {"/conversation/output/report.md": b"# Q3"}
    conv_id, run_id = await _new_run(session_factory, seeded_user, seeded_agent)
    await ir._mark_run_completed(run_id, _presented("/conversation/output/report.md"))
    async with session_factory() as s:
        s.add(AttachmentTable(message_id=run_id, file_name="scratch.csv", mime_type="text/csv", origin="generated",
                              presented=False, blob=BlobTable(data=b"a,b")))
        await s.commit()

    async with session_factory() as s:
        source = (await s.execute(
            select(ConversationTable).where(ConversationTable.id == conv_id).options(selectinload(ConversationTable.agent))
        )).scalar_one()
        branch = list((await s.execute(
            select(MessageTable).where(MessageTable.id == run_id)
            .options(selectinload(MessageTable.attachments).selectinload(AttachmentTable.blob))
        )).scalars())
        snapshot = build_share_snapshot(source, branch)
        fork = await clone_branch_to_conversation(db=s, source_conv=source, branch=branch, forked_message_id=run_id)
        await s.commit()
        fork_id = fork.id

    assert [a["name"] for a in snapshot["messages"][0]["attachments"]] == ["report.md"]
    assert snapshot["messages"][0]["attachments"][0]["origin"] == "generated"

    async with session_factory() as s:
        copied = (await s.execute(
            select(AttachmentTable).join(MessageTable, AttachmentTable.message_id == MessageTable.id)
            .where(MessageTable.conversation_id == fork_id)
        )).scalars().all()
    by_name = {a.file_name: a for a in copied}
    assert {a.origin for a in copied} == {"generated"}
    assert by_name["report.md"].presented and by_name["report.md"].title == "Report"
    assert not by_name["scratch.csv"].presented
    assert is_shareable(by_name["report.md"]) and not is_shareable(by_name["scratch.csv"])
