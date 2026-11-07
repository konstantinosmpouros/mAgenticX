"""The workspace default backend over the branch scratch store (plan 41 §3.7).

A path outside every mounted route (``/notes.md``, ``/drafts/v2.md``) lands on
the ``CompositeBackend``'s default. That used to be deepagents'
``StateBackend``: the ``files`` key of one thread's graph state, invisible to
an async sub-agent running on its own thread. This backend keeps the same
answers — same paths, same result shapes, same error strings — but reads and
writes :class:`~harness.filesystem.scratch_store.BranchScratchStore` rows keyed
by the run's **branch thread**, so the orchestrator and every task of its tree
share one filesystem, live.

**Which branch.** :func:`resolve_branch_thread_id` is the one rule: the run
context's ``branch_thread_id`` when present (the async-task runner sets it to
the orchestrator's branch for task runs), else the run's own ``thread_id``
(top-level runs). The workspace binds it at build time when the agent passes
it; otherwise it is resolved per call from the live LangGraph config, which a
sub-agent invoked inside the run inherits.

**Concurrency.** ``write_file`` is last-write-wins. ``edit_file`` is
optimistic: the version (content hash) this backend last saw for the file —
from a read, a write or an edit — must still be current, and the replacement
is stored with a compare-and-set on the version it was computed from. When
another agent changed the file in between, the edit fails with a message
telling the agent to read the file again; nothing is overwritten.

**Still a** ``StateBackend``. A run with no thread at all (no checkpointer, so
no branch to key on) falls back to the old in-state behaviour, unchanged. The
subclass is also what keeps deepagents declaring the ``files`` channel, which
the one-shot import (:mod:`harness.filesystem.scratch_migration`) and forks
of not-yet-imported branches still read.

**Never logged:** file contents or paths (paths can carry user data) — only
counts, sizes and the kind of failure.
"""
from __future__ import annotations

import asyncio
import base64
import re
from collections.abc import Coroutine, Mapping
from typing import Any, TypeVar

import psycopg
from deepagents.backends import StateBackend
from deepagents.backends.protocol import (
    ASYNC_GREP_TIMEOUT,
    FILE_NOT_FOUND,
    INVALID_PATH,
    PERMISSION_DENIED,
    DeleteResult,
    EditResult,
    FileData,
    FileDownloadResponse,
    FileInfo,
    FileUploadResponse,
    GlobResult,
    GrepResult,
    LsResult,
    ReadResult,
    WriteResult,
)
from deepagents.backends.utils import (
    InvalidGlobPatternError,
    _get_backend_read_file_type,
    _glob_search_files,
    grep_matches_from_files,
    perform_string_replacement,
    slice_read_response,
)
from langgraph.config import get_config
from langgraph.runtime import get_runtime

from core.logging import get_logger
from harness.conversation_files import paths
from harness.conversation_files.backend import (
    GREP_MAX_FILE_BYTES,
    GREP_MAX_FILES,
    GREP_MAX_TOTAL_BYTES,
)
from harness.conversation_files.paths import InvalidPath
from harness.filesystem import scratch_migration
from harness.filesystem.scratch_store import (
    BranchScratchStore,
    Encoding,
    ScratchEntry,
    ScratchFile,
    ScratchFileTooLarge,
    ScratchScope,
)

logger = get_logger(__name__)

_T = TypeVar("_T")

#: A branch thread id becomes a key in every statement. The bridge mints UUIDs;
#: anything else that looks odd is refused rather than queried.
_BRANCH_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")

#: The database errors a scratch call reports to the model instead of raising.
_STORE_ERRORS: tuple[type[BaseException], ...] = (psycopg.Error,)

UNAVAILABLE = "Error: the working files are unavailable right now. Try again in a moment."


def resolve_branch_thread_id(context: Mapping[str, Any] | None, run_config: Mapping[str, Any] | None) -> str | None:
    """The branch thread a run's scratch files belong to, or None for a thread-less run.

    ``context["branch_thread_id"]`` wins — an async task runs on its own
    thread but shares its root's branch. Otherwise the run's own
    ``run_config["configurable"]["thread_id"]``: a top-level run *is* on its
    branch thread.
    """
    if isinstance(context, Mapping):
        branch = context.get("branch_thread_id")
        if isinstance(branch, str) and branch.strip():
            return branch.strip()
    configurable = run_config.get("configurable") if isinstance(run_config, Mapping) else None
    thread_id = configurable.get("thread_id") if isinstance(configurable, Mapping) else None
    if isinstance(thread_id, str) and thread_id.strip():
        return thread_id.strip()
    return None


def current_branch_thread_id() -> str | None:
    """:func:`resolve_branch_thread_id` against the live LangGraph run, or None outside one."""
    try:
        config = get_config()
    except RuntimeError:
        return None
    runtime = get_runtime()
    context = getattr(runtime, "context", None) if runtime is not None else None
    return resolve_branch_thread_id(context if isinstance(context, Mapping) else None, config)


def checked_branch_thread_id(value: str) -> str:
    """``value`` if it is a well-formed thread id; ``ValueError`` otherwise."""
    if not isinstance(value, str) or not _BRANCH_RE.match(value):
        raise ValueError("Invalid branch thread id.")
    return value


def _iso(entry: ScratchEntry) -> tuple[str, str]:
    return entry.created_at.isoformat(), entry.updated_at.isoformat()


def _file_data(file: ScratchFile) -> FileData:
    """A stored file as deepagents' ``FileData`` — what ``StateBackend`` kept in state."""
    created, modified = _iso(file.entry)
    if file.entry.encoding == "base64":
        content = base64.standard_b64encode(file.data).decode("ascii")
    else:
        content = file.data.decode("utf-8", errors="replace")
    return FileData(content=content, encoding=file.entry.encoding, created_at=created, modified_at=modified)


def _encoding_of(data: bytes) -> Encoding:
    """Text when the bytes are UTF-8, binary otherwise — ``StateBackend.upload_files``' rule."""
    try:
        data.decode("utf-8")
    except UnicodeDecodeError:
        return "base64"
    return "utf-8"


def _within_grep_budget(candidates: list[ScratchEntry]) -> tuple[list[ScratchEntry], bool]:
    chosen: list[ScratchEntry] = []
    total = 0
    for entry in candidates:
        if len(chosen) >= GREP_MAX_FILES or total + entry.size > GREP_MAX_TOTAL_BYTES:
            return chosen, True
        chosen.append(entry)
        total += entry.size
    return chosen, False


def _changed_message(path: str) -> str:
    return (
        f"Error: '{path}' was changed by another agent since you last read it, so the edit was not "
        "applied. Read the file again, then redo the edit on its current content."
    )


class BranchScratchBackend(StateBackend):
    """The default route of one run's workspace, over the branch scratch store.

    Bound at build time to the run's ``(user_id, conversation_id)`` — the same
    identity its ``/conversation/`` mount uses — and, when the caller knows it,
    to the branch thread. Minting it does no I/O.
    """

    def __init__(
        self,
        *,
        store: BranchScratchStore,
        user_id: str,
        conversation_id: str,
        agent_slug: str,
        branch_thread_id: str | None = None,
        loop: asyncio.AbstractEventLoop | None = None,
    ) -> None:
        super().__init__()
        self._store = store
        self._user_id = user_id
        self._conversation_id = conversation_id
        self._agent_slug = agent_slug
        self._branch = checked_branch_thread_id(branch_thread_id) if branch_thread_id else None
        # For the sync bridge only; the async methods never need it.
        self._loop = loop
        # The version this backend last saw per (branch, path) — what an edit
        # must still find to apply.
        self._seen: dict[tuple[str, str], str] = {}
        # Branches whose table setup + one-shot import already ran here.
        self._prepared: set[str] = set()

    # -- scope -------------------------------------------------------------------
    def _scope(self) -> ScratchScope | None:
        """The branch this call works on, or None for a thread-less run.

        An ill-formed id from the live config raises — a scratch call fails
        rather than reading under a key nobody minted.
        """
        branch = self._branch or current_branch_thread_id()
        if branch is None:
            return None
        return ScratchScope(self._user_id, self._conversation_id, checked_branch_thread_id(branch))

    async def _ready_branch(self, scope: ScratchScope) -> None:
        """Make sure the table exists and the branch's legacy files are imported."""
        if scope.branch_thread_id in self._prepared:
            return
        await self._store.ensure_setup()
        try:
            await scratch_migration.import_legacy_scratch(self._store, scope, agent_slug=self._agent_slug)
        except scratch_migration.IMPORT_ERRORS as exc:
            # The branch still works on whatever the store has; the import is
            # retried on the next build, since the marker was not written.
            logger.warning(
                "branch_scratch_legacy_import_failed",
                "Could not import a branch's checkpoint scratch files; continuing without them",
                conversation_id=self._conversation_id,
                error_type=type(exc).__name__,
            )
        self._prepared.add(scope.branch_thread_id)

    def _unavailable(self, operation: str, exc: Exception) -> None:
        logger.warning(
            "branch_scratch_unavailable",
            "A scratch-file operation failed against the store",
            conversation_id=self._conversation_id,
            operation=operation,
            error_type=type(exc).__name__,
        )

    @staticmethod
    def _path(file_path: str) -> str:
        return paths.normalise(file_path)

    # -- ls ------------------------------------------------------------------
    async def als(self, path: str) -> LsResult:
        scope = self._scope()
        return super().ls(path) if scope is None else await self._ls(scope, path)

    async def _ls(self, scope: ScratchScope, path: str) -> LsResult:
        try:
            directory = self._path(path)
        except InvalidPath as exc:
            return LsResult(error=f"Cannot list '{path}': {exc}")
        try:
            await self._ready_branch(scope)
            entries = await self._store.list_files(scope, directory)
        except _STORE_ERRORS as exc:
            self._unavailable("ls", exc)
            return LsResult(error=UNAVAILABLE)
        prefix = directory if directory.endswith("/") else directory + "/"
        infos: list[FileInfo] = []
        subdirs: set[str] = set()
        for entry in entries:
            if not entry.path.startswith(prefix):
                continue  # the directory itself is a file: StateBackend lists nothing
            head, nested, _ = entry.path[len(prefix):].partition("/")
            if nested:
                subdirs.add(prefix + head + "/")
                continue
            infos.append(FileInfo(path=entry.path, is_dir=False, size=entry.size,
                                  modified_at=entry.updated_at.isoformat()))
        infos.extend(FileInfo(path=sub, is_dir=True, size=0, modified_at="") for sub in sorted(subdirs))
        infos.sort(key=lambda info: info.get("path", ""))
        return LsResult(entries=infos)

    # -- read ----------------------------------------------------------------
    async def aread(self, file_path: str, offset: int = 0, limit: int = 2000) -> ReadResult:
        scope = self._scope()
        return super().read(file_path, offset, limit) if scope is None else await self._read(scope, file_path, offset, limit)

    async def _read(self, scope: ScratchScope, file_path: str, offset: int, limit: int) -> ReadResult:
        try:
            path = self._path(file_path)
        except InvalidPath as exc:
            return ReadResult(error=f"Error reading file '{file_path}': {exc}")
        try:
            await self._ready_branch(scope)
            file = await self._store.get(scope, path)
        except _STORE_ERRORS as exc:
            self._unavailable("read", exc)
            return ReadResult(error=UNAVAILABLE)
        if file is None:
            return ReadResult(error=f"File '{file_path}' not found")
        self._seen[(scope.branch_thread_id, path)] = file.entry.sha256
        file_data = _file_data(file)
        if _get_backend_read_file_type(path) != "text":
            return ReadResult(file_data=file_data)
        return slice_read_response(file_data, offset, limit)

    # -- write / edit ---------------------------------------------------------
    async def awrite(self, file_path: str, content: str) -> WriteResult:
        scope = self._scope()
        return super().write(file_path, content) if scope is None else await self._write(scope, file_path, content)

    async def _write(self, scope: ScratchScope, file_path: str, content: str) -> WriteResult:
        try:
            path = self._path(file_path)
        except InvalidPath as exc:
            return WriteResult(error=f"Error writing file '{file_path}': {exc}")
        data = content.encode("utf-8")
        try:
            await self._ready_branch(scope)
            version = await self._store.put(scope, path, data, encoding="utf-8", agent_slug=self._agent_slug)
        except ScratchFileTooLarge as exc:
            return WriteResult(error=f"Error writing file '{file_path}': {exc}")
        except _STORE_ERRORS as exc:
            self._unavailable("write", exc)
            return WriteResult(error=UNAVAILABLE)
        if version is None:
            return WriteResult(error=f"Error writing file '{file_path}': permission denied.")
        self._seen[(scope.branch_thread_id, path)] = version
        return WriteResult(path=file_path)

    async def aedit(
        self, file_path: str, old_string: str, new_string: str, replace_all: bool = False
    ) -> EditResult:
        scope = self._scope()
        if scope is None:
            return super().edit(file_path, old_string, new_string, replace_all)
        return await self._edit(scope, file_path, old_string, new_string, replace_all)

    async def _edit(
        self, scope: ScratchScope, file_path: str, old_string: str, new_string: str, replace_all: bool
    ) -> EditResult:
        try:
            path = self._path(file_path)
        except InvalidPath as exc:
            return EditResult(error=f"Error editing file '{file_path}': {exc}")
        key = (scope.branch_thread_id, path)
        try:
            await self._ready_branch(scope)
            current = await self._store.get(scope, path)
            if current is None:
                return EditResult(error=f"Error: File '{file_path}' not found")
            seen = self._seen.get(key)
            if seen is not None and seen != current.entry.sha256:
                # Read (or written) here, changed elsewhere since: the agent's
                # old_string came from a version that is gone.
                self._log_conflict()
                return EditResult(error=_changed_message(file_path))
            if current.entry.encoding == "base64":
                return EditResult(error="Error: Cannot edit binary files with text replacements.")
            result = perform_string_replacement(
                current.data.decode("utf-8", errors="replace"), old_string, new_string, replace_all
            )
            if isinstance(result, str):
                return EditResult(error=result)
            new_content, occurrences = result
            version = await self._store.compare_and_set(
                scope, path, current.entry.sha256, new_content.encode("utf-8"),
                encoding="utf-8", agent_slug=self._agent_slug,
            )
        except ScratchFileTooLarge as exc:
            return EditResult(error=f"Error editing file '{file_path}': {exc}")
        except _STORE_ERRORS as exc:
            self._unavailable("edit", exc)
            return EditResult(error=UNAVAILABLE)
        if version is None:
            # Another writer landed between our read and our compare-and-set.
            self._seen.pop(key, None)
            self._log_conflict()
            return EditResult(error=_changed_message(file_path))
        self._seen[key] = version
        return EditResult(path=file_path, occurrences=int(occurrences))

    def _log_conflict(self) -> None:
        logger.info(
            "branch_scratch_edit_conflict",
            "Refused an edit to a scratch file another agent changed meanwhile",
            conversation_id=self._conversation_id,
        )

    # -- glob / grep -----------------------------------------------------------
    async def aglob(self, pattern: str, path: str | None = None) -> GlobResult:
        scope = self._scope()
        return super().glob(pattern, path) if scope is None else await self._glob(scope, pattern, path)

    async def _glob(self, scope: ScratchScope, pattern: str, path: str | None) -> GlobResult:
        try:
            base = self._path(path or "/")
        except InvalidPath:
            return GlobResult(matches=[])
        try:
            await self._ready_branch(scope)
            entries = await self._store.list_files(scope, base)
        except _STORE_ERRORS as exc:
            self._unavailable("glob", exc)
            return GlobResult(error=UNAVAILABLE)
        by_path = {entry.path: entry for entry in entries}
        try:
            listing = _glob_search_files(
                {p: {"content": "", "modified_at": e.updated_at.isoformat()} for p, e in by_path.items()},
                pattern,
                path,
            )
        except InvalidGlobPatternError as exc:
            return GlobResult(error=str(exc))
        if listing == "No files found":
            return GlobResult(matches=[])
        return GlobResult(matches=[
            FileInfo(path=p, is_dir=False, size=by_path[p].size if p in by_path else 0,
                     modified_at=by_path[p].updated_at.isoformat() if p in by_path else "")
            for p in listing.split("\n")
        ])

    async def agrep(
        self, pattern: str, path: str | None = None, glob: str | None = None, *, max_count: int | None = None
    ) -> GrepResult:
        scope = self._scope()
        if scope is None:
            return super().grep(pattern, path, glob, max_count=max_count)
        try:
            async with asyncio.timeout(ASYNC_GREP_TIMEOUT):
                return await self._grep(scope, pattern, path, glob, max_count)
        except TimeoutError:
            return GrepResult(error=(
                f"Error: grep timed out after {ASYNC_GREP_TIMEOUT}s. "
                "Try a more specific pattern or a narrower path."
            ))

    async def _grep(
        self, scope: ScratchScope, pattern: str, path: str | None, glob: str | None, max_count: int | None
    ) -> GrepResult:
        try:
            base = self._path(path or "/")
        except InvalidPath:
            return GrepResult(matches=[])
        try:
            await self._ready_branch(scope)
            entries = await self._store.list_files(scope, base)
            candidates = [e for e in entries if e.encoding == "utf-8" and e.size <= GREP_MAX_FILE_BYTES]
            searched, truncated = _within_grep_budget(candidates)
            files = await self._store.read_many(scope, [entry.path for entry in searched])
        except _STORE_ERRORS as exc:
            self._unavailable("grep", exc)
            return GrepResult(error=UNAVAILABLE)
        if truncated:
            logger.info("branch_scratch_grep_truncated", "Searched only part of the scratch files",
                        files_scanned=len(searched), files_matching_filters=len(candidates))
        return grep_matches_from_files(
            {p: _file_data(f) for p, f in files.items()}, pattern, path or "/", glob, max_count=max_count
        )

    # -- upload / download -----------------------------------------------------
    async def aupload_files(self, files: list[tuple[str, bytes]]) -> list[FileUploadResponse]:
        scope = self._scope()
        return super().upload_files(files) if scope is None else await self._upload(scope, files)

    async def _upload(self, scope: ScratchScope, files: list[tuple[str, bytes]]) -> list[FileUploadResponse]:
        responses: list[FileUploadResponse] = []
        try:
            await self._ready_branch(scope)
            for file_path, content in files:
                try:
                    path = self._path(file_path)
                    version = await self._store.put(
                        scope, path, content, encoding=_encoding_of(content), agent_slug=self._agent_slug
                    )
                except (InvalidPath, ScratchFileTooLarge):
                    responses.append(FileUploadResponse(path=file_path, error=INVALID_PATH))
                    continue
                if version is not None:
                    self._seen[(scope.branch_thread_id, path)] = version
                responses.append(FileUploadResponse(path=file_path, error=None if version else PERMISSION_DENIED))
        except _STORE_ERRORS as exc:
            self._unavailable("upload", exc)
            done = len(responses)
            responses.extend(FileUploadResponse(path=p, error=UNAVAILABLE) for p, _ in files[done:])
        return responses

    async def adownload_files(self, paths_: list[str]) -> list[FileDownloadResponse]:
        scope = self._scope()
        return super().download_files(paths_) if scope is None else await self._download(scope, paths_)

    async def _download(self, scope: ScratchScope, paths_: list[str]) -> list[FileDownloadResponse]:
        normalised: dict[str, str] = {}
        for file_path in paths_:
            try:
                normalised[file_path] = self._path(file_path)
            except InvalidPath:
                continue
        try:
            await self._ready_branch(scope)
            found = await self._store.read_many(scope, sorted(set(normalised.values())))
        except _STORE_ERRORS as exc:
            self._unavailable("download", exc)
            return [FileDownloadResponse(path=p, error=UNAVAILABLE) for p in paths_]
        responses: list[FileDownloadResponse] = []
        for file_path in paths_:
            path = normalised.get(file_path)
            if path is None:
                responses.append(FileDownloadResponse(path=file_path, error=INVALID_PATH))
                continue
            file = found.get(path)
            if file is None:
                responses.append(FileDownloadResponse(path=file_path, error=FILE_NOT_FOUND))
                continue
            self._seen[(scope.branch_thread_id, path)] = file.entry.sha256
            responses.append(FileDownloadResponse(path=file_path, content=file.data, error=None))
        return responses

    # -- delete: not offered -------------------------------------------------------
    async def adelete(self, file_path: str) -> DeleteResult:
        return self.delete(file_path)

    def delete(self, file_path: str) -> DeleteResult:
        """Refused on the shared store: no ``delete`` tool is offered (see
        :mod:`harness.filesystem.middleware`), and one agent must not remove
        files the rest of its tree is working on."""
        if self._branch is None and current_branch_thread_id() is None:
            return super().delete(file_path)
        return DeleteResult(error="Error: deleting files is not supported here.")

    # -- the sync surface ----------------------------------------------------------
    def _sync(self, coro: Coroutine[Any, Any, _T]) -> _T:
        """Run an async method from a worker thread on the service loop.

        The scope is resolved by the caller *before* this hop: the loop thread
        does not carry the worker's LangGraph context. Refused on the loop
        thread itself, where waiting would deadlock.
        """
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            pass
        else:
            coro.close()
            raise RuntimeError("BranchScratchBackend sync method called on the event loop; use the async one.")
        if self._loop is None or not self._loop.is_running():
            coro.close()
            raise RuntimeError("BranchScratchBackend needs the service event loop; none is running.")
        return asyncio.run_coroutine_threadsafe(coro, self._loop).result()

    def ls(self, path: str) -> LsResult:
        scope = self._scope()
        return super().ls(path) if scope is None else self._sync(self._ls(scope, path))

    def read(self, file_path: str, offset: int = 0, limit: int = 2000) -> ReadResult:
        scope = self._scope()
        if scope is None:
            return super().read(file_path, offset, limit)
        return self._sync(self._read(scope, file_path, offset, limit))

    def write(self, file_path: str, content: str) -> WriteResult:
        scope = self._scope()
        return super().write(file_path, content) if scope is None else self._sync(self._write(scope, file_path, content))

    def edit(
        self, file_path: str, old_string: str, new_string: str, replace_all: bool = False
    ) -> EditResult:
        scope = self._scope()
        if scope is None:
            return super().edit(file_path, old_string, new_string, replace_all)
        return self._sync(self._edit(scope, file_path, old_string, new_string, replace_all))

    def glob(self, pattern: str, path: str | None = None) -> GlobResult:
        scope = self._scope()
        return super().glob(pattern, path) if scope is None else self._sync(self._glob(scope, pattern, path))

    def grep(
        self, pattern: str, path: str | None = None, glob: str | None = None, *, max_count: int | None = None
    ) -> GrepResult:
        scope = self._scope()
        if scope is None:
            return super().grep(pattern, path, glob, max_count=max_count)
        return self._sync(self._grep(scope, pattern, path, glob, max_count))

    def upload_files(self, files: list[tuple[str, bytes]]) -> list[FileUploadResponse]:
        scope = self._scope()
        return super().upload_files(files) if scope is None else self._sync(self._upload(scope, files))

    def download_files(self, paths: list[str]) -> list[FileDownloadResponse]:
        scope = self._scope()
        return super().download_files(paths) if scope is None else self._sync(self._download(scope, paths))


__all__ = [
    "UNAVAILABLE",
    "BranchScratchBackend",
    "checked_branch_thread_id",
    "current_branch_thread_id",
    "resolve_branch_thread_id",
]
