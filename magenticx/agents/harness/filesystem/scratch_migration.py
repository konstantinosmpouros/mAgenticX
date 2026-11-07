"""One-shot: move a branch's legacy ``files`` state into the scratch store (plan 41 §3.7).

**Delete this module in the release after plan 41's scratch store ships**, with
:meth:`BranchScratchStore.is_imported` / :meth:`~BranchScratchStore.import_legacy`
and the ``branch_scratch_imports`` table (``DROP TABLE``) — the pattern of the
one-shot pruners of plans 25 and 26: it runs during one deploy, then goes.

Before the store, the workspace's default route kept its files in the ``files``
key of the branch thread's graph state. The first time a branch is used after
the deploy, :func:`import_legacy_scratch` reads that key from the branch's
latest checkpoint and copies every file into the store, then marks the branch
done. It is idempotent: the marker stops a second import, a crash before the
marker leaves nothing half-done (one transaction), and a path the store
already has is never overwritten — it is newer than any checkpoint value.

The ``files`` channel is a deepagents ``DeltaChannel`` whose value is rebuilt
by replaying writes, so it is read through a one-node graph that declares
exactly deepagents' own channel (taken from ``FilesystemState``'s type hints,
so it cannot drift) and nothing else — LangGraph's public ``aget_state`` does
the replay, and older plain-value checkpoints read the same way.
"""
from __future__ import annotations

import base64
import binascii
from typing import Any, TypedDict, get_type_hints

import psycopg
from deepagents.backends.utils import file_data_to_string
from deepagents.middleware.filesystem import FilesystemState
from langgraph.graph import END, START, StateGraph

# Bound as a module and read at call time: the checkpointer package imports
# stores that import this package while it is still initialising.
import harness.checkpointer.store as checkpointer_store
from core.logging import get_logger
from core.settings import settings
from harness.conversation_files import paths
from harness.filesystem.scratch_store import BranchScratchStore, Encoding, ScratchScope

logger = get_logger(__name__)

#: deepagents' own ``files`` channel, reducer and all.
_FILES_CHANNEL = get_type_hints(FilesystemState, include_extras=True)["files"]


class _LegacyFilesState(TypedDict, total=False):
    """The reader graph's whole state: deepagents' ``files`` channel, nothing else."""

    files: _FILES_CHANNEL


#: Branches this process has seen imported, so a hot branch costs one set
#: lookup instead of a marker query per agent build.
_IMPORTED: set[tuple[str, str]] = set()


def _noop(_state: Any) -> dict[str, Any]:
    """The reader graph's only node; it is never run, only compiled."""
    return {}


def _reader(checkpointer: Any) -> Any:
    """A graph that knows only the ``files`` channel, over the shared saver."""
    builder = StateGraph(_LegacyFilesState)
    builder.add_node("noop", _noop)
    builder.add_edge(START, "noop")
    builder.add_edge("noop", END)
    return builder.compile(checkpointer=checkpointer)


async def read_legacy_files(checkpointer: Any, thread_id: str) -> dict[str, Any]:
    """The ``files`` value of ``thread_id``'s latest root checkpoint, or ``{}``."""
    snapshot = await _reader(checkpointer).aget_state({"configurable": {"thread_id": thread_id}})
    values = getattr(snapshot, "values", None) or {}
    files = values.get("files") if isinstance(values, dict) else None
    return files if isinstance(files, dict) else {}


def legacy_to_rows(files: dict[str, Any]) -> tuple[dict[str, tuple[bytes, Encoding]], int]:
    """Legacy ``FileData`` values as store rows, plus how many were skipped.

    A path that no longer normalises, an undecodable value or one over the
    per-file cap is skipped (counted, never logged by name — paths can carry
    user data). Deleted entries (``None``) are skipped too.
    """
    rows: dict[str, tuple[bytes, Encoding]] = {}
    skipped = 0
    cap = settings.conversation_files.max_file_bytes
    for raw_path, file_data in files.items():
        if not isinstance(file_data, dict):
            skipped += file_data is not None
            continue
        try:
            path = paths.normalise(raw_path)
            content = file_data_to_string(file_data)
            if file_data.get("encoding") == "base64":
                data, encoding = base64.b64decode(content, validate=True), "base64"
            else:
                data, encoding = content.encode("utf-8"), "utf-8"
        except (paths.InvalidPath, TypeError, ValueError, binascii.Error):
            skipped += 1
            continue
        if len(data) > cap:
            skipped += 1
            continue
        rows[path] = (data, encoding)  # type: ignore[assignment]
    return rows, skipped


async def import_legacy_scratch(store: BranchScratchStore, scope: ScratchScope, *, agent_slug: str) -> int:
    """Import ``scope``'s legacy checkpoint files once. Returns how many were added.

    Without a checkpointer (a thread-less run, tests) there is nothing to read
    and the branch is left unmarked. Errors propagate: the caller logs them and
    carries on, and the next use tries again.
    """
    key = (scope.conversation_id, scope.branch_thread_id)
    if key in _IMPORTED:
        return 0
    if not checkpointer_store.has_checkpointer_initialized():
        return 0
    if await store.is_imported(scope):
        _IMPORTED.add(key)
        return 0
    legacy = await read_legacy_files(checkpointer_store.get_checkpointer(), scope.branch_thread_id)
    rows, skipped = legacy_to_rows(legacy)
    inserted = await store.import_legacy(scope, rows, agent_slug=agent_slug)
    _IMPORTED.add(key)
    logger.info(
        "branch_scratch_legacy_imported",
        "Imported a branch's checkpoint scratch files into the scratch store",
        conversation_id=scope.conversation_id,
        files_found=len(legacy),
        files_imported=inserted,
        files_skipped=skipped,
    )
    return inserted


#: What an import can fail with: the database, or a checkpoint LangGraph
#: cannot read back. Kept here so the caller's ``except`` names them.
IMPORT_ERRORS: tuple[type[BaseException], ...] = (psycopg.Error, ValueError, TypeError, KeyError)


__all__ = ["IMPORT_ERRORS", "import_legacy_scratch", "legacy_to_rows", "read_legacy_files"]
