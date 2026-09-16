"""Reconcile this volume against ``chat_db``, in both directions.

``chat_db`` owns user-authored agent definitions; this volume is the copy the
*runtime* reads. Normal operation keeps them in step because every save writes
both. This module handles everything operation does not cover, in one pass:

* **the volume is missing content** — a fresh container, a wiped volume, a second
  replica that has never seen this user;
* **``chat_db`` is missing content** — a create whose upstream call succeeded and
  whose persist failed, leaving a folder no row points at. That state is
  invisible in the UI and un-recreatable (the create returns 409), and no read
  path can reach it, because every adoption path is triggered *from a row*;
* **a deletion that only half landed** — the row carries a tombstone and the
  folder is still here.

Replaces the one-way hydrator. The exchange is two calls: an inventory of names
and hashes, then the bodies for whatever the reply asks for. Bodies move only
when something actually differs, so a settled workspace costs two small
requests.

The bridge owns the comparison — it has the database and the authority. This
side reports what it sees and applies what it is told, which keeps schema
knowledge out of here and filesystem knowledge out of the bridge.
"""
from __future__ import annotations

import asyncio
import hashlib
from typing import Any, Dict, Iterable, List, Tuple

import httpx

from core.logging import get_logger
from core.security.internal_trust import internal_service_headers
from core.security.tls import get_httpx_client_cert, get_httpx_verify
from core.settings import settings
from harness.abstractions import AgentSpec
from harness.abstractions.user_agents import (
    delete_user_agent,
    get_user_agent,
    list_user_agents,
    write_user_agent,
)
from harness.filesystem import layout
from schema import AgentFile

logger = get_logger(__name__)

# The bridge never stores `agent.yaml` — it is generated here from the spec and
# uploading one is rejected — so it must be left out of the hash on both sides
# or every comparison mismatches. `get_user_agent` already excludes it from the
# file list; this constant exists so the coupling is named rather than implied.
# Mirrors GENERATED_MANIFEST in dialogue_bridge/utils/workspace_sync.py.
GENERATED_MANIFEST = "agent.yaml"


def content_hash(files: Iterable[Tuple[str, str]]) -> str:
    """Stable digest of an authored file set.

    Byte-for-byte identical to the bridge's helper: sorted by path, newlines
    normalised. An unstable hash does not fail loudly — it just makes every pass
    rewrite every file.
    """
    digest = hashlib.sha256()
    for path, content in sorted(files):
        digest.update(path.encode("utf-8"))
        digest.update(b"\0")
        digest.update((content or "").replace("\r\n", "\n").encode("utf-8"))
        digest.update(b"\0")
    return digest.hexdigest()


# ---------------------------------------------------------------------------
# Reading this volume
# ---------------------------------------------------------------------------
def _volume_user_ids() -> List[str]:
    """Every user with a workspace directory here.

    Unioned with the bridge's list rather than replaced by it: a user whose
    content exists *only* on this volume is by definition absent from
    ``chat_db``, and syncing only what the bridge names would leave exactly the
    orphans this pass exists to find.
    """
    root = layout.users_root()
    if not root.is_dir():
        return []
    return sorted(entry.name for entry in root.iterdir() if entry.is_dir())


def _agent_inventory(user_id: str) -> List[Dict[str, str]]:
    out: List[Dict[str, str]] = []
    for summary in list_user_agents(user_id):
        detail = get_user_agent(user_id, summary.slug)
        files = [] if detail is None else [(f.path, f.content) for f in detail.files]
        out.append({"slug": summary.slug, "hash": content_hash(files)})
    return out


def build_inventory(user_id: str) -> Dict[str, Any]:
    # Skills and their per-agent assignments live in `agent_runtime` with one
    # copy, so there is nothing on this volume to inventory for them any more.
    return {"agents": _agent_inventory(user_id)}


# ---------------------------------------------------------------------------
# Applying a plan
# ---------------------------------------------------------------------------
def _write_agent(user_id: str, item: Dict[str, Any]) -> bool:
    try:
        spec = AgentSpec.model_validate(item.get("spec") or {})
    except Exception:
        # A spec chat_db holds that this build cannot parse (an older shape, a
        # model since removed). Skip it rather than failing the whole user — the
        # definition is still safe in Postgres.
        logger.warning(
            "workspace_sync_spec_invalid",
            "Stored agent spec did not validate against this build; skipping",
            user_id=user_id,
            agent_slug=str(item.get("slug") or ""),
        )
        return False
    files = [
        AgentFile(path=f["path"], content=f.get("content") or "", encoding="utf-8")
        for f in item.get("files") or []
        if f.get("path")
    ]
    write_user_agent(user_id, spec, files)
    return True


def _remove_agent(user_id: str, slug: str) -> bool:
    """Finish a deletion whose volume half never landed."""
    removed = delete_user_agent(user_id, slug)
    if removed:
        logger.info(
            "workspace_sync_agent_removed",
            "Removed an agent folder chat_db holds as deleted",
            user_id=user_id,
            agent_slug=slug,
        )
    return removed


def _collect_agent_content(user_id: str, slugs: List[str]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for slug in slugs:
        detail = get_user_agent(user_id, slug)
        if detail is None:
            continue
        out.append(
            {
                "slug": slug,
                "spec": detail.spec,
                "files": [{"path": f.path, "content": f.content} for f in detail.files],
            }
        )
    return out


def _base_url() -> str:
    return settings.bridge.base_url.rstrip("/")


async def _sync_user(client: httpx.AsyncClient, user_id: str) -> Dict[str, int]:
    headers = internal_service_headers(None)
    inventory = await asyncio.to_thread(build_inventory, user_id)

    resp = await client.post(
        f"{_base_url()}/v1/internal/sync/{user_id}/inventory",
        headers=headers,
        json=inventory,
    )
    resp.raise_for_status()
    plan = resp.json()

    def _apply() -> Dict[str, int]:
        written = sum(1 for a in plan.get("write_agents") or [] if _write_agent(user_id, a))
        removed = sum(1 for s in plan.get("remove_agents") or [] if _remove_agent(user_id, s))
        return {"written": written, "removed": removed}

    counts = await asyncio.to_thread(_apply)

    send_agents = plan.get("send_agents") or []
    sent = 0
    if send_agents:
        payload = await asyncio.to_thread(
            lambda: {"agents": _collect_agent_content(user_id, send_agents)}
        )
        sent = len(payload["agents"])
        if sent:
            reply = await client.post(
                f"{_base_url()}/v1/internal/sync/{user_id}/content",
                headers=headers,
                json=payload,
            )
            reply.raise_for_status()

    counts["sent"] = sent
    return counts


async def _run_pass(client: httpx.AsyncClient, stop_event: asyncio.Event) -> None:
    resp = await client.get(
        f"{_base_url()}/v1/internal/sync/users", headers=internal_service_headers(None)
    )
    resp.raise_for_status()
    from_db = {str(u) for u in resp.json() or []}
    from_volume = set(await asyncio.to_thread(_volume_user_ids))

    totals = {"written": 0, "removed": 0, "sent": 0}
    user_ids = sorted(from_db | from_volume)
    for user_id in user_ids:
        if stop_event.is_set():
            return
        try:
            counts = await _sync_user(client, user_id)
            for key, value in counts.items():
                totals[key] += value
        except Exception:
            logger.warning(
                "workspace_sync_user_failed",
                "Could not sync one user's workspace; continuing",
                user_id=user_id,
                exc_info=True,
            )

    logger.info(
        "workspace_sync_completed",
        "Workspace sync pass completed",
        user_count=len(user_ids),
        volume_only_users=len(from_volume - from_db),
        written=totals["written"],
        removed=totals["removed"],
        sent=totals["sent"],
    )


async def sync_workspaces(stop_event: asyncio.Event) -> None:
    """Run the reconciliation at boot, then on an interval until shutdown.

    The first pass retries with backoff: compose declares
    ``dialogue_bridge depends_on: agents``, so this service ALWAYS starts first
    and the bridge is normally still coming up. The reverse edge cannot be added
    without creating a dependency cycle, so the wait lives here.

    Runs as a background task — a bridge that is slow or restarting must not
    hold up serving, and an unsynced volume is a recoverable state the next pass
    fixes.
    """
    if not settings.bridge.sync_on_startup:
        logger.info("workspace_sync_disabled", "Workspace sync disabled via settings")
        return

    timeout = httpx.Timeout(
        settings.bridge.sync_request_timeout_seconds,
        connect=settings.bridge.connect_timeout_seconds,
    )
    delay = settings.bridge.sync_retry_seconds
    attempt = 0
    started = False

    while not stop_event.is_set():
        try:
            async with httpx.AsyncClient(
                timeout=timeout, verify=get_httpx_verify(), cert=get_httpx_client_cert()
            ) as client:
                await _run_pass(client, stop_event)
            started = True
            attempt = 0
            delay = settings.bridge.sync_retry_seconds
        except Exception:
            attempt += 1
            if not started and attempt >= settings.bridge.sync_max_attempts:
                logger.error(
                    "workspace_sync_gave_up",
                    "Workspace sync never completed a first pass; the volume may be out of step",
                    attempts=attempt,
                )
                return
            logger.warning(
                "workspace_sync_attempt_failed",
                "Workspace sync pass failed; will retry",
                attempt=attempt,
                started_before=started,
            )
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=delay)
                return
            except asyncio.TimeoutError:
                delay = min(delay * 2, 60.0)
                continue

        # Settled. Wait out the interval, or exit promptly on shutdown.
        try:
            await asyncio.wait_for(
                stop_event.wait(), timeout=settings.bridge.sync_interval_seconds
            )
            return
        except asyncio.TimeoutError:
            continue


__all__ = ["GENERATED_MANIFEST", "build_inventory", "content_hash", "sync_workspaces"]
