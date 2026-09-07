"""Reconcile this volume against ``chat_db``, in both directions.

``chat_db`` owns user-authored agents and skills; this volume is the copy the
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
from runtime.abstractions import AgentSpec
from runtime.abstractions.user_agents import (
    delete_user_agent,
    get_user_agent,
    list_user_agents,
    write_user_agent,
)
from runtime.filesystem import layout
from runtime.skill_registry.user_registry import (
    add_custom_to_user,
    add_global_to_user,
    assign_user_skill_to_agent,
    get_user_skill_detail,
    read_user_manifest,
    remove_from_user,
)
from schema import AgentFile, CustomSkillCreate, SkillFile
from utils.skills import list_user_agent_skills

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


def _skill_inventory(user_id: str) -> List[Dict[str, str]]:
    out: List[Dict[str, str]] = []
    for entry in read_user_manifest(user_id).skills:
        if entry.type == "global":
            # The catalogue owns the content; there is no per-user copy to hash.
            out.append({"name": entry.name, "type": "global", "hash": ""})
            continue
        try:
            detail = get_user_skill_detail(user_id, entry.name)
            files = [(f.path, f.content) for f in detail.files]
        except Exception:
            # A manifest row whose folder is unreadable. Report it with an empty
            # hash so the bridge treats it as diverged and rewrites it, rather
            # than dropping it from the inventory and having it look deleted.
            logger.warning(
                "workspace_sync_skill_unreadable",
                "Could not read a pool skill's files; reporting it as diverged",
                user_id=user_id,
                skill_name=entry.name,
                exc_info=True,
            )
            files = []
        out.append({"name": entry.name, "type": "custom", "hash": content_hash(files)})
    return out


def _assignment_inventory(user_id: str) -> Dict[str, List[str]]:
    """Enabled skills per agent, read from directory presence.

    Covers platform agents as well as authored ones: the pairing is meaningful
    for both, and the per-agent directory is the only record either has.
    """
    root = layout.user_agents_root(user_id)
    if not root.is_dir():
        return {}
    out: Dict[str, List[str]] = {}
    for entry in sorted(root.iterdir()):
        if not entry.is_dir():
            continue
        try:
            names = list_user_agent_skills(user_id, entry.name)
        except Exception:
            logger.warning(
                "workspace_sync_assignments_unreadable",
                "Could not read a (user, agent) skill directory",
                user_id=user_id,
                agent_slug=entry.name,
                exc_info=True,
            )
            continue
        if names:
            out[entry.name] = sorted(names)
    return out


def build_inventory(user_id: str) -> Dict[str, Any]:
    return {
        "agents": _agent_inventory(user_id),
        "skills": _skill_inventory(user_id),
        "assignments": _assignment_inventory(user_id),
    }


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


def _write_skill(user_id: str, item: Dict[str, Any], existing: set[str]) -> bool:
    name = str(item.get("name") or "").strip()
    if not name:
        return False
    if item.get("type") == "global":
        if name in existing:
            return False
        add_global_to_user(user_id, name)
        return True

    files = [
        SkillFile(path=f["path"], content=f.get("content") or "", encoding="utf-8")
        for f in item.get("files") or []
        if f.get("path")
    ]
    if not files:
        return False
    if name in existing:
        # add_custom_to_user refuses a name already in the pool, so a rewrite has
        # to replace the folder. Removing first also drops the assignment copies,
        # which the plan's assignment set restores on the same pass.
        remove_from_user(user_id, name)
    add_custom_to_user(
        user_id,
        CustomSkillCreate(
            name=name,
            description=str(item.get("description") or ""),
            category=item.get("category"),
            files=files,
        ),
        created_by_agent=item.get("createdByAgent"),
    )
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


def _remove_skill(user_id: str, name: str) -> bool:
    try:
        remove_from_user(user_id, name)
    except Exception:
        logger.warning(
            "workspace_sync_skill_remove_failed",
            "Could not remove a skill chat_db holds as deleted",
            user_id=user_id,
            skill_name=name,
            exc_info=True,
        )
        return False
    logger.info(
        "workspace_sync_skill_removed",
        "Removed a skill folder chat_db holds as deleted",
        user_id=user_id,
        skill_name=name,
    )
    return True


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


def _collect_skill_content(user_id: str, names: List[str]) -> List[Dict[str, Any]]:
    manifest = {e.name: e for e in read_user_manifest(user_id).skills}
    out: List[Dict[str, Any]] = []
    for name in names:
        entry = manifest.get(name)
        if entry is None or entry.type == "global":
            # A global has no per-user body to send; the bridge records
            # membership from the inventory alone.
            continue
        try:
            detail = get_user_skill_detail(user_id, name)
        except Exception:
            logger.warning(
                "workspace_sync_skill_content_unreadable",
                "Could not read a skill the bridge asked for",
                user_id=user_id,
                skill_name=name,
                exc_info=True,
            )
            continue
        out.append(
            {
                "name": name,
                "description": detail.description,
                "category": detail.category or None,
                "origin": getattr(entry, "origin", "user") or "user",
                "createdByAgent": getattr(entry, "created_by_agent", None),
                "files": [{"path": f.path, "content": f.content} for f in detail.files],
            }
        )
    return out


def _apply_assignments(user_id: str, assignments: Dict[str, List[str]]) -> int:
    """Make the per-agent skill directories match the authoritative set."""
    applied = 0
    for agent_slug, names in (assignments or {}).items():
        for name in names:
            try:
                assign_user_skill_to_agent(
                    user_id=user_id, agent_slug=agent_slug, skill_name=name
                )
                applied += 1
            except Exception:
                # Usually the skill is not in this volume's pool yet — the same
                # pass may be about to write it. Not fatal: the assignment row
                # survives in chat_db and the next pass retries.
                logger.warning(
                    "workspace_sync_assignment_skipped",
                    "Could not assign a skill during sync; will retry next pass",
                    user_id=user_id,
                    agent_slug=agent_slug,
                    skill_name=name,
                    exc_info=True,
                )
    return applied


# ---------------------------------------------------------------------------
# The exchange
# ---------------------------------------------------------------------------
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
        existing = {e.name for e in read_user_manifest(user_id).skills}
        written = sum(1 for a in plan.get("write_agents") or [] if _write_agent(user_id, a))
        for item in plan.get("write_skills") or []:
            if _write_skill(user_id, item, existing):
                existing.add(str(item.get("name") or ""))
                written += 1
        removed = sum(1 for s in plan.get("remove_agents") or [] if _remove_agent(user_id, s))
        removed += sum(1 for n in plan.get("remove_skills") or [] if _remove_skill(user_id, n))
        # Assignments last: a skill written above has to exist in the pool
        # before it can be copied into an agent's directory.
        _apply_assignments(user_id, plan.get("assignments") or {})
        return {"written": written, "removed": removed}

    counts = await asyncio.to_thread(_apply)

    send_agents = plan.get("send_agents") or []
    send_skills = plan.get("send_skills") or []
    sent = 0
    if send_agents or send_skills:
        payload = await asyncio.to_thread(
            lambda: {
                "agents": _collect_agent_content(user_id, send_agents),
                "skills": _collect_skill_content(user_id, send_skills),
            }
        )
        sent = len(payload["agents"]) + len(payload["skills"])
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


__all__ = ["sync_workspaces", "build_inventory", "content_hash", "GENERATED_MANIFEST"]
