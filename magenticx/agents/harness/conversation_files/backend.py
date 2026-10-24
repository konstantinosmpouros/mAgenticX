"""The deepagents filesystem over a conversation's files.

A ``BackendProtocol`` rather than deepagents' ``StoreBackend``: the store
backend pages *every value* of a namespace into memory for ``ls``, ``glob`` and
``grep``, which with files of tens of megabytes is not an option. Here listing
and globbing read metadata only, and ``grep`` fetches just the text files it
will search, within a fixed budget.

One class serves three mounts, each rooted at its own prefix:

    /conversation/           the conversation's files (+ the uploads, read-only)
    /large_tool_results/     tool results deepagents offloaded from the context
    /conversation_history/   message history the summariser offloaded

``CompositeBackend`` strips the mount prefix before calling in, so every method
first joins it back (:func:`paths.join`) — the table and every message the
model sees use the full virtual path.

Results and error strings follow ``FilesystemBackend``, the backend these mounts
used before, so the middleware and the model see the same behaviour. The
async methods are the real implementation (the middleware calls those); the
sync ones bridge onto the service loop, as ``AgentMemoryStore.batch`` does.
"""
from __future__ import annotations

import asyncio
import base64
from collections.abc import Coroutine
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Any, TypeVar

import wcmatch.glob as wcglob
from deepagents.backends.protocol import (
    ASYNC_GREP_TIMEOUT,
    FILE_NOT_FOUND,
    INVALID_PATH,
    IS_DIRECTORY,
    PERMISSION_DENIED,
    BackendProtocol,
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
    _get_file_type,
    _glob_search_files,
    check_empty_content,
    grep_matches_from_files,
    perform_string_replacement,
)

from core.logging import get_logger
from core.settings import settings
from harness.conversation_files import paths
from harness.conversation_files.files import ConversationFiles, Entry
from harness.conversation_files.inputs import UNAVAILABLE_MESSAGE, InputsUnavailable
from harness.conversation_files.paths import InvalidPath
from harness.conversation_files.store import WriteOutcome

logger = get_logger(__name__)

#: A grep reads and decrypts every file it searches, so it is bounded: text
#: files up to the size ``FilesystemBackend`` searched, and at most this many
#: files / bytes per call. Past the budget the matches found so far are
#: returned and the truncation is logged.
GREP_MAX_FILE_BYTES = 10 * 1024 * 1024
GREP_MAX_FILES = 200
GREP_MAX_TOTAL_BYTES = 64 * 1024 * 1024

_T = TypeVar("_T")


def _lf(text: str) -> str:
    """Universal newlines, as ``FilesystemBackend``'s text-mode reads applied them."""
    return text.replace("\r\n", "\n").replace("\r", "\n")


def _text(data: bytes) -> str:
    return _lf(data.decode("utf-8"))


def _read_result(path: str, data: bytes, offset: int, limit: int) -> ReadResult:
    if _get_file_type(path) != "text":
        return ReadResult(
            file_data=FileData(content=base64.standard_b64encode(data).decode("ascii"), encoding="base64")
        )
    try:
        content = _text(data)
    except UnicodeDecodeError as exc:
        return ReadResult(error=f"Error reading file '{path}': {exc}")
    empty = check_empty_content(content)
    if empty:
        return ReadResult(file_data=FileData(content=empty, encoding="utf-8"))
    lines = content.splitlines(keepends=True)
    if offset >= len(lines):
        return ReadResult(error=f"Line offset {offset} exceeds file length ({len(lines)} lines)")
    return ReadResult(file_data=FileData(content="".join(lines[offset:offset + limit]), encoding="utf-8"))


def _within_grep_budget(candidates: list[Entry]) -> tuple[list[Entry], bool]:
    chosen: list[Entry] = []
    total = 0
    for entry in candidates:
        if len(chosen) >= GREP_MAX_FILES or total + entry.size > GREP_MAX_TOTAL_BYTES:
            return chosen, True
        chosen.append(entry)
        total += entry.size
    return chosen, False


@dataclass
class _EditOutcome:
    """What the edit transform decided, read back once the row lock is released."""

    error: str | None = None
    occurrences: int = 0


class ConversationFilesBackend(BackendProtocol):
    """One mount (``root``) of one run's conversation files."""

    def __init__(
        self, files: ConversationFiles, root: str, *, loop: asyncio.AbstractEventLoop | None = None
    ) -> None:
        self._files = files
        self._root = root
        # For the sync bridge below; the async methods never need it.
        self._loop = loop

    # -- path helpers --------------------------------------------------------
    def _path(self, backend_path: str) -> str:
        return paths.join(self._root, backend_path)

    def _relative(self, path: str) -> str:
        return paths.relative(self._root, path)

    def _structural_dirs(self) -> set[str]:
        """Directories that exist even when empty, as they did on the volume."""
        if self._root == paths.CONVERSATION_ROOT:
            return {self._root, paths.INPUT_DIR, paths.OUTPUT_DIR}
        return {self._root}

    def _write_refusal(self, path: str, size: int) -> tuple[str, str] | None:
        """``(reason, message)`` when ``path`` cannot take ``size`` bytes."""
        if paths.is_input(path):
            return "read_only", (
                f"Error writing file '{path}': the user's uploads are read-only. "
                f"Write to '{paths.OUTPUT_PREFIX}' instead."
            )
        if not paths.is_storable(path):
            return "path", f"Error writing file '{path}': it is a directory."
        cap = settings.conversation_files.max_file_bytes
        if size > cap:
            return "file_cap", (
                f"Error writing file '{path}': {size} bytes is over the {cap} byte limit for one file."
            )
        return None

    @staticmethod
    def _outcome_message(path: str, outcome: WriteOutcome) -> str:
        if outcome == "exists":
            return (
                f"Cannot write to {path} because it already exists. "
                "Read and then make an edit, or write to a new path."
            )
        if outcome == "is_directory":
            return f"Error writing file '{path}': it is a directory."
        return f"Error writing file '{path}': a parent of it is a file."

    @staticmethod
    def _log_refused(path: str, reason: str) -> None:
        logger.info("conversation_file_write_refused", "Refused a write to the conversation's files",
                    kind=paths.kind(path), reason=reason)

    # -- ls ------------------------------------------------------------------
    async def als(self, path: str) -> LsResult:
        try:
            directory = self._path(path)
            entries = await self._files.entries(directory)
        except InvalidPath as exc:
            return LsResult(error=f"Cannot list '{path}': {exc}")
        except InputsUnavailable:
            return LsResult(error=UNAVAILABLE_MESSAGE)
        if any(entry.path == directory for entry in entries):
            return LsResult(error=f"Path '{directory}': not_a_directory")
        if not entries and directory not in self._structural_dirs():
            return LsResult(error=f"Path '{directory}': path_not_found")
        return LsResult(entries=self._children(directory, entries))

    def _children(self, directory: str, entries: list[Entry]) -> list[FileInfo]:
        prefix = directory.rstrip("/") + "/"
        files: list[FileInfo] = []
        subdirs = {
            sub for sub in self._structural_dirs() if sub.startswith(prefix) and "/" not in sub[len(prefix):]
        }
        for entry in entries:
            head, nested, _ = entry.path[len(prefix):].partition("/")
            if nested:
                subdirs.add(prefix + head)
            else:
                files.append(FileInfo(path=self._relative(entry.path), is_dir=False,
                                      size=entry.size, modified_at=entry.modified_at))
        dirs = [FileInfo(path=self._relative(sub) + "/", is_dir=True, size=0, modified_at="")
                for sub in subdirs]
        return sorted(files + dirs, key=lambda info: info["path"])

    # -- read ----------------------------------------------------------------
    async def aread(self, file_path: str, offset: int = 0, limit: int = 2000) -> ReadResult:
        try:
            path = self._path(file_path)
            data = await self._files.read_bytes(path)
        except InvalidPath as exc:
            return ReadResult(error=f"Error reading file '{file_path}': {exc}")
        except InputsUnavailable:
            return ReadResult(error=UNAVAILABLE_MESSAGE)
        if data is None:
            return ReadResult(error=f"File '{path}' not found")
        return _read_result(path, data, offset, limit)

    # -- write / edit ---------------------------------------------------------
    async def awrite(self, file_path: str, content: str) -> WriteResult:
        try:
            path = self._path(file_path)
        except InvalidPath as exc:
            return WriteResult(error=f"Error writing file '{file_path}': {exc}")
        data = content.encode("utf-8")
        refusal = self._write_refusal(path, len(data))
        if refusal is not None:
            self._log_refused(path, refusal[0])
            return WriteResult(error=refusal[1])
        outcome = await self._files.create(path, data)
        if outcome != "ok":
            self._log_refused(path, outcome)
            return WriteResult(error=self._outcome_message(path, outcome))
        logger.debug("conversation_file_written", "Wrote a conversation file",
                     kind=paths.kind(path), bytes=len(data))
        return WriteResult(path=file_path)

    async def aedit(
        self, file_path: str, old_string: str, new_string: str, replace_all: bool = False
    ) -> EditResult:
        try:
            path = self._path(file_path)
        except InvalidPath as exc:
            return EditResult(error=f"Error editing file '{file_path}': {exc}")
        refusal = self._write_refusal(path, 0)
        if refusal is not None:
            self._log_refused(path, refusal[0])
            return EditResult(error=refusal[1])

        outcome = _EditOutcome()
        cap = settings.conversation_files.max_file_bytes

        def transform(raw: bytes) -> bytes | None:
            try:
                content = _text(raw)
            except UnicodeDecodeError as exc:
                outcome.error = f"Error editing file '{path}': {exc}"
                return None
            result = perform_string_replacement(content, _lf(old_string), _lf(new_string), replace_all)
            if isinstance(result, str):
                outcome.error = result
                return None
            updated = result[0].encode("utf-8")
            if len(updated) > cap:
                outcome.error = (
                    f"Error editing file '{path}': the result, {len(updated)} bytes, "
                    f"is over the {cap} byte limit for one file."
                )
                return None
            outcome.occurrences = result[1]
            return updated

        if not await self._files.edit(path, transform):
            return EditResult(error=f"Error: File '{path}' not found")
        if outcome.error is not None:
            return EditResult(error=outcome.error)
        logger.debug("conversation_file_edited", "Edited a conversation file", kind=paths.kind(path))
        return EditResult(path=file_path, occurrences=outcome.occurrences)

    # -- glob / grep -----------------------------------------------------------
    async def aglob(self, pattern: str, path: str | None = None) -> GlobResult:
        base = path or "/"
        try:
            entries = await self._files.entries(self._path(base))
        except InvalidPath:
            return GlobResult(matches=[])
        except InputsUnavailable:
            return GlobResult(error=UNAVAILABLE_MESSAGE)
        by_path = {self._relative(entry.path): entry for entry in entries}
        listing = _glob_search_files(
            {rel: {"content": "", "modified_at": entry.modified_at} for rel, entry in by_path.items()},
            pattern,
            base,
        )
        if listing == "No files found":
            return GlobResult(matches=[])
        return GlobResult(matches=[
            FileInfo(path=rel, is_dir=False, size=by_path[rel].size, modified_at=by_path[rel].modified_at)
            for rel in listing.split("\n")
        ])

    async def agrep(self, pattern: str, path: str | None = None, glob: str | None = None) -> GrepResult:
        try:
            async with asyncio.timeout(ASYNC_GREP_TIMEOUT):
                return await self._grep(pattern, path or "/", glob)
        except TimeoutError:
            return GrepResult(error=(
                f"Error: grep timed out after {ASYNC_GREP_TIMEOUT}s. "
                "Try a more specific pattern or a narrower path."
            ))

    async def _grep(self, pattern: str, base: str, glob: str | None) -> GrepResult:
        try:
            entries = await self._files.entries(self._path(base))
        except InvalidPath:
            return GrepResult(matches=[])
        except InputsUnavailable:
            return GrepResult(error=UNAVAILABLE_MESSAGE)
        candidates = [
            entry for entry in entries
            if _get_file_type(entry.path) == "text"
            and entry.size <= GREP_MAX_FILE_BYTES
            and (not glob or wcglob.globmatch(PurePosixPath(entry.path).name, glob, flags=wcglob.BRACE))
        ]
        searched, truncated = _within_grep_budget(candidates)
        if truncated:
            logger.info("conversation_grep_truncated", "Searched only part of the conversation's files",
                        files_scanned=len(searched), files_matching_filters=len(candidates))
        contents: dict[str, dict[str, str]] = {}
        for full_path, data in (await self._files.read_many([entry.path for entry in searched])).items():
            try:
                contents[self._relative(full_path)] = {"content": _text(data), "encoding": "utf-8"}
            except UnicodeDecodeError:
                continue
        return grep_matches_from_files(contents, pattern, base, glob)

    # -- upload / download -----------------------------------------------------
    async def aupload_files(self, files: list[tuple[str, bytes]]) -> list[FileUploadResponse]:
        responses: list[FileUploadResponse] = []
        for file_path, content in files:
            try:
                path = self._path(file_path)
            except InvalidPath:
                responses.append(FileUploadResponse(path=file_path, error=INVALID_PATH))
                continue
            refusal = self._write_refusal(path, len(content))
            if refusal is not None:
                self._log_refused(path, refusal[0])
                error = PERMISSION_DENIED if refusal[0] == "read_only" else refusal[1]
                responses.append(FileUploadResponse(path=file_path, error=error))
                continue
            outcome = await self._files.replace(path, content)
            error = {"ok": None, "is_directory": IS_DIRECTORY}.get(outcome, INVALID_PATH)
            responses.append(FileUploadResponse(path=file_path, error=error))
        return responses

    async def adownload_files(self, paths: list[str]) -> list[FileDownloadResponse]:
        responses: list[FileDownloadResponse] = []
        for file_path in paths:
            try:
                data = await self._files.read_bytes(self._path(file_path))
            except InvalidPath:
                responses.append(FileDownloadResponse(path=file_path, error=INVALID_PATH))
                continue
            except InputsUnavailable:
                responses.append(FileDownloadResponse(path=file_path, error=UNAVAILABLE_MESSAGE))
                continue
            responses.append(FileDownloadResponse(
                path=file_path, content=data, error=None if data is not None else FILE_NOT_FOUND
            ))
        return responses

    # -- the sync surface --------------------------------------------------------
    def _sync(self, coro: Coroutine[Any, Any, _T]) -> _T:
        """Run an async method from a worker thread on the service loop.

        Only safe off the loop thread (the loop is idle, awaiting the thread),
        so a call on the loop thread is refused rather than deadlocking.
        """
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            pass
        else:
            coro.close()
            raise RuntimeError("ConversationFilesBackend sync method called on the event loop; use the async one.")
        if self._loop is None or not self._loop.is_running():
            coro.close()
            raise RuntimeError("ConversationFilesBackend needs the service event loop; none is running.")
        return asyncio.run_coroutine_threadsafe(coro, self._loop).result()

    def ls(self, path: str) -> LsResult:
        return self._sync(self.als(path))

    def read(self, file_path: str, offset: int = 0, limit: int = 2000) -> ReadResult:
        return self._sync(self.aread(file_path, offset, limit))

    def write(self, file_path: str, content: str) -> WriteResult:
        return self._sync(self.awrite(file_path, content))

    def edit(
        self, file_path: str, old_string: str, new_string: str, replace_all: bool = False
    ) -> EditResult:
        return self._sync(self.aedit(file_path, old_string, new_string, replace_all))

    def glob(self, pattern: str, path: str | None = None) -> GlobResult:
        return self._sync(self.aglob(pattern, path))

    def grep(self, pattern: str, path: str | None = None, glob: str | None = None) -> GrepResult:
        return self._sync(self.agrep(pattern, path, glob))

    def upload_files(self, files: list[tuple[str, bytes]]) -> list[FileUploadResponse]:
        return self._sync(self.aupload_files(files))

    def download_files(self, paths: list[str]) -> list[FileDownloadResponse]:
        return self._sync(self.adownload_files(paths))
