"""User-authored agents — proxy to the agents service + the catalog row.

A custom agent has two halves that must stay in step:

* its **definition**, a folder in the user's workspace on the agents service
  (``custom_agents/<slug>/agent.yaml`` + prompt files), which that service
  validates and writes; and
* its **catalog row** in ``agents`` here, carrying ``owner_user_id``, which is
  the authority on ownership and gives the agent the id the UI keys off.

Order of operations on create/update is deliberate: write the definition first,
then the row. If the row write fails the folder is orphaned but invisible (no row
⇒ the agent is never listed or resolvable), which is recoverable. The reverse
order would leave a row pointing at a definition that does not exist — an agent
the user can select and that then fails at run time.

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
from sqlalchemy import select
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
# Public surface
# ---------------------------------------------------------------------------
async def list_custom_agent_definitions(db: AsyncSession, user_id: str) -> List[Dict[str, Any]]:
    """This user's agents, joined: the definition summary + its catalog id.

    Driven by the catalog rows (the ownership authority), so a definition folder
    without a row is not listed.
    """
    result = await db.execute(
        select(AgentTable)
        .where(AgentTable.owner_user_id == user_id, AgentTable.is_active == True)  # noqa: E712
        .order_by(AgentTable.name)
    )
    rows = {row.slug: row for row in result.scalars().all()}
    if not rows:
        return []
    summaries = await _proxy(
        "GET", _base_url(user_id),
        operation="custom_agents_list",
        public_detail="Your agents could not be loaded. Please try again.",
    )
    out: List[Dict[str, Any]] = []
    for item in summaries or []:
        row = rows.get(str(item.get("slug") or ""))
        if row is None:
            continue
        out.append({**item, "id": row.id, "type": row.type})
    return out


async def get_custom_agent_definition(
    db: AsyncSession, user_id: str, agent_id: str
) -> Dict[str, Any]:
    """One agent's full definition, keyed by its catalog id."""
    row = await _require_owned_row(db, user_id, agent_id)
    detail = await _proxy(
        "GET", f"{_base_url(user_id)}/{row.slug}",
        operation="custom_agent_get",
        public_detail="That agent could not be loaded. Please try again.",
    )
    return {**detail, "id": row.id, "slug": row.slug, "type": row.type}


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
