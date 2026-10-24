"""What the bridge asks of a conversation's files: snapshots, forks, deletion.

Thin over :class:`~harness.conversation_files.ConversationFileStore`; the routes
in ``router/conversation_files.py`` only translate. None of it needs to know
which agent wrote a file — files belong to the conversation (plan 43).
"""
from __future__ import annotations

import base64
import mimetypes
from pathlib import PurePosixPath

import psycopg

from core.logging import get_logger
from core.settings import settings
from harness.checkpointer import get_checkpointer
from harness.conversation_files import ConversationFileStore, legacy_volume
from harness.conversation_files.paths import OUTPUT_PREFIX, InvalidPath, normalise
from harness.memory import get_memory_pool

logger = get_logger(__name__)


class ReapFailed(Exception):
    """Part of a conversation's runtime is still there; the bridge retries."""


def _store() -> ConversationFileStore:
    return ConversationFileStore(get_memory_pool())


async def read_output_files(
    user_id: str, conversation_id: str, requested: list[str]
) -> tuple[list[dict[str, object]], list[str]]:
    """The presented files, base64, for the bridge's run-end snapshot.

    Only paths under ``/conversation/output/`` are ever returned — an upload or
    an offloaded tool result can never be turned into a deliverable. A path
    that is absent, outside output/ or over ``OUTPUT_MAX_FILE_BYTES`` comes
    back in ``missing``. More than ``OUTPUT_MAX_FILES`` paths is a ValueError.
    """
    if len(requested) > settings.filesystem.output_max_files:
        raise ValueError(f"Too many output files requested: {len(requested)}.")
    wanted: dict[str, str] = {}
    missing: list[str] = []
    for virtual_path in requested:
        try:
            path = normalise(virtual_path)
        except InvalidPath:
            path = ""
        if path.startswith(OUTPUT_PREFIX):
            wanted[virtual_path] = path
        else:
            missing.append(virtual_path)
    found = await _store().read_many(user_id, conversation_id, sorted(set(wanted.values())))
    files: list[dict[str, object]] = []
    for virtual_path, path in wanted.items():
        data = found.get(path)
        if data is None or len(data) > settings.filesystem.output_max_file_bytes:
            missing.append(virtual_path)
            continue
        name = PurePosixPath(path).name
        files.append({
            "path": virtual_path,
            "filename": name,
            "mime": mimetypes.guess_type(name)[0] or "application/octet-stream",
            "size": len(data),
            "base64": base64.b64encode(data).decode("ascii"),
        })
    logger.info("output_files_read", "Read presented files back to the bridge",
                returned=len(files), missing=len(missing))
    return files, missing


async def copy_conversation_files(user_id: str, source_id: str, target_id: str) -> int:
    """A fork's files: the source's paths, naming the same blobs."""
    return await _store().copy_conversation(user_id, source_id, target_id)


async def reap_conversation(user_id: str, conversation_id: str, thread_ids: list[str]) -> None:
    """A deleted conversation's checkpoint threads and files, all of them.

    Idempotent — unknown threads and an empty conversation are no-ops — and
    loud: a failure raises :class:`ReapFailed` so the bridge keeps its outbox
    row and tries again, instead of an orphan being recorded as gone.
    """
    try:
        checkpointer = get_checkpointer()
        for thread_id in filter(None, thread_ids):
            await checkpointer.adelete_thread(thread_id)
        await _store().delete_conversation(user_id, conversation_id)
        # TODO(plan 43): remove once agents v1.22.0 has deployed.
        await legacy_volume.delete_conversation_trees(user_id, conversation_id)
    except (RuntimeError, psycopg.Error, OSError) as exc:
        logger.warning("conversation_reap_failed", "Could not reap a deleted conversation; the bridge retries",
                       error_type=type(exc).__name__)
        raise ReapFailed from exc
