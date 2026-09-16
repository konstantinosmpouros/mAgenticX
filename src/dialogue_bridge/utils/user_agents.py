"""User-authored agents — owned by ``chat_db``, materialised to the agents service.

A custom agent has **two** parts, split by who reads them:

* its **catalog row** in ``chat_db.agents``, carrying ``owner_user_id`` — the
  authority on ownership, the id the UI keys off, and the target of every
  conversation's foreign key. Read here on every page load, so it stays local;
* its **definition** — spec, ``AGENT.md``, sub-agent prompts, reference files —
  owned by the agents service in ``agent_runtime``, because that service reads
  it on every run.

There used to be a third: a copy of the definition in ``chat_db`` *and* a folder
on the agents volume, reconciled every 900 seconds. Both are gone; this module
proxies the definition rather than mirroring it, so there is nothing to keep in
step and no window where the two disagree.

Order on create/update: call the agents service **first**, because that call is
what validates the spec *and* persists it, then write the catalog row. Reads do not call
upstream at all — the row and its files answer them — so a slow or restarting
agents service no longer makes a user's own agents vanish from settings, and a
definition the volume alone holds is repaired by the sync pass rather than by a
read that happens to open it.

What is stored is the *submitted payload* (spec + uploaded files), not the
generated ``agent.yaml``: that file is derived from the spec by the agents
service, uploading it is explicitly rejected, and keeping the spec avoids giving
the bridge a YAML dependency it has no other reason to carry.

Delete is a **soft** delete of the row (``is_active=False``) plus removal of the
definition: ``agents.id`` is referenced by conversations with ``ON DELETE
CASCADE``, so hard-deleting the row would destroy the user's chat history.
Recreating the same slug later reuses (reactivates) the dormant row rather than
tripping the ``(owner_user_id, slug)`` uniqueness rule.
"""
from typing import Any, Dict, List, Optional
from uuid import uuid4

import httpx
from fastapi import HTTPException, status
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql import func

from core.database import AgentTable
from core.error_handling import upstream_error_handler
from core.security.internal_trust import internal_service_headers
from core.security.tls import get_httpx_client_cert, get_httpx_verify
from core.settings import settings
from core.logging import get_context, get_logger

logger = get_logger(__name__)

AGENTS_SERVICE_URL = settings.upstream.agents_service_url


def _base_url(user_id: str) -> str:
    return f"{AGENTS_SERVICE_URL.rstrip('/')}/users/{user_id}/custom-agents"


async def _proxy(
    method: str,
    url: str,
    *,
    operation: str,
    public_detail: str,
    json_body: Optional[Dict[str, Any]] = None,
    expect_json: bool = True,
) -> Any:
    """One upstream call to the agents service with the house error handling.

    Collapses the retry/HTTP-error/transport-error/invalid-JSON ladder that every
    proxy helper needs. A 4xx from upstream is forwarded with its ``detail``
    intact so the builder can show the real validation message rather than a
    generic failure.
    """
    timeout = settings.http.agents_timeout
    headers = internal_service_headers(get_context().get("request_id"))
    try:
        async with httpx.AsyncClient(
            timeout=timeout, verify=get_httpx_verify(), cert=get_httpx_client_cert()
        ) as client:
            resp = await upstream_error_handler.run_with_retries(
                logger,
                lambda: client.request(method, url, headers=headers, json=json_body),
                upstream_service="agents",
                operation=operation,
            )
            resp.raise_for_status()
    except httpx.HTTPStatusError as exc:
        upstream_error_handler.raise_http_error(
            logger, exc,
            event=f"{operation}_failed",
            message="Agents service returned an HTTP error for a custom-agent call",
            public_detail=public_detail,
            upstream_service="agents", operation=operation,
        )
    except httpx.RequestError as exc:
        upstream_error_handler.raise_request_error(
            logger, exc,
            event=f"{operation}_unreachable",
            message="Failed to reach the agents service for a custom-agent call",
            public_detail="Agent definitions are temporarily unavailable. Please try again shortly.",
            upstream_service="agents", operation=operation,
        )

    if not expect_json:
        return None
    try:
        return resp.json()
    except ValueError as exc:
        upstream_error_handler.raise_invalid_response(
            logger, exc,
            event=f"{operation}_invalid_json",
            message="Agents service returned invalid JSON for a custom-agent call",
            public_detail="Agent definitions returned an unexpected response.",
            upstream_service="agents", operation=operation,
        )


# ---------------------------------------------------------------------------
# Catalog row helpers
# ---------------------------------------------------------------------------
async def _row_for(db: AsyncSession, user_id: str, slug: str) -> Optional[AgentTable]:
    """This user's row for ``slug``, active or not (a dormant row is reused)."""
    result = await db.execute(
        select(AgentTable).where(
            AgentTable.owner_user_id == user_id, AgentTable.slug == slug
        )
    )
    return result.scalar_one_or_none()


async def _upsert_row(
    db: AsyncSession, user_id: str, summary: Dict[str, Any]
) -> AgentTable:
    """Create or refresh this user's catalog row from an agents-service summary.

    Flushes but does **not** commit: the caller writes the definition straight
    after, and the two must land as one transaction. Committing here left a
    window where the catalog row was current while the definition was still the
    previous version — the volume held the new files, ``chat_db`` the old ones,
    and a reconciliation pass that trusts ``chat_db`` would then revert the
    user's edit. The flush is still needed so the INSERT is emitted before
    ``agent_definition_files`` references it.
    """
    slug = str(summary.get("slug") or "")
    row = await _row_for(db, user_id, slug)
    name = str(summary.get("name") or slug)
    description = str(summary.get("description") or "")
    icon = str(summary.get("icon") or "")
    version = summary.get("version") or None

    if row is None:
        row = AgentTable(
            id=str(uuid4()),
            owner_user_id=user_id,
            slug=slug,
            name=name,
            description=description,
            icon=icon,
            version=version,
            type="deep agent",
            is_active=True,
        )
        db.add(row)
    else:
        row.name = name
        row.description = description
        row.icon = icon
        row.version = version
        row.type = "deep agent"
        row.is_active = True  # reactivates a previously deleted slug
        row.updated_at = func.now()
    await db.flush()
    return row


# ---------------------------------------------------------------------------
# Definition persistence — chat_db is the source of truth
# ---------------------------------------------------------------------------
# The agents-service volume has no backup, so a definition that lived only there
# died with it: the catalog row survived and pointed at nothing, leaving an agent
# that listed in the UI and failed at run time. These helpers keep the authored
# definition here; the volume is a materialised cache the agents service rebuilds.
#
# What is stored is the *submitted payload* — the spec plus the uploaded files —
# not the generated `agent.yaml`. That file is produced by the agents service
# from the spec (and uploading it is explicitly rejected), so the spec is the
# real input, and storing it keeps the bridge free of a YAML dependency.


def _summary_from_row(row: AgentTable) -> Dict[str, Any]:
    """The list-shape a client expects, assembled from the row alone."""
    return {
        "id": row.id,
        "slug": row.slug,
        "name": row.name,
        "description": row.description,
        "icon": row.icon,
        "version": row.version,
        "type": row.type,
    }


# ---------------------------------------------------------------------------
# Public surface
# ---------------------------------------------------------------------------
async def list_custom_agent_definitions(db: AsyncSession, user_id: str) -> List[Dict[str, Any]]:
    """This user's agents, straight from ``chat_db``.

    Used to join a catalog row against a summary fetched from the agents
    service. The row now carries everything the list needs, so the upstream hop
    is gone — and with it the failure mode where the agents service being slow
    or restarting made a user's own agents disappear from their settings.
    """
    result = await db.execute(
        select(AgentTable)
        .where(AgentTable.owner_user_id == user_id, AgentTable.is_active == True)
        .order_by(AgentTable.name)
    )
    return [_summary_from_row(row) for row in result.scalars().all()]


async def get_custom_agent_definition(
    db: AsyncSession, user_id: str, agent_id: str
) -> Dict[str, Any]:
    """One agent's full definition, keyed by its catalog id.

    The **catalog row** resolves the id to a slug and proves ownership, which is
    why this still takes a session; the **definition** comes from the agents
    service, which owns it in ``agent_runtime``. The two are joined here so the
    builder keeps receiving one object.

    The trade is deliberate: opening an agent in the builder now fails when the
    agents service is down, where it used to serve a possibly-stale local copy.
    A stale definition is worse than none — the user would edit one thing and
    save another.
    """
    row = await _require_owned_row(db, user_id, agent_id)
    detail = await _proxy("GET", f"{_base_url(user_id)}/{row.slug}", user_id=user_id)
    return {
        **_summary_from_row(row),
        "spec": (detail or {}).get("spec") or {},
        "files": (detail or {}).get("files") or [],
    }


async def adopt_definition(
    db: AsyncSession,
    user_id: str,
    *,
    slug: str,
    spec: Dict[str, Any],
    files: List[Dict[str, Any]],
) -> bool:
    """Take a definition the volume holds and ``chat_db`` does not.

The sync exchange's write-back path, and the only one left. It **creates**
    the catalog row as well as the definition, which is what the read-triggered
    adoption it replaced could never do: that path started from a row, so the
    orphan a half-failed create leaves — a folder no row points at — stayed
    invisible in the UI and un-recreatable behind the upstream 409.

    Refuses to revive a deleted agent: a dormant row is the tombstone that stops
    reconciliation resurrecting it, so a slug we hold as inactive is skipped
    rather than reactivated. Does not commit — the caller owns the transaction.
    """
    if not slug or not spec:
        return False
    existing = await _row_for(db, user_id, slug)
    if existing is not None and not existing.is_active:
        logger.info(
            "custom_agent_adopt_skipped_deleted",
            "Skipped adopting a slug this user has deleted",
            user_id=user_id,
            agent_slug=slug,
        )
        return False

    summary = {
        "slug": slug,
        "name": spec.get("name") or slug,
        "description": spec.get("description") or "",
        "icon": spec.get("icon") or "",
        "version": spec.get("version"),
    }
    row = await _upsert_row(db, user_id, summary)
    logger.info(
        "custom_agent_catalog_row_adopted",
        "Created a catalog row for an agent only the agents service knew about",
        agent_id=row.id,
        agent_slug=slug,
    )
    return True


async def validate_custom_agent_definition(
    user_id: str, payload: Dict[str, Any]
) -> Dict[str, Any]:
    """Dry run — report problems without writing anything."""
    return await _proxy(
        "POST", f"{_base_url(user_id)}/validate",
        operation="custom_agent_validate",
        public_detail="The agent definition could not be validated. Please try again.",
        json_body=payload,
    )


async def create_custom_agent(
    db: AsyncSession, user_id: str, payload: Dict[str, Any]
) -> AgentTable:
    """Write the definition, then the catalog row. Returns the row."""
    summary = await _proxy(
        "POST", _base_url(user_id),
        operation="custom_agent_create",
        public_detail="The agent could not be created. Please try again.",
        json_body=payload,
    )
    # Only the catalog row lands here. The definition was persisted by the call
    # above, in the database the agents service owns — which is also what
    # validated it, so there is no window where this side holds a definition
    # upstream has refused.
    row = await _upsert_row(db, user_id, summary or {})
    # `get_db` does not commit on close, so this is what makes the row durable.
    await db.commit()
    logger.info(
        "custom_agent_created",
        "Created a user-authored agent",
        agent_id=row.id,
        agent_slug=row.slug,
    )
    return row


async def update_custom_agent(
    db: AsyncSession, user_id: str, agent_id: str, payload: Dict[str, Any]
) -> AgentTable:
    """Replace an owned definition and refresh its catalog row."""
    row = await _require_owned_row(db, user_id, agent_id)
    summary = await _proxy(
        "PUT", f"{_base_url(user_id)}/{row.slug}",
        operation="custom_agent_update",
        public_detail="The agent could not be updated. Please try again.",
        json_body=payload,
    )
    updated = await _upsert_row(db, user_id, summary or {})
    await db.commit()
    logger.info(
        "custom_agent_updated",
        "Updated a user-authored agent",
        agent_id=updated.id,
        agent_slug=updated.slug,
    )
    return updated


async def delete_custom_agent(db: AsyncSession, user_id: str, agent_id: str) -> None:
    """Remove the definition and deactivate the row — never a hard delete.

    ``conversations.agent_id`` cascades on delete, so dropping the row would take
    the user's chat history with it. The dormant row also keeps the slug's
    identity, so recreating it later reuses the same row.
    """
    row = await _require_owned_row(db, user_id, agent_id)
    await _proxy(
        "DELETE", f"{_base_url(user_id)}/{row.slug}",
        operation="custom_agent_delete",
        public_detail="The agent could not be deleted. Please try again.",
        expect_json=False,
    )
    # The definition is already gone upstream. The row only *deactivates* (see
    # the docstring): conversations hold a foreign key to it, and a dormant row
    # is also what stops a stale write-back resurrecting a deleted agent.
    row.is_active = False
    row.updated_at = func.now()
    await db.commit()
    logger.info(
        "custom_agent_deleted",
        "Deleted a user-authored agent definition and deactivated its row",
        agent_id=agent_id,
        agent_slug=row.slug,
    )


async def _require_owned_row(db: AsyncSession, user_id: str, agent_id: str) -> AgentTable:
    """The caller's own agent row, or 404.

    Ownership is checked explicitly rather than inferred from the path: a 404
    (not 403) so an id belonging to someone else is indistinguishable from one
    that does not exist.
    """
    result = await db.execute(
        select(AgentTable).where(
            AgentTable.id == agent_id,
            AgentTable.owner_user_id == user_id,
            AgentTable.is_active == True,
        )
    )
    row = result.scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent not found.")
    return row


__all__ = [
    "create_custom_agent",
    "delete_custom_agent",
    "get_custom_agent_definition",
    "list_custom_agent_definitions",
    "update_custom_agent",
    "validate_custom_agent_definition",
]
