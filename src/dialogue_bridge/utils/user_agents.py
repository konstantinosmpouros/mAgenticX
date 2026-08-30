"""User-authored agents — owned by ``chat_db``, materialised to the agents service.

A custom agent has three parts:

* its **catalog row** in ``agents``, carrying ``owner_user_id`` — the authority
  on ownership and the id the UI keys off;
* its **definition**, now stored here as ``agents.definition_spec`` plus
  ``agent_definition_files``; and
* a **materialised copy** on the agents-service volume
  (``custom_agents/<slug>/agent.yaml`` + prompt files), which that service
  generates, validates and loads at run time.

Postgres is the source of truth. The volume used to be the *only* copy, and it
has no backup: losing it left the row pointing at nothing — an agent that listed
in the UI and failed at run time. The volume is now a cache the agents service
rebuilds from these rows on boot.

Order on create/update: call the agents service **first**, because that call is
what validates the spec, then persist. Persisting first would admit an invalid
definition that the hydrator would keep trying to write. Reads do not call
upstream at all — the row and its files answer them — so a slow or restarting
agents service no longer makes a user's own agents vanish from settings.

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

from core.database import AgentDefinitionFileTable, AgentTable
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
    """Create or refresh this user's catalog row from an agents-service summary."""
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
    await db.commit()
    await db.refresh(row)
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


async def _store_definition(
    db: AsyncSession, agent_id: str, payload: Dict[str, Any]
) -> None:
    """Replace this agent's stored definition with the submitted payload.

    Replace, never merge: a save rewrites the whole agent folder upstream, so
    any file the user did not re-send is deleted there. Merging here would leave
    Postgres holding files the volume no longer has.
    """
    await db.execute(
        delete(AgentDefinitionFileTable).where(AgentDefinitionFileTable.agent_id == agent_id)
    )
    for item in payload.get("files") or []:
        path = str(item.get("path") or "").strip()
        if not path:
            continue
        db.add(
            AgentDefinitionFileTable(
                agent_id=agent_id, path=path, content=str(item.get("content") or "")
            )
        )


async def _load_definition_files(db: AsyncSession, agent_id: str) -> List[Dict[str, Any]]:
    """The stored files, in a stable order so an edit round-trip is diffable."""
    result = await db.execute(
        select(AgentDefinitionFileTable)
        .where(AgentDefinitionFileTable.agent_id == agent_id)
        .order_by(AgentDefinitionFileTable.path)
    )
    return [
        {"path": row.path, "content": row.content, "encoding": "utf-8"}
        for row in result.scalars().all()
    ]


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
        .where(AgentTable.owner_user_id == user_id, AgentTable.is_active == True)  # noqa: E712
        .order_by(AgentTable.name)
    )
    return [_summary_from_row(row) for row in result.scalars().all()]


async def get_custom_agent_definition(
    db: AsyncSession, user_id: str, agent_id: str
) -> Dict[str, Any]:
    """One agent's full definition, keyed by its catalog id.

    Assembled here rather than fetched: the spec is on the row and the files are
    in ``agent_definition_files``, so opening an agent in the builder no longer
    depends on the agents service being reachable.
    """
    row = await _require_owned_row(db, user_id, agent_id)
    files = await _load_definition_files(db, row.id)
    if not row.definition_spec and not files:
        # Pre-dates this store: the definition exists only on the volume. Fetch
        # it once and adopt it, so the migration is lazy and self-healing rather
        # than a boot pass someone has to remember to run. Without this the
        # builder would open an empty form and the next save would wipe a
        # definition the user still has.
        adopted = await _adopt_definition_from_upstream(db, row)
        if adopted is not None:
            return adopted
    return {
        **_summary_from_row(row),
        "spec": row.definition_spec or {},
        "files": files,
    }


async def _adopt_definition_from_upstream(
    db: AsyncSession, row: AgentTable
) -> Optional[Dict[str, Any]]:
    """Pull a pre-existing definition off the volume into ``chat_db``.

    Returns the detail payload, or None when upstream has nothing to give — an
    agent whose folder is genuinely gone still opens (empty) rather than 500ing,
    which is the honest outcome: the row survived and the definition did not.
    """
    try:
        detail = await _proxy(
            "GET", f"{_base_url(row.owner_user_id)}/{row.slug}",
            operation="custom_agent_adopt",
            public_detail="That agent could not be loaded. Please try again.",
        )
    except HTTPException:
        # Upstream said no. Do not fail the read — the caller gets the row's own
        # (empty) definition and can re-author it.
        logger.warning(
            "custom_agent_adopt_failed",
            "Could not read a pre-existing definition from the agents service",
            agent_id=row.id,
            agent_slug=row.slug,
        )
        return None

    payload = {"spec": detail.get("spec") or {}, "files": detail.get("files") or []}
    if not payload["spec"] and not payload["files"]:
        return None

    row.definition_spec = payload["spec"]
    await _store_definition(db, row.id, payload)
    await db.commit()
    logger.info(
        "custom_agent_definition_adopted",
        "Adopted a volume-only agent definition into chat_db",
        agent_id=row.id,
        agent_slug=row.slug,
        file_count=len(payload["files"]),
    )
    return {
        **_summary_from_row(row),
        "spec": payload["spec"],
        "files": await _load_definition_files(db, row.id),
    }


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
    row = await _upsert_row(db, user_id, summary or {})
    # Store the authored definition beside the row. Done after the upstream call
    # because that call is what validates the spec — persisting first would let
    # an invalid definition into chat_db, and the hydrator would then keep
    # rewriting a folder the agents service refuses.
    row.definition_spec = payload.get("spec") or {}
    await _store_definition(db, row.id, payload)
    # `_upsert_row` already committed the catalog row; these are a second unit
    # of work and `get_db` does not commit on close, so without this the
    # definition is silently discarded and only the volume copy survives.
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
    updated.definition_spec = payload.get("spec") or {}
    await _store_definition(db, updated.id, payload)
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
    row.is_active = False
    row.updated_at = func.now()
    # The definition is gone upstream, so drop the stored copy too — keeping it
    # would leave the hydrator able to resurrect a deleted agent's folder. The
    # row itself only deactivates (see the docstring).
    await db.execute(
        delete(AgentDefinitionFileTable).where(AgentDefinitionFileTable.agent_id == row.id)
    )
    row.definition_spec = None
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
            AgentTable.is_active == True,  # noqa: E712
        )
    )
    row = result.scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent not found.")
    return row


__all__ = [
    "list_custom_agent_definitions",
    "get_custom_agent_definition",
    "validate_custom_agent_definition",
    "create_custom_agent",
    "update_custom_agent",
    "delete_custom_agent",
]
