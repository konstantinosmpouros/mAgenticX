"""TEMPORARY — moves the old per-conversation volume trees into Postgres (plan 43).

TODO(plan 43): remove once agents v1.22.0 has deployed, together
with everything that calls it — the lifespan hook in ``main.py``, the run-time
import in ``DeepAgent.ensure_built``, the reap / account-purge calls, the
``router/legacy_workspace.py`` shims, and the ``LEGACY_VOLUME_MIGRATION_ENABLED``
and ``MAGENTICX_WORKSPACES_ROOT`` settings. The list is repeated in
``docs/architecture/deployment.md``.

Before plan 43 a conversation's files lived on the ``magenticx_data`` volume::

    <workspaces_root>/users/<user_id>/agents/<agent_slug>/conversations/<conversation_id>/
        input/<…>                    copies of the uploads → not moved (chat_db holds them)
        output/<rel>                 → /conversation/output/<rel>
        large_tool_results/<rel>     → /large_tool_results/<rel>
        conversation_history/<rel>   → /conversation_history/<rel>
        <rel> (anything else)        → /conversation/<rel>

Two entry points:

* :func:`import_conversation` runs before an agent run, so a conversation used
  before the background pass reaches it already sees its files. It imports and
  never deletes.
* :func:`run_legacy_volume_migration` is the background pass after boot. For
  each conversation the bridge still has, it imports the tree, verifies that
  every file is in Postgres, and only then deletes the tree. Then it prunes
  the directories left empty.

Safety: an import never overwrites a newer row; a tree is deleted only after a
verification pass in which every file (except ``input/``) is found in Postgres
with the same SHA-256 — or was superseded by a later edit of the same path.
A tree holding anything that cannot be imported (a symlink, a hidden or
over-cap file) is kept and logged. Trees of conversations the bridge no longer
has are left alone and counted. The global plane (``MAGENTICX_GLOBAL_ROOT``) is
a different root and is never read here. Every step is idempotent: a pass
killed halfway resumes where it stopped, and a second run finds nothing to do.
"""
from __future__ import annotations

import asyncio
import contextlib
import hashlib
import os
import shutil
from collections import Counter
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import httpx
import psycopg

from core.logging import get_logger
from core.security.internal_trust import internal_service_headers
from core.security.tls import get_httpx_client_cert, get_httpx_verify
from core.settings import settings
from harness.conversation_files import paths
from harness.conversation_files.store import ConversationFileStore, FileEntry
from harness.filesystem.layout import safe_segment
from harness.memory import get_memory_pool

logger = get_logger(__name__)

#: The previous agents task keeps running for a moment during a start-first
#: deploy and may still write to the volume; the pass waits it out.
START_DELAY_SECONDS = 300
#: After a pass that hit a transient failure (bridge or database down).
RETRY_SECONDS = 600
_EXISTENCE_BATCH = 500
_MIGRATED_DIR = f"{paths.CONVERSATION_ROOT}/_migrated"
_OFFLOAD_DIRS = {"large_tool_results", "conversation_history"}

# One conversation at a time, so the background pass and a run's own import
# never walk (or delete) the same tree concurrently.
_lock = asyncio.Lock()


@dataclass(frozen=True)
class _LegacyFile:
    disk: Path
    target: str
    alternative: str
    size: int
    mtime: datetime


@dataclass
class _Tree:
    agent_slug: str
    root: Path
    files: list[_LegacyFile]
    skipped: int


def _users_root() -> Path:
    return settings.filesystem.workspaces_root / "users"


def _target(relative: str) -> str:
    head, _, rest = relative.partition("/")
    if head == "output":
        return f"{paths.OUTPUT_DIR}/{rest}"
    if head in _OFFLOAD_DIRS:
        return f"/{head}/{rest}"
    return f"{paths.CONVERSATION_ROOT}/{relative}"


def _tree_roots(user_id: str, conversation_id: str) -> list[tuple[str, Path]]:
    """``(agent_slug, tree)`` for every agent that worked in the conversation."""
    agents_dir = _users_root() / safe_segment(user_id) / "agents"
    if not agents_dir.is_dir():
        return []
    found = []
    for agent_dir in sorted(agents_dir.iterdir()):
        tree = agent_dir / "conversations" / safe_segment(conversation_id)
        if agent_dir.is_dir() and not tree.is_symlink() and tree.is_dir():
            found.append((agent_dir.name, tree))
    return found


def _scan(agent_slug: str, root: Path) -> _Tree:
    """Every importable file of one tree, and how many cannot be imported."""
    cap = settings.conversation_files.max_file_bytes
    files: list[_LegacyFile] = []
    skipped = 0
    for directory, dirnames, filenames in os.walk(root, followlinks=False):
        here = Path(directory)
        if here == root and "input" in dirnames:
            dirnames.remove("input")  # the uploads are in chat_db, not moved
        for name in [*dirnames, *filenames]:
            disk = here / name
            if disk.is_symlink():
                skipped += 1
                continue
            if name in dirnames:
                continue
            relative = disk.relative_to(root).as_posix()
            try:
                target = paths.normalise(_target(relative))
                alternative = paths.normalise(f"{_MIGRATED_DIR}/{agent_slug}/{relative}")
                stat = disk.stat()
            except (paths.InvalidPath, OSError):
                skipped += 1
                continue
            if stat.st_size > cap:
                skipped += 1
                continue
            mtime = datetime.fromtimestamp(stat.st_mtime, UTC)
            files.append(_LegacyFile(disk, target, alternative, stat.st_size, mtime))
    return _Tree(agent_slug, root, files, skipped)


def _load_trees(user_id: str, conversation_id: str) -> list[_Tree]:
    return [_scan(slug, root) for slug, root in _tree_roots(user_id, conversation_id)]


async def _stamp(user_id: str, conversation_id: str, path: str, moment: datetime) -> None:
    """Give an imported row its file's own time, so "which is newer?" compares
    disk with disk rather than with the moment of the import."""
    async with get_memory_pool().connection() as conn:
        await conn.execute(
            "UPDATE conversation_files SET created_at = %s, updated_at = %s "
            "WHERE conversation_id = %s AND user_id = %s AND path = %s",
            (moment, moment, conversation_id, user_id, path),
        )


async def _settle(
    store: ConversationFileStore, user_id: str, conversation_id: str, slug: str,
    item: _LegacyFile, rows: dict[str, FileEntry], *, write: bool,
) -> bool:
    """Whether ``item`` is safely in Postgres — importing it first when ``write``.

    Safe at a path means: the same content is there, or this agent's row
    there is at least as new as the disk copy (imported rows carry the file's
    own mtime, so a later edit is newer). Another agent's different file at
    the path sends this one to ``_migrated/<slug>/``. The file is read only
    when that cannot be decided from the row alone, so a run's import of an
    already-moved tree costs a stat per file.
    """
    loaded: tuple[bytes, str] | None = None

    async def content() -> tuple[bytes, str]:
        nonlocal loaded
        if loaded is None:
            data = await asyncio.to_thread(item.disk.read_bytes)
            loaded = (data, hashlib.sha256(data).hexdigest())
        return loaded

    async def record(target: str) -> None:
        """Stamp the row just written with the file's own time, and remember it."""
        data, sha256 = await content()
        await _stamp(user_id, conversation_id, target, item.mtime)
        rows[target] = FileEntry(target, len(data), sha256, slug, item.mtime)

    for target in (item.target, item.alternative):
        row = rows.get(target)
        if row is None:
            if not write:
                return False
            data, _ = await content()
            outcome = await store.create(user_id, conversation_id, target, data, agent_slug=slug)
            if outcome == "ok":
                await record(target)
                return True
            row = await store.stat(user_id, conversation_id, target) if outcome == "exists" else None
            if row is None:
                continue  # a directory or a file in the way: try the alternative
            rows[target] = row
        if row.agent_slug == slug and row.updated_at >= item.mtime:
            return True
        if row.sha256 == (await content())[1]:
            return True
        if row.agent_slug == slug:  # the disk copy is newer than the row
            if not write:
                return False
            await store.replace(user_id, conversation_id, target, (await content())[0], agent_slug=slug)
            await record(target)
            return True
    return False


async def _process(
    store: ConversationFileStore, user_id: str, conversation_id: str, trees: list[_Tree], *, write: bool
) -> Counter:
    rows = {row.path: row for row in await store.list_files(user_id, conversation_id)}
    counts: Counter = Counter()
    for tree in trees:
        counts["skipped"] += tree.skipped
        for item in tree.files:
            settled = await _settle(store, user_id, conversation_id, tree.agent_slug, item, rows, write=write)
            counts["settled" if settled else "unsettled"] += 1
            counts["bytes"] += item.size if settled else 0
    return counts


async def import_conversation(user_id: str, conversation_id: str) -> None:
    """Before a run: bring this conversation's old files in. Never deletes."""
    trees = await asyncio.to_thread(_load_trees, user_id, conversation_id)
    if not trees:
        return
    store = ConversationFileStore(get_memory_pool())
    async with _lock:
        counts = await _process(store, user_id, conversation_id, trees, write=True)
    logger.info("conversation_files_import", "Imported a conversation's files from the volume",
                mode="lazy", files=counts["settled"], bytes=counts["bytes"],
                skipped=counts["skipped"], unsettled=counts["unsettled"])


async def _migrate_conversation(store: ConversationFileStore, user_id: str, conversation_id: str) -> Counter:
    """Import, verify, and only then delete one conversation's trees."""
    async with _lock:
        trees = await asyncio.to_thread(_load_trees, user_id, conversation_id)
        imported = await _process(store, user_id, conversation_id, trees, write=True)
        # Verification re-reads every file from disk and the rows from the
        # database: nothing is deleted on the strength of the import's own
        # bookkeeping.
        trees = await asyncio.to_thread(_load_trees, user_id, conversation_id)
        verified = await _process(store, user_id, conversation_id, trees, write=False)
        if verified["unsettled"] or verified["skipped"]:
            imported["kept"] += len(trees)
        else:
            for tree in trees:
                await asyncio.to_thread(shutil.rmtree, tree.root)
            imported["deleted"] += len(trees)
    logger.info("conversation_files_import", "Moved a conversation's files from the volume",
                mode="bulk", files=imported["settled"], bytes=imported["bytes"],
                skipped=imported["skipped"], unsettled=imported["unsettled"],
                trees_deleted=imported["deleted"], trees_kept=imported["kept"])
    return imported


async def _existing_conversations(user_id: str, conversation_ids: list[str]) -> set[str]:
    """Which of these conversations the bridge still has."""
    timeout = httpx.Timeout(settings.bridge.request_timeout_seconds,
                            connect=settings.bridge.connect_timeout_seconds)
    existing: set[str] = set()
    async with httpx.AsyncClient(timeout=timeout, verify=get_httpx_verify(),
                                 cert=get_httpx_client_cert()) as client:
        for start in range(0, len(conversation_ids), _EXISTENCE_BATCH):
            response = await client.post(
                f"{settings.bridge.conversations_url}/existing",
                json={"user_id": user_id, "conversation_ids": conversation_ids[start:start + _EXISTENCE_BATCH]},
                headers=internal_service_headers(),
            )
            response.raise_for_status()
            existing.update(response.json()["conversation_ids"])
    return existing


def _conversation_ids(user_dir: Path) -> list[str]:
    agents_dir = user_dir / "agents"
    if not agents_dir.is_dir():
        return []
    return sorted({
        tree.name
        for agent_dir in agents_dir.iterdir() if agent_dir.is_dir() and not agent_dir.is_symlink()
        for tree in (agent_dir / "conversations").glob("*") if tree.is_dir() and not tree.is_symlink()
    })


def _prune_empty_dirs(root: Path) -> None:
    """Remove the directories under ``root`` (and ``root``) that hold nothing."""
    for directory, _, _ in os.walk(root, topdown=False, followlinks=False):
        # Not empty means something worth keeping is still there.
        with contextlib.suppress(OSError):
            Path(directory).rmdir()


async def _migrate_once(store: ConversationFileStore) -> bool:
    """One pass over the volume. True when nothing is left to retry."""
    users_root = _users_root()
    if not users_root.is_dir():
        return True
    totals: Counter = Counter()
    complete = True
    for user_dir in sorted(users_root.iterdir()):
        if user_dir.is_symlink() or not user_dir.is_dir():
            continue
        try:
            user_id = safe_segment(user_dir.name)
        except ValueError:
            continue
        try:
            conversation_ids = await asyncio.to_thread(_conversation_ids, user_dir)
            existing = await _existing_conversations(user_id, conversation_ids) if conversation_ids else set()
            for conversation_id in conversation_ids:
                if conversation_id not in existing:
                    totals["orphans"] += 1
                    continue
                totals.update(await _migrate_conversation(store, user_id, conversation_id))
        except (httpx.HTTPError, psycopg.Error, OSError, ValueError, KeyError) as exc:
            complete = False
            logger.warning("legacy_volume_migration_user_failed",
                           "Could not move one user's files; the next pass retries",
                           error_type=type(exc).__name__)
            continue
        await asyncio.to_thread(_prune_empty_dirs, user_dir)
    logger.info("legacy_volume_migration_pass", "Finished a pass over the old volume trees",
                complete=complete, files=totals["settled"], bytes=totals["bytes"],
                skipped=totals["skipped"], unsettled=totals["unsettled"], orphans=totals["orphans"],
                trees_deleted=totals["deleted"], trees_kept=totals["kept"])
    return complete


async def run_legacy_volume_migration() -> None:
    """The background pass: waits out the previous task, then moves everything.

    Retries after a transient failure and returns once a pass completes —
    so on every later boot it is one quick walk over an empty tree.
    """
    if not settings.conversation_files.legacy_volume_migration:
        logger.info("legacy_volume_migration_disabled", "LEGACY_VOLUME_MIGRATION_ENABLED is false")
        return
    await asyncio.sleep(START_DELAY_SECONDS)
    store = ConversationFileStore(get_memory_pool())
    while True:
        try:
            if await _migrate_once(store):
                return
        except Exception:  # a background task must log its failure, never die silently
            logger.error("legacy_volume_migration_failed", "The volume migration pass failed", exc_info=True)
        await asyncio.sleep(RETRY_SECONDS)


async def delete_conversation_trees(user_id: str, conversation_id: str) -> None:
    """A deleted conversation's old trees go too, imported or not."""
    for _, tree in await asyncio.to_thread(_tree_roots, user_id, conversation_id):
        await asyncio.to_thread(shutil.rmtree, tree, ignore_errors=True)


async def delete_user_tree(user_id: str) -> bool:
    """A deleted account's whole old folder. Returns whether there was one."""
    root = _users_root() / safe_segment(user_id)
    if not root.exists():
        return False
    await asyncio.to_thread(shutil.rmtree, root)
    return True
