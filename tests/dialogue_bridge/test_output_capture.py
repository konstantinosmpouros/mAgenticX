"""Every file an agent wrote is stored at run end (plan 35 phase 0).

Only the agents service's half is stubbed (the manifest and the file reads);
the database, the dedup query and the finalize path are real. Pinned:

* presented files are stored in the finalize transaction — before the terminal
  frame — and every other file afterwards, in the background, so the UI never
  waits; a presented file is never stored twice;
* every file in the manifest ends up on the answer with the SHA-256 of the
  bytes received; presented ones carry title and summary;
* an unchanged file is not stored again; a changed one becomes a new version;
  a presented file is always stored (its card is matched on this answer);
* fetches are batched by count and bytes, and a run's caps are honoured;
* failed and cancelled runs are captured too; LangGraph agents are skipped;
* a manifest failure, a failed batch or bad base64 never fails the run.
"""
from __future__ import annotations

import base64
import hashlib
from types import SimpleNamespace

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.orm import selectinload

import utils.inference_runs as ir
import utils.output_capture as oc
from core.database import AttachmentTable, ConversationTable, MessageTable
from core.settings import settings
from utils.conversations import build_share_snapshot, clone_branch_to_conversation, is_shareable
from utils.inference_runs import InferenceRunRuntime

DEEP = SimpleNamespace(type="deep agent", slug="omni-agent-v1")


class FakeAgents:
    """The agents service's output/ — a dict of path → bytes — and the calls made to it."""

    def __init__(self, files: dict[str, bytes]):
        self.files = dict(files)
        self.fetches: list[list[str]] = []

    async def manifest(self, url):
        return [
            {"path": p, "filename": p.rsplit("/", 1)[-1], "mime": "text/plain",
             "size": len(b), "sha256": hashlib.sha256(b).hexdigest()}
            for p, b in self.files.items()
        ]

    async def fetch(self, url, paths):
        self.fetches.append(list(paths))
        return [
            {"path": p, "filename": p.rsplit("/", 1)[-1], "mime": "text/plain",
             "size": len(self.files[p]), "base64": base64.b64encode(self.files[p]).decode()}
            for p in paths if p in self.files
        ]


@pytest.fixture
def agents(monkeypatch):
    fake = FakeAgents({})

    async def agent_by_id(_agent_id):
        return fake.agent

    fake.agent = DEEP
    monkeypatch.setattr(oc, "get_agent_by_id", agent_by_id)
    monkeypatch.setattr(oc, "fetch_output_manifest", fake.manifest)
    monkeypatch.setattr(oc, "fetch_output_files", fake.fetch)
    return fake


@pytest.fixture
def patch_session_local(monkeypatch, session_factory):
    monkeypatch.setattr(ir, "SessionLocal", session_factory)
    monkeypatch.setattr(oc, "SessionLocal", session_factory)


async def _finished(finish, *args):
    """Finish a run and wait for its background capture, as the UI would not."""
    await finish(*args)
    await oc.wait_for_pending_captures()


async def _new_run(session_factory, user, agent, conversation_id=None):
    async with session_factory() as s:
        if conversation_id is None:
            conversation = ConversationTable(user_id=user.id, agent_id=agent.id, agent_name=agent.name, title="t")
            s.add(conversation)
            await s.flush()
            conversation_id = conversation.id
        run = MessageTable(conversation_id=conversation_id, sender="ai", content="", streaming_status="running",
                           streaming_started_at=ir._now())
        s.add(run)
        await s.commit()
        return conversation_id, run.id


async def _generated(session_factory, run_id):
    async with session_factory() as s:
        rows = (await s.execute(select(AttachmentTable).where(AttachmentTable.message_id == run_id))).scalars().all()
        return {a.file_name: a for a in rows}


def _presented(path, title="Report", summary="The Q3 numbers"):
    runtime = InferenceRunRuntime()
    runtime.presented_artifacts = [{"artifact_id": "a1", "path": path, "title": title, "summary": summary}]
    return runtime


async def test_every_file_is_stored_presented_or_not(agents, patch_session_local, session_factory, seeded_user, seeded_agent):
    agents.files = {"/conversation/output/report.md": b"# Q3", "/conversation/output/scratch.csv": b"a,b"}
    _, run_id = await _new_run(session_factory, seeded_user, seeded_agent)

    await _finished(ir._mark_run_completed, run_id, _presented("/conversation/output/report.md"))

    stored = await _generated(session_factory, run_id)
    assert set(stored) == {"report.md", "scratch.csv"}
    assert stored["report.md"].title == "Report" and stored["report.md"].summary == "The Q3 numbers"
    assert stored["scratch.csv"].title is None and stored["scratch.csv"].origin == "generated"
    assert stored["scratch.csv"].content_sha256 == hashlib.sha256(b"a,b").hexdigest()


async def test_unchanged_files_are_not_stored_twice_and_changed_ones_are(
    agents, patch_session_local, session_factory, seeded_user, seeded_agent
):
    agents.files = {"/conversation/output/a.txt": b"one", "/conversation/output/b.txt": b"two"}
    conv, first = await _new_run(session_factory, seeded_user, seeded_agent)
    await _finished(ir._mark_run_completed, first, InferenceRunRuntime())

    agents.files["/conversation/output/b.txt"] = b"two, edited"
    _, second = await _new_run(session_factory, seeded_user, seeded_agent, conversation_id=conv)
    await _finished(ir._mark_run_completed, second, InferenceRunRuntime())

    assert set(await _generated(session_factory, second)) == {"b.txt"}
    assert (await _generated(session_factory, second))["b.txt"].content_sha256 == hashlib.sha256(b"two, edited").hexdigest()


async def test_a_presented_file_is_stored_even_when_unchanged(
    agents, patch_session_local, session_factory, seeded_user, seeded_agent
):
    agents.files = {"/conversation/output/report.md": b"# Q3"}
    conv, first = await _new_run(session_factory, seeded_user, seeded_agent)
    await _finished(ir._mark_run_completed, first, InferenceRunRuntime())

    _, second = await _new_run(session_factory, seeded_user, seeded_agent, conversation_id=conv)
    await _finished(ir._mark_run_completed, second, _presented("/conversation/output/report.md"))

    assert set(await _generated(session_factory, second)) == {"report.md"}


@pytest.mark.parametrize("finish", ["_mark_run_failed", "_mark_run_cancelled"])
async def test_failed_and_cancelled_runs_are_captured_too(
    agents, patch_session_local, session_factory, seeded_user, seeded_agent, finish
):
    agents.files = {"/conversation/output/partial.md": b"half"}
    _, run_id = await _new_run(session_factory, seeded_user, seeded_agent)
    if finish == "_mark_run_failed":
        await _finished(ir._mark_run_failed, run_id, InferenceRunRuntime(), "stream died")
    else:
        await _finished(ir._mark_run_cancelled, run_id, InferenceRunRuntime())
    assert set(await _generated(session_factory, run_id)) == {"partial.md"}


async def test_fetches_are_batched_and_run_caps_are_honoured(
    agents, patch_session_local, session_factory, seeded_user, seeded_agent, monkeypatch
):
    monkeypatch.setattr(settings.output_capture, "batch_files", 2)
    monkeypatch.setattr(settings.output_capture, "max_files_per_run", 3)
    agents.files = {f"/conversation/output/f{i}.txt": f"file {i}".encode() for i in range(5)}
    _, run_id = await _new_run(session_factory, seeded_user, seeded_agent)

    await _finished(ir._mark_run_completed, run_id, InferenceRunRuntime())

    assert len(await _generated(session_factory, run_id)) == 3
    assert [len(batch) for batch in agents.fetches] == [2, 1]


async def test_presented_files_are_stored_before_the_terminal_frame_and_never_twice(
    agents, patch_session_local, session_factory, seeded_user, seeded_agent
):
    agents.files = {"/conversation/output/report.md": b"# Q3", "/conversation/output/scratch.csv": b"a,b"}
    _, run_id = await _new_run(session_factory, seeded_user, seeded_agent)

    await ir._mark_run_completed(run_id, _presented("/conversation/output/report.md"))
    # The run is finished (the terminal frame goes out now): the card's file is there.
    assert set(await _generated(session_factory, run_id)) == {"report.md"}

    await oc.wait_for_pending_captures()
    async with session_factory() as s:
        names = sorted(a.file_name for a in (await s.execute(
            select(AttachmentTable).where(AttachmentTable.message_id == run_id))).scalars())
    assert names == ["report.md", "scratch.csv"]   # the presented file once, not twice


async def test_langgraph_agents_are_skipped(agents, patch_session_local, session_factory, seeded_user, seeded_agent):
    agents.agent = SimpleNamespace(type="langgraph agent", slug="hr")
    agents.files = {"/conversation/output/x.txt": b"x"}
    _, run_id = await _new_run(session_factory, seeded_user, seeded_agent)
    await _finished(ir._mark_run_completed, run_id, InferenceRunRuntime())
    assert await _generated(session_factory, run_id) == {}
    assert agents.fetches == []


async def test_failures_never_fail_the_run(agents, patch_session_local, session_factory, seeded_user, seeded_agent, monkeypatch):
    async def broken_manifest(url):
        raise httpx.ConnectError("agents down")

    monkeypatch.setattr(oc, "fetch_output_manifest", broken_manifest)
    _, run_id = await _new_run(session_factory, seeded_user, seeded_agent)
    runtime = InferenceRunRuntime()
    runtime.content = "the answer"
    await _finished(ir._mark_run_completed, run_id, runtime)

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
    await _finished(ir._mark_run_completed, run_id, InferenceRunRuntime())
    assert set(await _generated(session_factory, run_id)) == {"ok.txt"}


async def test_a_file_never_presented_stays_out_of_share_links(
    agents, patch_session_local, session_factory, seeded_user, seeded_agent
):
    """Stored so the owner never loses it — but it is the owner's alone."""
    agents.files = {"/conversation/output/report.md": b"# Q3", "/conversation/output/scratch.csv": b"a,b"}
    _, run_id = await _new_run(session_factory, seeded_user, seeded_agent)
    await _finished(ir._mark_run_completed, run_id, _presented("/conversation/output/report.md"))

    stored = await _generated(session_factory, run_id)
    assert stored["report.md"].presented is True and stored["scratch.csv"].presented is False
    assert is_shareable(stored["report.md"]) and not is_shareable(stored["scratch.csv"])


async def test_a_fork_keeps_generated_files_generated_and_shares_drop_unpresented_ones(
    agents, patch_session_local, session_factory, seeded_user, seeded_agent
):
    """The clone used to copy name, type and bytes only, so a presented file came
    back as an "upload" (in the user's file stack, its card broken)."""
    agents.files = {"/conversation/output/report.md": b"# Q3", "/conversation/output/scratch.csv": b"a,b"}
    conv_id, run_id = await _new_run(session_factory, seeded_user, seeded_agent)
    await _finished(ir._mark_run_completed, run_id, _presented("/conversation/output/report.md"))

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
