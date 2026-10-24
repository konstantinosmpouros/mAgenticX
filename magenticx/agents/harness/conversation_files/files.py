"""One run's view of its conversation's files: the table plus the uploads.

Built once per run and shared by everything in it that touches files — the
filesystem mounts, ``view_image``, ``present_artifact`` — so the uploads are
listed once per run however many tools look at them. Paths here are absolute
virtual paths, already normalised.
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime

from harness.conversation_files import paths
from harness.conversation_files.inputs import InputsUnavailable, InputView
from harness.conversation_files.store import ConversationFileStore, WriteOutcome


@dataclass(frozen=True)
class Entry:
    """A file as a listing shows it, wherever its bytes live."""

    path: str
    size: int
    modified_at: str


@dataclass
class ConversationFiles:
    user_id: str
    conversation_id: str
    agent_slug: str
    store: ConversationFileStore
    run_id: str | None = None
    inputs: InputView = field(init=False)

    def __post_init__(self) -> None:
        self.inputs = InputView(self.user_id, self.conversation_id)

    # -- reads ---------------------------------------------------------------
    async def entries(self, directory: str) -> list[Entry]:
        """Every file at ``directory`` or below it, uploads included.

        Listing *inside* the uploads folder needs the bridge and raises
        :class:`InputsUnavailable` without it. A wider listing (the whole
        conversation, a grep from the root) leaves the uploads out instead of
        failing, so one unreachable service does not blank everything else.
        """
        rows = await self.store.list_files(self.user_id, self.conversation_id, directory)
        found = [Entry(row.path, row.size, _iso(row.updated_at)) for row in rows]
        if paths.is_input(directory) or paths.INPUT_DIR.startswith(f"{directory.rstrip('/')}/"):
            found += await self._input_entries(directory)
        return sorted(found, key=lambda entry: entry.path)

    async def read_bytes(self, path: str) -> bytes | None:
        """A file's bytes, or None when there is none at ``path``."""
        if paths.is_input(path):
            name = path[len(paths.INPUT_PREFIX):]
            return await self.inputs.read(name) if name and "/" not in name else None
        return await self.store.read(self.user_id, self.conversation_id, path)

    async def read_many(self, file_paths: list[str]) -> dict[str, bytes]:
        """Several files' bytes, keyed by path — one query for the table's share.

        For searching many files at once: an upload the bridge cannot hand over
        right now is left out rather than failing the rest.
        """
        uploads = [path for path in file_paths if paths.is_input(path)]
        stored = [path for path in file_paths if not paths.is_input(path)]
        found = await self.store.read_many(self.user_id, self.conversation_id, stored)
        for path in uploads:
            try:
                data = await self.read_bytes(path)
            except InputsUnavailable:
                continue
            if data is not None:
                found[path] = data
        return found

    async def exists(self, path: str) -> bool:
        if paths.is_input(path):
            return path[len(paths.INPUT_PREFIX):] in await self.inputs.files()
        return await self.store.stat(self.user_id, self.conversation_id, path) is not None

    # -- writes --------------------------------------------------------------
    async def create(self, path: str, data: bytes) -> WriteOutcome:
        return await self.store.create(
            self.user_id, self.conversation_id, path, data,
            agent_slug=self.agent_slug, run_id=self.run_id,
        )

    async def replace(self, path: str, data: bytes) -> WriteOutcome:
        return await self.store.replace(
            self.user_id, self.conversation_id, path, data,
            agent_slug=self.agent_slug, run_id=self.run_id,
        )

    async def edit(self, path: str, transform: Callable[[bytes], bytes | None]) -> bool:
        return await self.store.edit(
            self.user_id, self.conversation_id, path, transform,
            agent_slug=self.agent_slug, run_id=self.run_id,
        )

    # -- internals -----------------------------------------------------------
    async def _input_entries(self, directory: str) -> list[Entry]:
        strict = paths.is_input(directory)
        try:
            uploads = await self.inputs.files()
        except InputsUnavailable:
            if strict:
                raise
            return []
        prefix = directory.rstrip("/") + "/"
        found = [
            Entry(f"{paths.INPUT_PREFIX}{upload.name}", upload.size, upload.created_at)
            for upload in uploads.values()
        ]
        return [entry for entry in found if entry.path == directory or entry.path.startswith(prefix)]


def _iso(moment: datetime) -> str:
    return moment.isoformat()
