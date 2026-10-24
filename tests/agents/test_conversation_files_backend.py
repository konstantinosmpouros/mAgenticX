"""The deepagents filesystem over a conversation's files (plan 43).

The agent's file tools now read and write rows, so this pins what it sees:
the same results and error texts ``FilesystemBackend`` gave on the volume
(write-once ``write``, exact-match ``edit``, cat-style ``read`` windows,
wcmatch ``glob``, literal ``grep``), behind the same virtual paths — and the
fixes the move brings: uploads read from the bridge and read-only, one route
for ``/conversation/`` (a grep from the root sees each file once), the offload
folders out of reach of ``/conversation/``'s writes, a per-file safety cap.

Runs over the in-memory store from ``conftest``; the store's SQL is pinned in
``test_conversation_file_store.py``.
"""
from __future__ import annotations

import asyncio
import base64
import importlib
import threading

import pytest

pytestmark = pytest.mark.asyncio


class FakeInputs:
    """The bridge's view of the conversation's uploads."""

    def __init__(self, files: dict[str, bytes] | None = None, *, down: bool = False):
        self._files = files or {}
        self._down = down
        self.reads: list[str] = []

    async def files(self):
        inputs = importlib.import_module("harness.conversation_files.inputs")
        if self._down:
            raise inputs.InputsUnavailable
        return {
            name: inputs.InputFile(name, f"att-{name}", len(data), "sha", "2026-10-24T10:00:00")
            for name, data in self._files.items()
        }

    async def read(self, name):
        await self.files()
        self.reads.append(name)
        return self._files.get(name)


@pytest.fixture
def backend(conversation_files):
    """The ``/conversation/`` mount, called as ``CompositeBackend`` calls it."""
    package = importlib.import_module("harness.conversation_files")
    return package.ConversationFilesBackend(conversation_files, "/conversation")


@pytest.fixture
def composite(conversation_files, skills_fs):
    """The whole mount table of a run, as the agent's tools see it."""
    workspace = importlib.import_module("harness.filesystem.workspace")
    factory = workspace.build_workspace_backend(
        user_id="u1", agent_slug="omni", files=conversation_files, use_memory=False
    )
    return factory(None)


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("/conversation//output/a.md/", "/conversation/output/a.md"),
        ("/conversation/output/Café.md", "/conversation/output/Café.md"),
    ],
)
async def test_paths_have_one_spelling(agents_service, raw, expected):
    paths = importlib.import_module("harness.conversation_files.paths")
    assert paths.normalise(raw) == expected


@pytest.mark.parametrize(
    "raw",
    ["relative.md", "/conversation/../etc/passwd", "/conversation/./x", "/conversation/.env",
     "/conversation/a\\b", "/conversation/a\x00b", "/" + "a/" * 40 + "x"],
)
async def test_unsafe_paths_never_reach_the_table(agents_service, raw):
    paths = importlib.import_module("harness.conversation_files.paths")
    with pytest.raises(paths.InvalidPath):
        paths.normalise(raw)


# ---------------------------------------------------------------------------
# write / read / edit
# ---------------------------------------------------------------------------
async def test_a_written_file_reads_back_in_windows(backend):
    assert (await backend.awrite("/output/notes.md", "one\ntwo\nthree\n")).error is None

    whole = await backend.aread("/output/notes.md")
    window = await backend.aread("/output/notes.md", offset=1, limit=1)
    past_the_end = await backend.aread("/output/notes.md", offset=9)

    assert whole.file_data == {"content": "one\ntwo\nthree\n", "encoding": "utf-8"}
    assert window.file_data["content"] == "two\n"
    assert past_the_end.error == "Line offset 9 exceeds file length (3 lines)"


async def test_binary_files_read_back_as_base64(backend):
    png = b"\x89PNG\r\n\x1a\nbinary"
    await backend.aupload_files([("/output/chart.png", png)])

    result = await backend.aread("/output/chart.png")

    assert result.file_data["encoding"] == "base64"
    assert base64.b64decode(result.file_data["content"]) == png


async def test_an_empty_file_says_so(backend):
    await backend.awrite("/output/empty.md", "")
    assert "empty contents" in (await backend.aread("/output/empty.md")).file_data["content"]


async def test_write_never_replaces_a_file(backend):
    await backend.awrite("/output/a.md", "first")
    result = await backend.awrite("/output/a.md", "second")

    assert result.error == (
        "Cannot write to /conversation/output/a.md because it already exists. "
        "Read and then make an edit, or write to a new path."
    )
    assert (await backend.aread("/output/a.md")).file_data["content"] == "first"


async def test_a_missing_file_is_not_found(backend):
    assert (await backend.aread("/output/nope.md")).error == "File '/conversation/output/nope.md' not found"


async def test_files_and_directories_cannot_collide(backend):
    await backend.awrite("/output/report", "a file")
    await backend.awrite("/drafts/v1.md", "a draft")

    under_a_file = await backend.awrite("/output/report/part.md", "x")
    over_a_folder = await backend.awrite("/drafts", "x")

    assert "a parent of it is a file" in under_a_file.error
    assert "it is a directory" in over_a_folder.error


async def test_edit_replaces_exactly_as_the_volume_did(backend):
    await backend.awrite("/output/a.md", "alpha beta alpha\r\n")

    ambiguous = await backend.aedit("/output/a.md", "alpha", "gamma")
    missing = await backend.aedit("/output/a.md", "delta", "x")
    unique = await backend.aedit("/output/a.md", "beta", "BETA")
    every = await backend.aedit("/output/a.md", "alpha", "omega", replace_all=True)

    assert "appears 2 times" in ambiguous.error
    assert missing.error == "Error: String not found in file: 'delta'"
    assert unique.occurrences == 1 and every.occurrences == 2
    # Universal newlines, as the volume's text-mode reads gave them.
    assert (await backend.aread("/output/a.md")).file_data["content"] == "omega BETA omega\n"


async def test_editing_a_missing_file_is_not_found(backend):
    assert (await backend.aedit("/output/nope.md", "a", "b")).error == (
        "Error: File '/conversation/output/nope.md' not found"
    )


async def test_one_file_has_a_safety_cap(backend, agents_service, monkeypatch):
    monkeypatch.setattr(agents_service.settings_module.settings.conversation_files, "max_file_bytes", 10)

    too_big = await backend.awrite("/output/big.md", "x" * 11)
    await backend.awrite("/output/small.md", "x" * 10)
    grown = await backend.aedit("/output/small.md", "x", "yy", replace_all=True)

    assert "over the 10 byte limit for one file" in too_big.error
    assert "over the 10 byte limit for one file" in grown.error


# ---------------------------------------------------------------------------
# The uploads: read from the bridge, never written
# ---------------------------------------------------------------------------
async def test_uploads_are_listed_and_read_from_the_bridge(backend, conversation_files):
    conversation_files.inputs = FakeInputs({"image.png": b"png", "data.csv": b"a,b\n1,2\n"})

    listing = await backend.als("/input")
    csv = await backend.aread("/input/data.csv")

    assert [entry["path"] for entry in listing.entries] == ["/input/data.csv", "/input/image.png"]
    assert csv.file_data["content"] == "a,b\n1,2\n"


async def test_uploads_are_read_only(backend, conversation_files):
    conversation_files.inputs = FakeInputs({"data.csv": b"a"})

    write = await backend.awrite("/input/new.csv", "x")
    edit = await backend.aedit("/input/data.csv", "a", "b")
    [upload] = await backend.aupload_files([("/input/data.csv", b"b")])

    assert "uploads are read-only" in write.error and "uploads are read-only" in edit.error
    assert upload.error == "permission_denied"


async def test_an_unreachable_bridge_is_an_error_the_model_can_read(backend, conversation_files):
    conversation_files.inputs = FakeInputs(down=True)
    await backend.awrite("/output/a.md", "still here")

    assert "temporarily unavailable" in (await backend.aread("/input/data.csv")).error
    assert "temporarily unavailable" in (await backend.als("/input")).error
    # Everything else carries on.
    root = await backend.als("/")
    assert {entry["path"] for entry in root.entries} == {"/input/", "/output/"}


# ---------------------------------------------------------------------------
# ls / glob / grep
# ---------------------------------------------------------------------------
async def test_ls_lists_children_and_the_folders_that_always_exist(backend, conversation_files):
    conversation_files.inputs = FakeInputs({"image.png": b"png"})
    await backend.awrite("/output/report.md", "r")
    await backend.awrite("/output/charts/q3.png", "c")
    await backend.awrite("/notes.md", "n")

    root = await backend.als("/")
    output = await backend.als("/output")

    assert [(e["path"], e["is_dir"]) for e in root.entries] == [
        ("/input/", True), ("/notes.md", False), ("/output/", True),
    ]
    assert [(e["path"], e["is_dir"]) for e in output.entries] == [
        ("/output/charts/", True), ("/output/report.md", False),
    ]
    assert (await backend.als("/nowhere")).error == "Path '/conversation/nowhere': path_not_found"
    assert (await backend.als("/notes.md")).error == "Path '/conversation/notes.md': not_a_directory"


async def test_glob_matches_like_the_volume(backend):
    for path in ("/output/a.md", "/output/sub/b.md", "/output/c.txt"):
        await backend.awrite(path, "x")

    flat = await backend.aglob("*.md", "/output")
    deep = await backend.aglob("**/*.md", "/output")

    assert [m["path"] for m in flat.matches] == ["/output/a.md"]
    assert sorted(m["path"] for m in deep.matches) == ["/output/a.md", "/output/sub/b.md"]


async def test_grep_searches_text_files_only(backend, conversation_files):
    conversation_files.inputs = FakeInputs({"brief.txt": b"the budget is tight\n"})
    await backend.awrite("/output/plan.md", "intro\nbudget: 10k\n")
    await backend.aupload_files([("/output/chart.png", b"budget in a picture")])

    result = await backend.agrep("budget", "/")
    only_md = await backend.agrep("budget", "/", glob="*.md")

    assert sorted((m["path"], m["line"]) for m in result.matches) == [
        ("/input/brief.txt", 1), ("/output/plan.md", 2),
    ]
    assert [m["path"] for m in only_md.matches] == ["/output/plan.md"]


async def test_grep_stays_within_its_budget(backend, monkeypatch):
    module = importlib.import_module("harness.conversation_files.backend")
    monkeypatch.setattr(module, "GREP_MAX_FILES", 2)
    for name in ("a", "b", "c"):
        await backend.awrite(f"/output/{name}.md", "needle")

    result = await backend.agrep("needle", "/")

    assert len(result.matches) == 2 and result.error is None


async def test_downloads_and_uploads_round_trip(backend):
    [uploaded] = await backend.aupload_files([("/output/data.bin", b"\x00\x01")])
    await backend.aupload_files([("/output/data.bin", b"\x02")])  # an upload replaces
    found, missing = await backend.adownload_files(["/output/data.bin", "/output/nope"])

    assert uploaded.error is None
    assert found.content == b"\x02" and missing.error == "file_not_found"


# ---------------------------------------------------------------------------
# The mount table
# ---------------------------------------------------------------------------
async def test_offloads_live_in_their_own_folders(composite, memory_file_store):
    await composite.awrite("/large_tool_results/call-1", "a huge tool result")
    await composite.awrite("/conversation/large_tool_results/sneaky", "not an offload")

    stored = {path for _, path in memory_file_store.rows}
    assert stored == {"/large_tool_results/call-1", "/conversation/large_tool_results/sneaky"}
    assert (await composite.aread("/large_tool_results/call-1")).file_data["content"] == "a huge tool result"


async def test_a_grep_over_the_conversation_sees_each_file_once(composite, conversation_files):
    """One route for the whole of ``/conversation/`` — uploads included — where
    three overlapping routes used to report input/output matches twice."""
    conversation_files.inputs = FakeInputs({"brief.txt": b"needle\n"})
    await composite.awrite("/conversation/output/a.md", "needle")

    result = await composite.agrep("needle", "/conversation")

    assert sorted(m["path"] for m in result.matches) == ["/conversation/input/brief.txt", "/conversation/output/a.md"]


async def test_every_agent_of_the_conversation_sees_the_same_files(conversation_files, memory_file_store):
    package = importlib.import_module("harness.conversation_files")
    other_agent = package.ConversationFiles(user_id="u1", conversation_id="c1", agent_slug="nova",
                                            store=memory_file_store)
    await package.ConversationFilesBackend(conversation_files, "/conversation").awrite("/output/a.md", "omni's")

    read = await package.ConversationFilesBackend(other_agent, "/conversation").aread("/output/a.md")

    assert read.file_data["content"] == "omni's"


async def test_the_sync_methods_run_on_the_service_loop(conversation_files):
    package = importlib.import_module("harness.conversation_files")
    backend = package.ConversationFilesBackend(conversation_files, "/conversation", loop=asyncio.get_running_loop())
    await backend.awrite("/output/a.md", "from the loop")

    result = await asyncio.to_thread(backend.read, "/output/a.md")

    assert result.file_data["content"] == "from the loop"
    with pytest.raises(RuntimeError, match="event loop"):
        backend.read("/output/a.md")  # on the loop thread it would deadlock
    assert threading.current_thread() is threading.main_thread()


# ---------------------------------------------------------------------------
# The tools that read files directly
# ---------------------------------------------------------------------------
async def test_present_artifact_needs_a_written_output_file(conversation_files, backend):
    tool_module = importlib.import_module("harness.tools.present_artifact.tool")
    tool = tool_module.build_present_artifact_tool(files=conversation_files)
    await backend.awrite("/output/report.md", "# Q3")

    presented = await tool.ainvoke({"path": "/conversation/output/report.md", "title": "Q3"})
    not_written = await tool.ainvoke({"path": "/conversation/output/nope.md", "title": "Q3"})
    an_upload = await tool.ainvoke({"path": "/conversation/input/brief.txt", "title": "Q3"})

    assert "is now a document card" in presented
    assert "no file at" in not_written
    assert "must be under /conversation/output/" in an_upload
