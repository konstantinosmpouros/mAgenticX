"""Add-time download of one remote skill: pinned, verified, capped — or nothing.

The sync only indexed the skill. Its content is fetched here, the first time
anyone adds it, and then stored once as a shared immutable copy. Every check
runs **before** a byte is stored, so a skill that fails any of them leaves no
row behind (plan 30, §3.3):

* **GitHub sources** — the file list comes from ``remote_skill_manifest``
  (written by the sync from the tree), so the Add spends no REST quota. Each
  file is fetched from ``raw.githubusercontent.com`` *at the pinned commit* and
  its git blob SHA-1 must equal the tree's. Different bytes are refused.
* **``.well-known`` sources** — the artifact's sha256 must equal the digest the
  publisher's index declared. An archive is then walked **in memory**: never
  ``extractall``, no symlinks, hard links or devices, no absolute or ``..``
  paths, and gzip is inflated under a hard output ceiling so a small archive
  cannot expand into a large one.

Then the same caps and SKILL.md check the sync applied run again on what was
actually downloaded — the sync saw sizes and a manifest; this sees the bytes.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import tarfile
import zlib
from typing import Any

from core.logging import get_logger
from core.settings import settings
from harness.skill_registry.remote.client import RemoteFetchError, RemoteSkillClient
from harness.skill_registry.remote.sources import (
    MAX_REMOTE_FILE_BYTES,
    MAX_REMOTE_SKILL_BYTES,
    RemoteSource,
    check_file_set,
    check_rel_path,
    check_skill_md,
    is_hidden,
)
from harness.skill_registry.remote.sync import content_ref_for, git_blob_sha
from harness.skill_registry.store import SkillStore

logger = get_logger(__name__)

#: Slack over the content cap for tar headers and padding (512 B each per file).
_TAR_OVERHEAD = 1024 * 1024
_GZIP_MAGIC = b"\x1f\x8b"

#: ``{path: (content, encoding, sha256)}`` — the shape the store writes.
RemoteFiles = dict[str, tuple[str, str, str]]


class RemoteSkillRefused(ValueError):
    """The downloaded skill failed a check. Nothing was stored. (→ 422)"""


class RemoteSkillUnavailable(RuntimeError):
    """The source could not be read right now. Nothing was stored. (→ 502)"""


def _encode(files: dict[str, bytes]) -> RemoteFiles:
    """Store text as text and anything else as base64, each with its own sha256."""
    out: RemoteFiles = {}
    for path, body in files.items():
        digest = hashlib.sha256(body).hexdigest()
        try:
            out[path] = (body.decode("utf-8"), "utf-8", digest)
        except UnicodeDecodeError:
            out[path] = (base64.b64encode(body).decode("ascii"), "base64", digest)
    return out


def _validate(files: dict[str, bytes], skill_id: str) -> None:
    """The caps and the SKILL.md check, on the bytes actually downloaded."""
    problem = check_file_set([(path, len(body)) for path, body in files.items()])
    if problem:
        raise RemoteSkillRefused(problem)
    check = check_skill_md(files["SKILL.md"], skill_id)
    if check.refusal:
        raise RemoteSkillRefused(check.refusal)


def _gunzip_bounded(data: bytes, limit: int) -> bytes:
    """Inflate gzip, refusing as soon as the output would pass ``limit``."""
    inflater = zlib.decompressobj(wbits=31)
    out = bytearray()
    pending = data
    try:
        while pending:
            out += inflater.decompress(pending, limit + 1 - len(out))
            if len(out) > limit:
                raise RemoteSkillRefused("archive too large")
            pending = inflater.unconsumed_tail
        out += inflater.flush()
    except zlib.error as exc:
        raise RemoteSkillRefused("corrupt archive") from exc
    if len(out) > limit:
        raise RemoteSkillRefused("archive too large")
    if not inflater.eof:
        raise RemoteSkillRefused("corrupt archive")
    return bytes(out)


def unpack_archive(body: bytes) -> dict[str, bytes]:
    """A skill archive's files, in memory, after every safety check.

    A single top-level folder (``deploy-to-vercel/SKILL.md``) is stripped so the
    skill's root is its folder's root. Hidden files are dropped, never stored.
    """
    raw = _gunzip_bounded(body, MAX_REMOTE_SKILL_BYTES + _TAR_OVERHEAD) if body[:2] == _GZIP_MAGIC else body
    try:
        archive = tarfile.open(fileobj=io.BytesIO(raw), mode="r:")
    except tarfile.TarError as exc:
        raise RemoteSkillRefused("unsupported archive") from exc

    members: list[tuple[str, tarfile.TarInfo]] = []
    with archive:
        for member in archive.getmembers():
            if member.isdir():
                continue
            if not member.isfile():
                # Symlinks, hard links, devices, FIFOs: none belong in a skill,
                # and a link is how an archive reaches outside its own root.
                raise RemoteSkillRefused("archive contains a link or device")
            name = member.name
            while name.startswith("./"):
                name = name[2:]
            problem = check_rel_path(name)
            if problem:
                raise RemoteSkillRefused(problem)
            members.append((name, member))

        names = [name for name, _ in members]
        tops = {name.split("/", 1)[0] for name in names}
        if "SKILL.md" not in names and len(tops) == 1 and all("/" in name for name in names):
            prefix = next(iter(tops)) + "/"
            members = [(name[len(prefix):], member) for name, member in members]

        visible = [(name, member) for name, member in members if not is_hidden(name)]
        problem = check_file_set([(name, member.size) for name, member in visible])
        if problem:
            raise RemoteSkillRefused(problem)

        files: dict[str, bytes] = {}
        for name, member in visible:
            handle = archive.extractfile(member)
            if handle is None:
                raise RemoteSkillRefused("corrupt archive")
            data = handle.read(MAX_REMOTE_FILE_BYTES + 1)
            if len(data) != member.size:
                raise RemoteSkillRefused("corrupt archive")
            if name in files:
                raise RemoteSkillRefused("duplicate path in archive")
            files[name] = data
    return files


async def _fetch_github(
    store: SkillStore, client: RemoteSkillClient, source: RemoteSource, entry: dict[str, Any]
) -> dict[str, bytes]:
    manifest = await store.get_manifest(source.source_id, entry["skill_id"])
    if not manifest:
        raise RemoteSkillRefused("no file list")
    # The manifest is what the copy will be keyed by; if it no longer hashes to
    # the catalogue's ref, the two rows disagree and neither can be trusted.
    if content_ref_for(manifest) != entry["content_ref"]:
        raise RemoteSkillRefused("catalogue out of date")
    problem = check_file_set([(path, size) for path, _, size in manifest])
    if problem:
        raise RemoteSkillRefused(problem)

    repo, commit, base = source.repo or "", entry["source_ref"], entry["entry_path"]
    semaphore = asyncio.Semaphore(settings.remote_skills.fetch_concurrency)

    async def one(path: str, blob_sha: str, size: int) -> tuple[str, bytes]:
        async with semaphore:
            body = await client.raw(repo, commit, f"{base}/{path}", max_bytes=MAX_REMOTE_FILE_BYTES)
        if len(body) != size or git_blob_sha(body) != blob_sha:
            raise RemoteSkillRefused("checksum mismatch")
        return path, body

    pairs = await asyncio.gather(*(one(path, blob_sha, size) for path, blob_sha, size in manifest))
    return dict(pairs)


async def _fetch_well_known(client: RemoteSkillClient, entry: dict[str, Any]) -> dict[str, bytes]:
    url = entry.get("artifact_url") or ""
    is_archive = entry.get("artifact_type") == "archive"
    cap = MAX_REMOTE_SKILL_BYTES if is_archive else MAX_REMOTE_FILE_BYTES
    body = await client.get_bytes(url, max_bytes=cap)
    if "sha256:" + hashlib.sha256(body).hexdigest() != entry["source_ref"]:
        raise RemoteSkillRefused("checksum mismatch")
    return unpack_archive(body) if is_archive else {"SKILL.md": body}


async def fetch_remote_copy(
    store: SkillStore,
    client: RemoteSkillClient,
    source: RemoteSource,
    entry: dict[str, Any],
) -> RemoteFiles:
    """Download, verify and encode one skill for :meth:`SkillStore.add_remote`.

    Raises :class:`RemoteSkillRefused` when the content fails a check and
    :class:`RemoteSkillUnavailable` when the source cannot be read or the Add
    runs past its wall-clock ceiling. Either way nothing has been written.
    """
    try:
        async with asyncio.timeout(settings.remote_skills.add_timeout_seconds):
            if source.kind == "well-known":
                files = await _fetch_well_known(client, entry)
            else:
                files = await _fetch_github(store, client, source, entry)
    except TimeoutError as exc:
        raise RemoteSkillUnavailable("timed out") from exc
    except RemoteFetchError as exc:
        raise RemoteSkillUnavailable(exc.reason) from exc
    _validate(files, entry["skill_id"])
    return _encode(files)


__all__ = [
    "RemoteFiles",
    "RemoteSkillRefused",
    "RemoteSkillUnavailable",
    "fetch_remote_copy",
    "unpack_archive",
]
