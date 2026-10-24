"""The daily remote-skill sync: index the allowlisted sources into the catalogue.

What it costs is the design (plan 30, §2.2 measured it):

* **Did anything change?** Read the branch head from git's ref advertisement —
  plain HTTPS, no REST quota. Same commit as last time → the source is done.
* **Tree at the new commit:** one REST call. A truncated tree aborts that source
  and keeps its previous catalogue — the sync fails closed per source.
* **Read only what changed.** A skill whose ``SKILL.md`` (and LICENSE) blob SHA
  still matches is reused without a read. The first sync reads ~1,900 files; a
  quiet day reads none.
* **One transaction per source**, so a search never sees half a sync.

Sources are synced **one at a time** so peak memory is one parsed tree (~50 MB
for the largest), never several. Nothing here downloads skill *content*: that
happens only when a user presses Add (:mod:`.fetch`).
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import random
from collections import Counter
from dataclasses import dataclass, field
from typing import Any, Literal, Optional
from urllib.parse import urljoin

import httpx
import psycopg

from core.logging import get_logger
from core.settings import settings
from harness.memory.pool import get_memory_pool
from harness.skill_registry.remote.client import RemoteFetchError, RemoteSkillClient
from harness.skill_registry.remote.sources import (
    MAX_INDEX_BYTES,
    MAX_LICENCE_FILE_BYTES,
    MAX_REMOTE_FILE_BYTES,
    MAX_SKILL_DESCRIPTION_LENGTH,
    MAX_WELL_KNOWN_INDEX_BYTES,
    SOURCES,
    RemoteSource,
    check_file_set,
    check_skill_md,
    evaluate_licence,
    is_allowed_url,
    is_hidden,
    is_valid_skill_name,
    needs_licence_file,
    risk_refusal,
)
from harness.skill_registry.store import CatalogueEntry, SkillStore

logger = get_logger(__name__)

_SHA256_DIGEST_LEN = len("sha256:") + 64
_ARTIFACT_TYPES = frozenset({"archive", "skill-md"})

#: Refusals decided from the tree alone. They are recomputed on every pass;
#: only a refusal that needed a read is cached against the blob SHA.
_STRUCTURAL = frozenset({
    "invalid name", "contains a symlink", "contains a submodule", "too many files",
    "file too large", "skill too large", "unsafe path", "path too deep",
    "contains an executable", "no SKILL.md",
})


@dataclass
class SyncOutcome:
    """What one source's pass did — logged, and returned for the ops view."""

    source_id: str
    status: Literal["synced", "unchanged", "failed"]
    seen: int = 0
    admitted: int = 0
    reads: int = 0
    refused: Counter = field(default_factory=Counter)
    error: Optional[str] = None


def git_blob_sha(body: bytes) -> str:
    """The SHA-1 git itself names a blob by — what the tree lists per file."""
    return hashlib.sha1(b"blob %d\0" % len(body) + body, usedforsecurity=False).hexdigest()


def content_ref_for(manifest: list[tuple[str, str, int]]) -> str:
    """One hash naming a skill's exact content: every path with its blob SHA.

    Two commits that leave a skill untouched give the same ref, so its shared
    copy is stored once rather than once per upstream commit.
    """
    lines = "\n".join(f"{path}\0{blob_sha}" for path, blob_sha, _ in sorted(manifest))
    return hashlib.sha256(lines.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# GitHub sources
# ---------------------------------------------------------------------------
@dataclass
class _Candidate:
    skill_id: str
    nodes: list[tuple[str, dict[str, Any]]]
    category: str = ""
    index_description: str = ""
    risk: Optional[str] = None


def _group_tree(tree: list[dict[str, Any]], root: str) -> dict[str, list[tuple[str, dict[str, Any]]]]:
    """``skill_id → [(path relative to the skill folder, tree node)]`` under ``root``."""
    prefix = root.strip("/") + "/"
    grouped: dict[str, list[tuple[str, dict[str, Any]]]] = {}
    for node in tree:
        path = node.get("path")
        if not isinstance(path, str) or not path.startswith(prefix):
            continue
        skill_id, sep, rel = path[len(prefix):].partition("/")
        if sep and rel:
            grouped.setdefault(skill_id, []).append((rel, node))
    return grouped


def _structural_refusal(candidate: _Candidate, source: RemoteSource) -> Optional[str]:
    """Refusals the tree alone can decide — no read needed."""
    if not is_valid_skill_name(candidate.skill_id):
        return "invalid name"
    risk = risk_refusal(source, candidate.risk)
    if risk:
        return risk
    for rel, node in candidate.nodes:
        if node.get("type") == "commit":
            return "contains a submodule"
        if node.get("mode") == "120000":
            return "contains a symlink"
    files = [
        (rel, int(node.get("size") or 0))
        for rel, node in candidate.nodes
        if node.get("type") == "blob" and not is_hidden(rel)
    ]
    return check_file_set(files)


def _manifest(candidate: _Candidate) -> list[tuple[str, str, int]]:
    """The files an Add will fetch: visible blobs, with their SHA and size."""
    return sorted(
        (rel, str(node["sha"]), int(node.get("size") or 0))
        for rel, node in candidate.nodes
        if node.get("type") == "blob" and not is_hidden(rel)
    )


def _licence_node(candidate: _Candidate) -> Optional[tuple[str, dict[str, Any]]]:
    """The skill's own top-level LICENSE file, if it ships one."""
    for rel, node in sorted(candidate.nodes, key=lambda item: item[0]):
        upper = rel.upper()
        if "/" not in rel and (upper.startswith("LICENSE") or upper.startswith("LICENCE")):
            return rel, node
    return None


def _meta_sha(candidate: _Candidate) -> str:
    """What has to change for a skill's metadata to need re-reading."""
    skill_md = next(node["sha"] for rel, node in candidate.nodes if rel == "SKILL.md")
    licence = _licence_node(candidate)
    return f"{skill_md}+{licence[1]['sha']}" if licence else str(skill_md)


async def _read_verified(
    client: RemoteSkillClient, repo: str, commit: str, path: str, blob_sha: str, *, max_bytes: int
) -> bytes:
    """One file at the pinned commit, checked against the tree's SHA, retried once.

    A mismatch is not retried: it means the bytes are not what the commit
    says, and that is a refusal, not a hiccup.
    """
    try:
        body = await client.raw(repo, commit, path, max_bytes=max_bytes)
    except RemoteFetchError:
        body = await client.raw(repo, commit, path, max_bytes=max_bytes)
    if git_blob_sha(body) != blob_sha:
        raise RemoteFetchError("checksum mismatch", path)
    return body


async def _read_metadata(
    client: RemoteSkillClient,
    source: RemoteSource,
    commit: str,
    candidate: _Candidate,
) -> tuple[Optional[str], str, str, Optional[str], int]:
    """Read SKILL.md (and LICENSE when needed): ``(refusal, name, description, licence, reads)``."""
    repo = source.repo or ""
    base = f"{source.skills_root.strip('/')}/{candidate.skill_id}"
    skill_md_node = next(node for rel, node in candidate.nodes if rel == "SKILL.md")
    raw = await _read_verified(
        client, repo, commit, f"{base}/SKILL.md", skill_md_node["sha"], max_bytes=MAX_REMOTE_FILE_BYTES
    )
    reads = 1
    check = check_skill_md(raw, candidate.skill_id)
    if check.refusal:
        return check.refusal, check.name or candidate.skill_id, check.description, None, reads
    licence_text: Optional[str] = None
    licence = _licence_node(candidate)
    if needs_licence_file(check.declared_licence) and licence is not None:
        rel, node = licence
        body = await _read_verified(
            client, repo, commit, f"{base}/{rel}", node["sha"], max_bytes=MAX_LICENCE_FILE_BYTES
        )
        reads += 1
        licence_text = body.decode("utf-8", errors="replace")
    verdict = evaluate_licence(source, check.declared_licence, licence_text)
    refusal = None if verdict.admitted else verdict.reason
    return refusal, check.name, check.description, verdict.licence, reads


async def _index_candidates(
    client: RemoteSkillClient, source: RemoteSource, commit: str, tree: list[dict[str, Any]]
) -> tuple[list[_Candidate], Counter]:
    """Which folders count as skills for this source, with index metadata if any."""
    grouped = _group_tree(tree, source.skills_root)
    skipped: Counter = Counter()
    if source.kind == "github-tree":
        candidates = [
            _Candidate(skill_id, nodes)
            for skill_id, nodes in sorted(grouped.items())
            if any(rel == "SKILL.md" for rel, _ in nodes)
        ]
        return candidates, skipped

    # github-index: the publisher's index decides which folders are skills and
    # carries the risk label filtered on before anything is read.
    raw = await client.raw(source.repo or "", commit, source.index_path or "", max_bytes=MAX_INDEX_BYTES)
    try:
        index = json.loads(raw)
    except ValueError as exc:
        raise RemoteFetchError("malformed index", source.index_path or "") from exc
    items = index if isinstance(index, list) else list(index.values()) if isinstance(index, dict) else []
    prefix = source.skills_root.strip("/") + "/"
    candidates: list[_Candidate] = []
    seen: set[str] = set()
    for item in items:
        if not isinstance(item, dict) or not isinstance(item.get("path"), str):
            skipped["malformed index entry"] += 1
            continue
        path = item["path"].strip("/")
        if not path.startswith(prefix) or "/" in path[len(prefix):]:
            skipped["outside the skills folder"] += 1
            continue
        skill_id = path[len(prefix):]
        nodes = grouped.get(skill_id)
        if skill_id in seen or not nodes or not any(rel == "SKILL.md" for rel, _ in nodes):
            skipped["not in the tree"] += 1
            continue
        seen.add(skill_id)
        candidates.append(_Candidate(
            skill_id,
            nodes,
            category=str(item.get("category") or "")[:64],
            index_description=str(item.get("description") or ""),
            risk=str(item["risk"]) if item.get("risk") is not None else None,
        ))
    return candidates, skipped


async def _sync_github(
    store: SkillStore, client: RemoteSkillClient, source: RemoteSource, outcome: SyncOutcome
) -> None:
    repo = source.repo or ""
    commit = await client.head_commit(repo, source.branch)
    state = await store.get_source_state(source.source_id)
    if state and state.get("source_ref") == commit and not state.get("last_error"):
        outcome.status = "unchanged"
        return

    tree = await client.tree(repo, commit)
    candidates, skipped = await _index_candidates(client, source, commit, tree)
    outcome.refused.update(skipped)
    previous = await store.list_catalogue(source.source_id)

    entries: list[CatalogueEntry] = []
    manifests: dict[str, list[tuple[str, str, int]]] = {}
    to_read: list[tuple[_Candidate, list[tuple[str, str, int]], str]] = []
    for candidate in candidates:
        base_path = f"{source.skills_root.strip('/')}/{candidate.skill_id}"
        structural = _structural_refusal(candidate, source)
        if structural:
            entries.append(CatalogueEntry(
                skill_id=candidate.skill_id, name=candidate.skill_id, category=candidate.category,
                risk=candidate.risk, source_ref=commit, entry_path=base_path, refusal=structural,
            ))
            continue
        manifest = _manifest(candidate)
        meta_sha = _meta_sha(candidate)
        prior = previous.get(candidate.skill_id)
        if prior and prior.get("meta_sha") == meta_sha and prior.get("refusal") not in _STRUCTURAL:
            entry = CatalogueEntry(
                skill_id=candidate.skill_id, name=prior["name"], description=prior["description"] or "",
                category=candidate.category or prior.get("category") or "", licence=prior.get("licence"),
                risk=candidate.risk, source_ref=commit, entry_path=base_path, meta_sha=meta_sha,
                content_ref=content_ref_for(manifest), refusal=prior.get("refusal"),
            )
            entries.append(entry)
            if entry.refusal is None:
                manifests[candidate.skill_id] = manifest
            continue
        to_read.append((candidate, manifest, meta_sha))

    semaphore = asyncio.Semaphore(settings.remote_skills.fetch_concurrency)

    async def read_one(item: tuple[_Candidate, list[tuple[str, str, int]], str]) -> tuple[CatalogueEntry, int]:
        candidate, manifest, meta_sha = item
        async with semaphore:
            refusal, name, description, licence, reads = await _read_metadata(client, source, commit, candidate)
        return CatalogueEntry(
            skill_id=candidate.skill_id, name=name or candidate.skill_id,
            description=description or candidate.index_description[:MAX_SKILL_DESCRIPTION_LENGTH],
            category=candidate.category, licence=licence, risk=candidate.risk, source_ref=commit,
            entry_path=f"{source.skills_root.strip('/')}/{candidate.skill_id}", meta_sha=meta_sha,
            content_ref=content_ref_for(manifest), refusal=refusal,
        ), reads

    # Any read that still fails after its retry aborts the whole source: a
    # partial pass would withdraw or mis-label skills that merely timed out.
    results = await asyncio.gather(*(read_one(item) for item in to_read))
    manifest_by_id = {candidate.skill_id: manifest for candidate, manifest, _ in to_read}
    for entry, reads in results:
        outcome.reads += reads
        entries.append(entry)
        if entry.refusal is None:
            manifests[entry.skill_id] = manifest_by_id[entry.skill_id]

    await store.apply_source_sync(
        source.source_id, source_ref=commit, entries=entries, manifests=manifests
    )
    outcome.status = "synced"
    outcome.seen = len(entries)
    outcome.admitted = sum(1 for entry in entries if entry.refusal is None)
    outcome.refused.update(entry.refusal for entry in entries if entry.refusal)


# ---------------------------------------------------------------------------
# .well-known sources
# ---------------------------------------------------------------------------
def _well_known_entry(source: RemoteSource, item: Any) -> CatalogueEntry:
    """One discovery-index entry as a catalogue row, refused if it breaks a rule."""
    if not isinstance(item, dict):
        return CatalogueEntry(skill_id="", name="", refusal="malformed entry")
    name = str(item.get("name") or "")
    description = " ".join(str(item.get("description") or "").split())[:MAX_SKILL_DESCRIPTION_LENGTH]
    artifact_type = str(item.get("type") or "")
    digest = str(item.get("digest") or "").lower()
    raw_url = item.get("url")
    url = urljoin(source.index_url or "", raw_url) if isinstance(raw_url, str) else ""
    refusal: Optional[str] = None
    if not is_valid_skill_name(name):
        refusal = "invalid name"
    elif artifact_type not in _ARTIFACT_TYPES:
        refusal = "unsupported artifact"
    elif not (digest.startswith("sha256:") and len(digest) == _SHA256_DIGEST_LEN
              and all(c in "0123456789abcdef" for c in digest[7:])):
        refusal = "no sha256 digest"
    elif not url or not is_allowed_url(url):
        refusal = "host not allowed"
    return CatalogueEntry(
        skill_id=name, name=name, description=description, source_ref=digest,
        meta_sha=digest, content_ref=digest[7:], artifact_url=url or None,
        artifact_type=artifact_type or None, refusal=refusal,
    )


async def _sync_well_known(
    store: SkillStore, client: RemoteSkillClient, source: RemoteSource, outcome: SyncOutcome
) -> None:
    body = await client.get_bytes(source.index_url or "", max_bytes=MAX_WELL_KNOWN_INDEX_BYTES)
    index_ref = "sha256:" + hashlib.sha256(body).hexdigest()
    state = await store.get_source_state(source.source_id)
    if state and state.get("source_ref") == index_ref and not state.get("last_error"):
        outcome.status = "unchanged"
        return
    try:
        data = json.loads(body)
    except ValueError as exc:
        raise RemoteFetchError("malformed index", source.index_url or "") from exc
    items = data.get("skills") if isinstance(data, dict) else None
    if not isinstance(items, list):
        raise RemoteFetchError("malformed index", source.index_url or "")

    entries: list[CatalogueEntry] = []
    seen: set[str] = set()
    for item in items:
        entry = _well_known_entry(source, item)
        if not entry.skill_id or entry.skill_id in seen:
            outcome.refused["malformed or duplicate entry"] += 1
            continue
        seen.add(entry.skill_id)
        entries.append(entry)

    await store.apply_source_sync(
        source.source_id, source_ref=index_ref, entries=entries, manifests=None
    )
    outcome.status = "synced"
    outcome.seen = len(entries)
    outcome.admitted = sum(1 for entry in entries if entry.refusal is None)
    outcome.refused.update(entry.refusal for entry in entries if entry.refusal)


# ---------------------------------------------------------------------------
# Passes
# ---------------------------------------------------------------------------
async def sync_source(store: SkillStore, client: RemoteSkillClient, source: RemoteSource) -> SyncOutcome:
    """Sync one source. An upstream failure is recorded, never raised.

    The catalogue is untouched on failure — a source that cannot be read keeps
    serving its last good rows. Database errors *do* raise: they are not about
    this source and the pass should stop.
    """
    outcome = SyncOutcome(source_id=source.source_id, status="failed")
    try:
        if source.kind == "well-known":
            await _sync_well_known(store, client, source, outcome)
        else:
            await _sync_github(store, client, source, outcome)
    except RemoteFetchError as exc:
        outcome.error = exc.reason
        await store.record_source_error(source.source_id, exc.reason)
        logger.warning(
            "remote_skills_source_failed",
            "A remote skill source could not be synced; its previous catalogue is kept",
            source_id=source.source_id,
            reason=exc.reason,
        )
        return outcome
    logger.info(
        "remote_skills_source_synced",
        "Remote skill source synced",
        source_id=source.source_id,
        status=outcome.status,
        seen=outcome.seen,
        admitted=outcome.admitted,
        reads=outcome.reads,
        refused=dict(outcome.refused.most_common(8)),
    )
    return outcome


async def run_sync_pass(
    store: Optional[SkillStore] = None,
    transport: Optional[httpx.AsyncBaseTransport] = None,
) -> list[SyncOutcome]:
    """One pass over every source, under the advisory lock. ``[]`` if another holds it."""
    store = store or SkillStore(get_memory_pool())
    async with store.sync_lock() as taken:
        if not taken:
            logger.info("remote_skills_sync_skipped", "Another process holds the remote skill sync lock")
            return []
        async with RemoteSkillClient(transport) as client:
            # Sequential on purpose: peak memory is one parsed tree, not four.
            outcomes = [await sync_source(store, client, source) for source in SOURCES]
    logger.info(
        "remote_skills_sync_completed",
        "Remote skill sync pass completed",
        synced=sum(1 for o in outcomes if o.status == "synced"),
        unchanged=sum(1 for o in outcomes if o.status == "unchanged"),
        failed=sum(1 for o in outcomes if o.status == "failed"),
        admitted=sum(o.admitted for o in outcomes),
        reads=sum(o.reads for o in outcomes),
    )
    return outcomes


async def run_remote_skill_sync_loop() -> None:
    """The lifespan task: a pass shortly after boot, then one a day (± 10 %).

    Returns at once when ``REMOTE_SKILLS_ENABLED`` is false (the kill switch) —
    then no request leaves the service.
    A failed pass is logged and retried next interval; it never takes the
    service down.
    """
    cfg = settings.remote_skills
    if not cfg.enabled:
        logger.info("remote_skills_disabled", "Remote skill sources are disabled (REMOTE_SKILLS_ENABLED=false)")
        return
    logger.info(
        "remote_skills_sync_started",
        "Remote skill sync loop started",
        sources=len(SOURCES),
        interval_hours=cfg.sync_interval_hours,
        initial_delay_seconds=cfg.initial_delay_seconds,
    )
    await asyncio.sleep(cfg.initial_delay_seconds)
    while True:
        try:
            await run_sync_pass()
        except asyncio.CancelledError:
            raise
        except (psycopg.Error, OSError, RuntimeError) as exc:
            # A database or pool failure: nothing to do but try again later.
            # Upstream failures never reach here — sync_source records them.
            logger.error(
                "remote_skills_sync_failed",
                "Remote skill sync pass failed; will retry next interval",
                exc_info=True,
                error_type=type(exc).__name__,
            )
        await asyncio.sleep(cfg.sync_interval_hours * 3600 * random.uniform(0.9, 1.1))


__all__ = [
    "SyncOutcome",
    "content_ref_for",
    "git_blob_sha",
    "run_remote_skill_sync_loop",
    "run_sync_pass",
    "sync_source",
]
