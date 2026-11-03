"""The per-call workspace: a fresh temp dir that holds exactly the files sent.

Conversation files are rows in ``agent_runtime`` (plan 36), not a disk the
runner shares, so nothing about a call touches a host path derived from its
identity. Each call gets ``<calls_root>/<uuid>/`` (0700, owned by the runner's
uid 1000 — the same uid the box runs as) with ``in/`` and ``out/``:

* ``prepare_workspace`` writes the request's files (``input/…`` → ``in/``,
  ``output/…`` → ``out/``) with ``O_EXCL | O_NOFOLLOW``, and remembers the
  SHA-256 of every ``output/`` file it was given;
* ``collect_outputs`` walks ``out/`` without following links and returns every
  regular file that is new or changed, within the per-file / total caps.
  Symlinks, devices, FIFOs and sockets are never read — they are skipped and
  logged as a security event, since a well-behaved command has no reason to
  leave one there;
* ``remove_workspace`` deletes the whole dir, even one the box chmod-ed shut.

Paths reaching the filesystem are validated by ``schema.files`` first; every
join is additionally checked to stay below its base (defense in depth).
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import os
import shutil
import stat
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from core.logging import get_logger
from schema import FileIn, FileOut, is_safe_relative_path, split_file_path

security_logger = get_logger("sandbox_runner.security")

_DIR_MODE = 0o700
_FILE_MODE = 0o600
_READ_CHUNK = 1024 * 1024


class InvalidFiles(Exception):
    """The request's files cannot be placed (bad base64, path clash). → 422."""


class InputTooLarge(Exception):
    """The request's files decode to more than ``SANDBOX_MAX_INPUT_BYTES``. → 413."""


@dataclass
class Workspace:
    """One call's dirs, and the digests of the ``output/`` files it was given."""

    call_dir: Path
    input_dir: Path
    output_dir: Path
    sent_outputs: dict[str, str] = field(default_factory=dict)


@dataclass
class CollectedOutputs:
    """What ``collect_outputs`` found."""

    files: list[FileOut]
    truncated: bool
    out_bytes: int  # every regular file under out/, returned or not


def decode_files(files: list[FileIn], max_total: int) -> list[tuple[str, str, bytes]]:
    """Decode every file strictly; raise before anything touches the disk.

    Returns ``(area, rel, data)`` triples. The total is checked against the
    base64 length first (an upper bound), so an oversized body is refused
    without decoding it.
    """
    estimated = sum(len(f.content_b64) * 3 // 4 for f in files)
    if estimated > max_total + 3 * len(files):
        raise InputTooLarge()
    decoded: list[tuple[str, str, bytes]] = []
    total = 0
    for f in files:
        split = split_file_path(f.path)
        if split is None:  # already validated by the schema; never trust one layer
            raise InvalidFiles()
        try:
            data = base64.b64decode(f.content_b64, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise InvalidFiles() from exc
        total += len(data)
        if total > max_total:
            raise InputTooLarge()
        decoded.append((split[0], split[1], data))
    return decoded


def _below(base: Path, rel: str) -> Path:
    target = base.joinpath(*rel.split("/"))
    if base not in target.parents:
        raise InvalidFiles()
    return target


def _write_new_file(path: Path, data: bytes) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
    fd = os.open(path, flags, _FILE_MODE)
    with os.fdopen(fd, "wb") as handle:
        handle.write(data)


def prepare_workspace(calls_root: Path, decoded: list[tuple[str, str, bytes]]) -> Workspace:
    """Create the call dir and place the decoded files. On any failure the dir is removed."""
    calls_root.mkdir(mode=_DIR_MODE, parents=True, exist_ok=True)
    call_dir = calls_root / uuid.uuid4().hex
    os.mkdir(call_dir, _DIR_MODE)
    ws = Workspace(call_dir=call_dir, input_dir=call_dir / "in", output_dir=call_dir / "out")
    try:
        os.mkdir(ws.input_dir, _DIR_MODE)
        os.mkdir(ws.output_dir, _DIR_MODE)
        for area, rel, data in decoded:
            base = ws.input_dir if area == "input" else ws.output_dir
            target = _below(base, rel)
            try:
                # Parents are created fresh here; nothing else writes this dir yet.
                target.parent.mkdir(mode=_DIR_MODE, parents=True, exist_ok=True)
                _write_new_file(target, data)
            except (FileExistsError, IsADirectoryError, NotADirectoryError) as exc:
                raise InvalidFiles() from exc
            if area == "output":
                ws.sent_outputs[rel] = hashlib.sha256(data).hexdigest()
    except BaseException:
        remove_workspace(ws)
        raise
    return ws


def out_bytes(path: Path) -> int:
    """Apparent size of the regular files under ``path``, links never followed."""
    total = 0
    for dirpath, _dirnames, filenames in os.walk(path, followlinks=False):
        for name in filenames:
            try:
                st = os.lstat(os.path.join(dirpath, name))
            except OSError:
                continue
            if stat.S_ISREG(st.st_mode):
                total += st.st_size
    return total


def _read_regular(path: Path, limit: int) -> bytes | None:
    """Read a regular file without following a link; None if it is not one or too big."""
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0)
    try:
        fd = os.open(path, flags)
    except OSError:
        return None
    with os.fdopen(fd, "rb") as handle:
        st = os.fstat(handle.fileno())
        if not stat.S_ISREG(st.st_mode) or st.st_size > limit:
            return None
        data = handle.read(limit + 1)
    return data if len(data) <= limit else None


def _security_event(kind: str, rel: str) -> None:
    security_logger.warning(
        "sandbox_output_entry_skipped",
        "Skipped a non-regular entry the box left in output/",
        kind=kind,
        entry=rel[:200],
    )


def collect_outputs(ws: Workspace, *, max_file: int, max_total: int) -> CollectedOutputs:
    """Every new or changed regular file under ``out/``, within the caps.

    Returned in sorted path order so a cut by the total cap is deterministic.
    """
    candidates: list[tuple[str, Path, int]] = []
    truncated = False
    total_out = 0
    base = ws.output_dir
    for dirpath, dirnames, filenames in os.walk(base, followlinks=False):
        here = Path(dirpath)
        # os.walk lists a symlinked directory in dirnames but does not enter it.
        for name in list(dirnames):
            if (here / name).is_symlink():
                _security_event("symlink", (here / name).relative_to(base).as_posix())
                dirnames.remove(name)
        for name in filenames:
            path = here / name
            rel = path.relative_to(base).as_posix()
            try:
                st = os.lstat(path)
            except OSError:
                continue
            if stat.S_ISLNK(st.st_mode):
                _security_event("symlink", rel)
                continue
            if not stat.S_ISREG(st.st_mode):
                _security_event("special_file", rel)
                continue
            total_out += st.st_size
            if not is_safe_relative_path(rel) or len("output/" + rel) > 200:
                truncated = True  # a name the agents service could not store
                continue
            candidates.append((rel, path, st.st_size))

    files: list[FileOut] = []
    returned = 0
    for rel, path, size in sorted(candidates):
        if size > max_file or returned + size > max_total:
            truncated = True
            continue
        data = _read_regular(path, max_file)
        if data is None:
            truncated = True
            continue
        if ws.sent_outputs.get(rel) == hashlib.sha256(data).hexdigest():
            continue  # unchanged since it was sent
        returned += len(data)
        files.append(FileOut(path=f"output/{rel}", content_b64=base64.b64encode(data).decode("ascii"), size=len(data)))
    return CollectedOutputs(files=files, truncated=truncated, out_bytes=total_out)


def _force_writable(func, path, _exc) -> None:
    """rmtree error hook: the box may have chmod-ed a dir shut; reopen it and retry."""
    try:
        parent = os.path.dirname(path)
        os.chmod(parent, _DIR_MODE)
        if os.path.isdir(path) and not os.path.islink(path):
            os.chmod(path, _DIR_MODE)
        func(path)
    except OSError:
        pass


def remove_workspace(ws: Workspace) -> None:
    """Delete the call dir; never raises (the boot-time sweep is the backstop)."""
    try:
        shutil.rmtree(ws.call_dir, onexc=_force_writable)
    except OSError:
        security_logger.error("sandbox_workspace_cleanup_failed", "Could not remove a call dir", call=ws.call_dir.name)


def sweep_calls_root(calls_root: Path) -> int:
    """Remove call dirs a previous process left behind. Returns how many."""
    if not calls_root.is_dir():
        return 0
    count = 0
    for entry in calls_root.iterdir():
        if entry.is_dir() and not entry.is_symlink():
            remove_workspace(Workspace(call_dir=entry, input_dir=entry / "in", output_dir=entry / "out"))
            count += 1
        else:
            entry.unlink(missing_ok=True)
    return count
