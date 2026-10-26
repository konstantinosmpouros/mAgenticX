"""Unpack an agent-builder import into ``{yaml, files}`` for the agents service.

The builder's **Import** accepts an ``agent.yaml`` in one of two shapes:

* the manifest as text (a ``yaml`` form field, or one ``.yaml`` among the
  uploaded files) plus the prompt files it references;
* one ``.zip`` holding all of it, as **Export** produces.

Either way this module turns the upload into the agents service's import body —
the manifest text and a list of UTF-8 files at their relative paths — and
refuses anything that is not a small folder of text. The agents service then
parses and validates it; nothing here reads YAML.

A zip is never written to disk. It is opened in memory under fixed limits: the
entry count, each file's size and the uncompressed total are checked against the
sizes the archive *declares*, and again while reading, so an archive that lies
about its sizes (a zip bomb) is stopped at the limit rather than inflated. Paths
must stay inside the folder: no absolute paths, no ``..``, no symlinks, and no
deeper than :data:`MAX_PATH_DEPTH`.
"""
from __future__ import annotations

import io
import stat
import zipfile
from collections.abc import Sequence
from dataclasses import dataclass

from fastapi import HTTPException, UploadFile, status

from core.logging import get_logger

logger = get_logger(__name__)

#: Prompt and reference files an agent may carry, plus the manifest itself.
MAX_FILES = 20
MAX_ENTRIES = MAX_FILES + 1
MAX_FILE_BYTES = 256 * 1024
MAX_TOTAL_BYTES = 1280 * 1024  # 1.25 MiB, uncompressed
MAX_PATH_DEPTH = 4
#: A zip holds at most MAX_TOTAL_BYTES of text, which never compresses to more
#: than itself; anything larger than this is not a legitimate export.
MAX_ZIP_BYTES = MAX_TOTAL_BYTES + 256 * 1024

TEXT_EXTENSIONS = (".md", ".txt", ".yaml", ".yml")
YAML_EXTENSIONS = (".yaml", ".yml")
MANIFEST_NAMES = ("agent.yaml", "agent.yml")

_READ_CHUNK = 64 * 1024


@dataclass
class _RawFile:
    path: str
    data: bytes


def _reject(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=detail)


def _too_large(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_413_CONTENT_TOO_LARGE, detail=detail)


def _clean_path(raw: str) -> str:
    """A safe relative POSIX path, or 422.

    Refused rather than repaired: a path that tries to leave the folder is not a
    file anyone meant to upload, and silently rewriting it would store the file
    somewhere its spec does not point.
    """
    if not raw or "\x00" in raw or "\\" in raw:
        raise _reject(f"“{raw}” is not a valid file path.")
    if raw.startswith("/") or (len(raw) > 1 and raw[1] == ":"):
        raise _reject(f"“{raw}” is an absolute path; files must be relative to the agent folder.")
    parts = [p for p in raw.split("/") if p not in ("", ".")]
    if any(p == ".." for p in parts):
        raise _reject(f"“{raw}” points outside the agent folder.")
    if not parts:
        raise _reject(f"“{raw}” is not a valid file path.")
    return "/".join(parts)


def _is_ignored(path: str) -> bool:
    """macOS resource forks and dotfiles (``.DS_Store``, ``.git/…``) are not
    part of an agent; they are dropped instead of failing the import."""
    parts = path.split("/")
    return parts[0] == "__MACOSX" or any(p.startswith(".") for p in parts)


def _check_extension(path: str) -> None:
    if not path.lower().endswith(TEXT_EXTENSIONS):
        raise _reject(
            f"“{path}” is not a supported file. An agent folder holds only "
            f"{', '.join(TEXT_EXTENSIONS)} files."
        )


def _check_depth(path: str) -> None:
    if path.count("/") + 1 > MAX_PATH_DEPTH:
        raise _reject(f"“{path}” is nested too deeply (at most {MAX_PATH_DEPTH} levels).")


def _decode(path: str, data: bytes) -> str:
    try:
        # utf-8-sig: an editor's byte-order mark is not part of the text.
        return data.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise _reject(f"“{path}” is not a UTF-8 text file.") from exc


async def _read_upload(upload: UploadFile, limit: int, label: str) -> bytes:
    """Read at most ``limit`` bytes; one byte more means the file is too big."""
    data = await upload.read(limit + 1)
    if len(data) > limit:
        raise _too_large(f"“{label}” is too large (at most {limit // 1024} KiB).")
    return data


def _read_zip(data: bytes) -> list[_RawFile]:
    """The archive's files, checked and read under the limits."""
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except (zipfile.BadZipFile, zipfile.LargeZipFile, ValueError) as exc:
        raise _reject("That file is not a readable .zip archive.") from exc

    with archive:
        entries: list[tuple[str, zipfile.ZipInfo]] = []
        declared_total = 0
        for info in archive.infolist():
            if info.is_dir():
                continue
            mode = info.external_attr >> 16
            if stat.S_ISLNK(mode):
                raise _reject(f"“{info.filename}” is a symbolic link; links are not allowed.")
            path = _clean_path(info.filename)
            if _is_ignored(path):
                continue
            if info.flag_bits & 0x1:
                raise _reject(f"“{path}” is encrypted; export the agent again without a password.")
            if info.file_size > MAX_FILE_BYTES:
                raise _too_large(f"“{path}” is too large (at most {MAX_FILE_BYTES // 1024} KiB).")
            declared_total += info.file_size
            entries.append((path, info))
            # Checked as entries are counted, not after: an archive of a
            # million empty entries is refused at the 22nd.
            if len(entries) > MAX_ENTRIES:
                raise _reject(
                    f"The archive has too many files (at most {MAX_FILES} plus agent.yaml)."
                )
        if declared_total > MAX_TOTAL_BYTES:
            raise _too_large("The archive is too large once unpacked (at most 1.25 MiB).")

        files: list[_RawFile] = []
        read_total = 0
        for path, info in entries:
            limit = min(info.file_size, MAX_FILE_BYTES)
            buffer = bytearray()
            try:
                with archive.open(info) as handle:
                    while True:
                        chunk = handle.read(_READ_CHUNK)
                        if not chunk:
                            break
                        buffer.extend(chunk)
                        read_total += len(chunk)
                        # The declared size is a claim, not a fact: stop the
                        # moment the bytes exceed it rather than trusting it.
                        if len(buffer) > limit or read_total > MAX_TOTAL_BYTES:
                            logger.warning(
                                "agent_import_zip_size_mismatch",
                                "An imported archive inflated past its declared size",
                                failure_reason="zip_size_mismatch",
                            )
                            raise _too_large(
                                "The archive is larger than it declares; it was not unpacked."
                            )
            except (zipfile.BadZipFile, EOFError, OSError, NotImplementedError) as exc:
                raise _reject(f"“{path}” could not be read from the archive.") from exc
            files.append(_RawFile(path=path, data=bytes(buffer)))
    return _strip_shared_folder(files)


def _strip_shared_folder(files: list[_RawFile]) -> list[_RawFile]:
    """``my-agent/agent.yaml`` → ``agent.yaml`` when everything shares one folder,
    which is what zipping a folder (rather than its contents) produces."""
    if not files or any("/" not in f.path for f in files):
        return files
    tops = {f.path.split("/", 1)[0] for f in files}
    if len(tops) != 1:
        return files
    return [_RawFile(path=f.path.split("/", 1)[1], data=f.data) for f in files]


def _pick_manifest(files: list[_RawFile]) -> tuple[_RawFile, list[_RawFile]]:
    """``agent.yaml`` / ``agent.yml`` at the root, else the only YAML file."""
    named = [f for f in files if f.path.lower() in MANIFEST_NAMES]
    if len(named) > 1:
        raise _reject("Found both agent.yaml and agent.yml; keep one.")
    if named:
        manifest = named[0]
    else:
        yamls = [f for f in files if f.path.lower().endswith(YAML_EXTENSIONS)]
        if len(yamls) != 1:
            raise _reject(
                "No agent.yaml found. Add it at the top of the folder, or upload a single YAML file."
                if not yamls
                else "Several YAML files and none named agent.yaml; name the manifest agent.yaml."
            )
        manifest = yamls[0]
    return manifest, [f for f in files if f is not manifest]


async def build_import_payload(
    yaml_text: str | None, uploads: Sequence[UploadFile]
) -> dict:
    """The agents service's import body from what the builder uploaded.

    Exactly one shape is accepted: a single ``.zip`` on its own, or a manifest
    (the ``yaml`` field, or a YAML file among ``uploads``) with its files.
    """
    uploads = [u for u in uploads if u is not None and (u.filename or "")]
    has_yaml_field = bool(yaml_text and yaml_text.strip())
    zips = [u for u in uploads if (u.filename or "").lower().endswith(".zip")]

    if zips:
        if len(uploads) != 1 or has_yaml_field:
            raise _reject("Upload either one .zip, or agent.yaml with its files, not both.")
        raw = _read_zip(await _read_upload(zips[0], MAX_ZIP_BYTES, zips[0].filename or "archive"))
    else:
        raw = []
        for upload in uploads:
            # Browsers send a bare file name; a folder upload may send a
            # relative path, which is held to the same rules as a zip entry.
            path = _clean_path(upload.filename or "")
            if _is_ignored(path):
                continue
            raw.append(_RawFile(path=path, data=await _read_upload(upload, MAX_FILE_BYTES, path)))
        if len(raw) > (MAX_FILES if has_yaml_field else MAX_ENTRIES):
            raise _reject(f"Too many files (at most {MAX_FILES} plus agent.yaml).")

    seen: set[str] = set()
    total = 0
    for f in raw:
        _check_extension(f.path)
        _check_depth(f.path)
        if f.path in seen:
            raise _reject(f"“{f.path}” appears twice.")
        seen.add(f.path)
        total += len(f.data)
    if has_yaml_field:
        total += len(yaml_text.encode("utf-8"))
    if total > MAX_TOTAL_BYTES:
        raise _too_large("The agent's files are too large together (at most 1.25 MiB).")

    if has_yaml_field:
        if any(f.path.lower() in MANIFEST_NAMES for f in raw):
            raise _reject("agent.yaml was sent twice: as text and as a file. Send it once.")
        if len(yaml_text.encode("utf-8")) > MAX_FILE_BYTES:
            raise _too_large(f"agent.yaml is too large (at most {MAX_FILE_BYTES // 1024} KiB).")
        manifest_text = yaml_text
        rest = raw
    else:
        manifest, rest = _pick_manifest(raw)
        manifest_text = _decode(manifest.path, manifest.data)

    return {
        "yaml": manifest_text,
        "files": [
            {"path": f.path, "content": _decode(f.path, f.data), "encoding": "utf-8"}
            for f in rest
        ],
    }


__all__ = [
    "MAX_ENTRIES",
    "MAX_FILES",
    "MAX_FILE_BYTES",
    "MAX_PATH_DEPTH",
    "MAX_TOTAL_BYTES",
    "build_import_payload",
]
