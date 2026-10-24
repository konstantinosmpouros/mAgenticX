"""The virtual paths a conversation's files answer to — one normaliser for all.

Every path reaches the table through :func:`normalise` first, so the database
only ever sees one spelling of a file and a traversal attempt never becomes a
query. The rules mirror what the volume enforced (``layout.safe_segment``):
case-sensitive, no ``.``/``..`` segments, no hidden segments, no backslashes or
control characters.

There are no directory rows. A directory is implied by the files under it,
which is why "is this a directory?" is a prefix question (:func:`children_range`)
rather than a lookup.
"""
from __future__ import annotations

import unicodedata

CONVERSATION_ROOT = "/conversation"
LARGE_TOOL_RESULTS_ROOT = "/large_tool_results"
CONVERSATION_HISTORY_ROOT = "/conversation_history"
#: The three routes this store backs. ``/conversation/input/`` sits inside the
#: first, served from the bridge's attachments rather than the table.
MOUNT_ROOTS = (CONVERSATION_ROOT, LARGE_TOOL_RESULTS_ROOT, CONVERSATION_HISTORY_ROOT)

INPUT_DIR = f"{CONVERSATION_ROOT}/input"
OUTPUT_DIR = f"{CONVERSATION_ROOT}/output"
INPUT_PREFIX = f"{INPUT_DIR}/"
#: The only place a deliverable can be presented from — ``present_artifact`` and
#: the bridge's snapshot read are both held to it, so neither can be pointed at
#: an upload or an offloaded tool result.
OUTPUT_PREFIX = f"{OUTPUT_DIR}/"

MAX_PATH_BYTES = 1024
MAX_DEPTH = 32


class InvalidPath(ValueError):
    """A path the store refuses to name a file by."""


def normalise(path: str) -> str:
    """The canonical absolute form of ``path``, or :class:`InvalidPath`.

    NFC-normalised so two spellings of the same name cannot become two files;
    empty segments and a trailing slash collapse away.
    """
    if not isinstance(path, str) or not path.startswith("/"):
        raise InvalidPath(f"Path must be absolute: {path!r}")
    text = unicodedata.normalize("NFC", path)
    segments = [segment for segment in text.split("/") if segment]
    for segment in segments:
        if segment in (".", "..") or segment.startswith("."):
            raise InvalidPath(f"Illegal path segment: {segment!r}")
        if "\\" in segment or any(ord(char) < 32 or ord(char) == 127 for char in segment):
            raise InvalidPath(f"Illegal character in path segment: {segment!r}")
    if len(segments) > MAX_DEPTH:
        raise InvalidPath("Path is nested too deeply.")
    canonical = "/" + "/".join(segments)
    if len(canonical.encode("utf-8")) > MAX_PATH_BYTES:
        raise InvalidPath("Path is too long.")
    return canonical


def join(root: str, backend_path: str) -> str:
    """A mount-relative path (as ``CompositeBackend`` hands it over) made absolute."""
    return normalise(f"{root}/{backend_path.lstrip('/')}")


def relative(root: str, path: str) -> str:
    """The inverse of :func:`join`: what ``CompositeBackend`` expects back."""
    return path[len(root):] or "/"


def is_input(path: str) -> bool:
    """Whether ``path`` is the uploads folder or anything in it."""
    return path == INPUT_DIR or path.startswith(INPUT_PREFIX)


def is_storable(path: str) -> bool:
    """Whether a file may be a row: inside a mount, below its root, not an upload.

    Mirrors the table's CHECK constraint, so a refusal is a readable error
    rather than a constraint violation.
    """
    return not is_input(path) and any(path.startswith(f"{root}/") for root in MOUNT_ROOTS)


def ancestors(path: str) -> list[str]:
    """Every proper ancestor of ``path`` (``/a/b/c`` → ``/a``, ``/a/b``)."""
    segments = path.strip("/").split("/")
    return ["/" + "/".join(segments[:depth]) for depth in range(1, len(segments))]


def children_range(directory: str) -> tuple[str, str]:
    """Bounds of every path strictly under ``directory``, for a btree range scan.

    ``'0'`` is the code point right after ``'/'``, so under the column's ``"C"``
    collation ``[dir/, dir0)`` holds exactly ``dir/…`` — and never ``dir.txt``
    or ``dir-old/…``, which a ``LIKE 'dir%'`` would also match.
    """
    base = directory.rstrip("/")
    return f"{base}/", f"{base}0"


def kind(path: str) -> str:
    """A path's role, for logs (never the path itself — that can carry user data)."""
    if path.startswith(f"{LARGE_TOOL_RESULTS_ROOT}/"):
        return "tool_result"
    if path.startswith(f"{CONVERSATION_HISTORY_ROOT}/"):
        return "history"
    if is_input(path):
        return "input"
    if path.startswith(OUTPUT_PREFIX):
        return "output"
    return "work"
