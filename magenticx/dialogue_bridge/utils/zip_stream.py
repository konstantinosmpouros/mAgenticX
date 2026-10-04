"""A zip archive built as a stream — never in memory whole, never on disk.

The data export (plan 27) can be gigabytes, on a box (Dennis) whose memory is
shared by every stack. So the archive is never assembled: :class:`ZipStream`
drives the standard library's ``zipfile`` against a *pipe* — a non-seekable
file object that only collects what was just written — and hands those bytes
back to be sent at once. After each call the pipe is empty again.

Because the pipe cannot seek, ``zipfile`` writes each entry with a trailing
data descriptor instead of patching sizes into its header afterwards, which is
exactly what streaming needs. ZIP64 is on for every entry from the first byte:
an archive past 4 GiB or 65,535 entries is otherwise silently corrupt, and
whether it gets there is not known when the first entry is written.

Text entries are deflated; binary ones (attachments are mostly PDFs and images,
already compressed) are stored as-is. Every ``zipfile`` call — compression and
CRC included — runs in a worker thread, so the bridge's single event loop keeps
serving other users while an export runs.

What stays in memory across the whole archive is ``zipfile``'s own index of the
entries written so far (a few hundred bytes each) — never their content.
"""
from __future__ import annotations

import asyncio
import io
import re
import zipfile
from datetime import datetime, timezone
from typing import Optional

_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
_MAX_PATH = 512
_MAX_SEGMENT = 255
_MAX_FILE_NAME = 120


class _Pipe(io.RawIOBase):
    """Write-only, non-seekable sink that holds only the bytes not yet drained."""

    def __init__(self) -> None:
        super().__init__()
        self._parts: list[bytes] = []
        self._position = 0

    def writable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return False

    def readable(self) -> bool:
        return False

    def write(self, data) -> int:  # type: ignore[override]
        chunk = bytes(data)
        self._parts.append(chunk)
        self._position += len(chunk)
        return len(chunk)

    def tell(self) -> int:
        # zipfile records entry offsets from this; it never seeks back.
        return self._position

    def drain(self) -> bytes:
        """Everything written since the last drain, then forget it."""
        out = b"".join(self._parts)
        self._parts.clear()
        return out


def check_archive_path(path: str) -> None:
    """Refuse any entry name that could escape the folder it is extracted into.

    The archive is opened on the user's own machine, so a ``..`` segment or an
    absolute path in an entry name would let content land outside the export
    folder ("zip slip"). Names that come from upstream (the agents service) or
    from user-supplied file names are all checked here, at the one place every
    entry is created.
    """
    if not path or len(path) > _MAX_PATH or path.startswith("/") or "\\" in path:
        raise ValueError(f"unsafe archive path: {path!r}")
    if _CONTROL.search(path):
        raise ValueError(f"unsafe archive path: {path!r}")
    for segment in path.split("/"):
        if segment in ("", ".", "..") or len(segment) > _MAX_SEGMENT:
            raise ValueError(f"unsafe archive path: {path!r}")


def safe_file_name(name: Optional[str]) -> str:
    """A user-supplied file name reduced to one harmless path segment."""
    base = (name or "").replace("\\", "/").rsplit("/", 1)[-1]
    base = _CONTROL.sub("", base).strip().strip(".")
    if not base:
        return "file"
    if len(base) > _MAX_FILE_NAME:
        stem, dot, ext = base.rpartition(".")
        base = (stem[: _MAX_FILE_NAME - len(ext) - 1] + "." + ext) if dot and len(ext) <= 10 else base[:_MAX_FILE_NAME]
    return base


class ZipStream:
    """Build a zip archive entry by entry; every method returns the bytes to send now.

    Use from one coroutine, sequentially: ``open`` → ``write``… → ``close`` per
    entry, then ``finish`` once to write the central directory. Until ``finish``
    the output is not a valid zip — a cut stream can never pass for a complete
    archive.
    """

    def __init__(self) -> None:
        self._pipe = _Pipe()
        self._zip = zipfile.ZipFile(self._pipe, mode="w", allowZip64=True)
        self._entry = None
        self._entry_name: Optional[str] = None
        self._entry_bytes = 0
        self._names: set[str] = set()
        #: Uncompressed size of every closed entry, by name.
        self.sizes: dict[str, int] = {}

    async def open(self, name: str, *, compress: bool) -> bytes:
        """Start an entry. ``compress`` deflates it; use it for text only."""
        check_archive_path(name)
        if self._entry is not None:
            raise RuntimeError(f"entry {self._entry_name!r} is still open")
        if name in self._names:
            raise ValueError(f"duplicate archive path: {name!r}")
        now = datetime.now(timezone.utc)
        info = zipfile.ZipInfo(name, date_time=(now.year, now.month, now.day, now.hour, now.minute, now.second))
        info.compress_type = zipfile.ZIP_DEFLATED if compress else zipfile.ZIP_STORED
        info.external_attr = 0o644 << 16
        self._entry = await asyncio.to_thread(self._zip.open, info, "w", force_zip64=True)
        self._entry_name, self._entry_bytes = name, 0
        self._names.add(name)
        return self._pipe.drain()

    async def write(self, data: bytes) -> bytes:
        """Append to the open entry."""
        if self._entry is None:
            raise RuntimeError("no entry is open")
        if data:
            await asyncio.to_thread(self._entry.write, data)
            self._entry_bytes += len(data)
        return self._pipe.drain()

    async def close(self) -> bytes:
        """End the open entry (writes its data descriptor)."""
        if self._entry is None:
            raise RuntimeError("no entry is open")
        await asyncio.to_thread(self._entry.close)
        self.sizes[self._entry_name or ""] = self._entry_bytes
        self._entry, self._entry_name = None, None
        return self._pipe.drain()

    async def finish(self) -> bytes:
        """Write the central directory. The archive is valid only after this."""
        if self._entry is not None:
            raise RuntimeError(f"entry {self._entry_name!r} is still open")
        await asyncio.to_thread(self._zip.close)
        return self._pipe.drain()


__all__ = ["ZipStream", "check_archive_path", "safe_file_name"]
