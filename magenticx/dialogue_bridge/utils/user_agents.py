"""User-authored agents: the catalog row lives in ``chat_db``, the definition in the agents service.

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
what validates the spec *and* persists it, then write the catalog row. If the
row cannot be committed after a create, the new definition is deleted upstream
again (compensation), so a failed create never leaves a definition no row
points at — one the user could neither see nor recreate behind the duplicate-slug
409. The list reads the rows alone, so a slow or restarting agents service does
not make a user's own agents vanish; only the gallery's counts
(``include_summary``) and opening one agent's definition call upstream.

The bridge sends the spec as JSON and stores none of it. ``agent.yaml`` text
only passes through on **import** (forwarded for the agents service to parse),
**render** (a draft as text, for the builder's YAML view) and **export** (a zip
streamed back), so the bridge needs no YAML dependency.

Delete is a **soft** delete of the row (``is_active=False``) plus removal of the
definition: ``agents.id`` is referenced by conversations with ``ON DELETE
CASCADE``, so hard-deleting the row would destroy the user's chat history.
Recreating the same slug later reuses (reactivates) the dormant row rather than
tripping the ``(owner_user_id, slug)`` uniqueness rule.
"""
from collections.abc import Sequence
from typing import Any, Dict, Optional
from uuid import uuid4

import httpx
from fastapi import HTTPException, UploadFile, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql import func

from core.database import AgentTable
from core.error_handling import upstream_error_handler
from core.security.internal_trust import internal_service_headers
from core.security.tls import get_httpx_client_cert, get_httpx_verify
from core.settings import settings
from core.logging import get_context, get_logger
from utils.agent_import import build_import_payload

logger = get_logger(__name__)

AGENTS_SERVICE_URL = settings.upstream.agents_service_url

# Upstream statuses re-raised as themselves, with the agents service's
# ``detail``: a duplicate slug (409), the per-user cap (429), an invalid
# definition (422, whose detail is an object carrying ``issues``), and so on.
# Anything else becomes a 502 with the caller's public message.
_FORWARDED_STATUSES = frozenset({400, 404, 409, 413, 422, 429})

#: An export is the agent's files zipped, bounded upstream; this only stops a
#: misbehaving upstream from making the bridge buffer something unbounded.
_MAX_EXPORT_BYTES = 8 * 1024 * 1024

# Counts merged into the gallery rows, upstream name → wire name.
_SUMMARY_COUNTS = {
    "model": "model",
    "tool_count": "toolCount",
    "skill_count": "skillCount",
    "subagent_count": "subagentCount",
}


def _base_url(user_id: str) -> str:
    return f"{AGENTS_SERVICE_URL.rstrip('/')}/users/{user_id}/custom-agents"


async def _send(
    method: str,
    url: str,
    *,
    operation: str,
    public_detail: str,
    json_body: dict[str, Any] | None = None,
) -> httpx.Response:
    """One upstream call to the agents service with the house error handling.

    Collapses the retry/HTTP-error/transport-error ladder that every proxy
    helper needs. A 4xx listed in ``_FORWARDED_STATUSES`` is forwarded with its
    ``detail`` intact — a string, or the validation report object — so the
    builder can show the real reason rather than a generic failure.
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
            forward_statuses=_FORWARDED_STATUSES,
        )
    except httpx.RequestError as exc:
        upstream_error_handler.raise_request_error(
            logger, exc,
            event=f"{operation}_unreachable",
            message="Failed to reach the agents service for a custom-agent call",
            public_detail="Agent definitions are temporarily unavailable. Please try again shortly.",
            upstream_service="agents", operation=operation,
        )
    return resp


async def _proxy(
    method: str,
    url: str,
    *,
    operation: str,
    public_detail: str,
    json_body: Optional[Dict[str, Any]] = None,
    expect_json: bool = True,
) -> Any:
    """A JSON call to the agents service (see :func:`_send`); returns the body."""
    resp = await _send(
        method, url, operation=operation, public_detail=public_detail, json_body=json_body
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


async def _proxy_bytes(
    method: str,
    url: str,
    *,
    operation: str,
    public_detail: str,
    max_bytes: int,
) -> httpx.Response:
    """A binary call to the agents service (an export zip); returns the response
    so the caller can pass its ``Content-Type`` and ``Content-Disposition`` on."""
    resp = await _send(method, url, operation=operation, public_detail=public_detail)
    if len(resp.content) > max_bytes:
        upstream_error_handler.raise_invalid_response(
            logger,
            event=f"{operation}_too_large",
            message="Agents service returned a larger file than the bridge forwards",
            public_detail=public_detail,
            upstream_service="agents", operation=operation,
            size_bytes=len(resp.content),
        )
    return resp


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

    Flushes but does **not** commit: the caller owns the transaction, so a
    create can compensate upstream when the commit fails. The flush makes a
    constraint violation surface here, inside that guard, rather than at an
    implicit flush later.
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


def _summary_from_row(row: AgentTable) -> Dict[str, Any]:
    """The list-shape a client expects (``AgentPublic``), from the row alone."""
    return {
        "id": row.id,
        "slug": row.slug,
        "name": row.name or row.slug or "",
        "description": row.description or "",
        "icon": row.icon or "",
        "version": row.version,
        "type": row.type or "deep agent",
        "is_active": True,
        "kind": "custom",
    }


def _counts_from_summary(summary: dict[str, Any] | None) -> dict[str, Any]:
    """The gallery counts an agents-service summary carries, renamed for the
    wire. A field the summary lacks is left out (an older agents service)."""
    if not isinstance(summary, dict):
        return {}
    return {wire: summary[key] for key, wire in _SUMMARY_COUNTS.items() if summary.get(key) is not None}


def _public_from_row(row: AgentTable, summary: dict[str, Any] | None = None) -> dict[str, Any]:
    return {**_summary_from_row(row), **_counts_from_summary(summary)}


# ---------------------------------------------------------------------------
# Public surface
# ---------------------------------------------------------------------------
async def list_custom_agent_definitions(
    db: AsyncSession, user_id: str, *, include_summary: bool = False
) -> list[dict[str, Any]]:
    """This user's agents, from ``chat_db``.

    By default this never calls upstream: it runs on every page load, and the
    agents service being slow or restarting must not make a user's own agents
    disappear. ``include_summary`` (the gallery) adds each agent's model and
    tool/skill/sub-agent counts from **one** upstream list call, merged by slug.
    If that call fails the rows are returned without counts: the gallery
    degrades, it does not break.
    """
    result = await db.execute(
        select(AgentTable)
        .where(AgentTable.owner_user_id == user_id, AgentTable.is_active == True)
        .order_by(AgentTable.name)
    )
    items = [_summary_from_row(row) for row in result.scalars().all()]
    if not include_summary or not items:
        return items

    try:
        summaries = await _proxy(
            "GET", _base_url(user_id),
            operation="custom_agent_list",
            public_detail="Agent details could not be loaded.",
        )
    except HTTPException as exc:
        logger.warning(
            "custom_agent_summary_unavailable",
            "Listed custom agents without counts; the agents service list failed",
            status_code=exc.status_code,
            failure_reason="upstream_summary_unavailable",
        )
        return items
    if not isinstance(summaries, list):
        logger.warning(
            "custom_agent_summary_invalid_payload",
            "Listed custom agents without counts; the agents service list was not a list",
            payload_type=type(summaries).__name__,
        )
        return items

    by_slug = {str(s.get("slug")): s for s in summaries if isinstance(s, dict)}
    return [{**item, **_counts_from_summary(by_slug.get(item["slug"]))} for item in items]


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
    detail = await _proxy(
        "GET", f"{_base_url(user_id)}/{row.slug}",
        operation="custom_agent_get",
        public_detail="The agent could not be opened. Please try again.",
    )
    return {
        **_summary_from_row(row),
        "spec": (detail or {}).get("spec") or {},
        "files": (detail or {}).get("files") or [],
    }


async def validate_custom_agent_definition(
    user_id: str, payload: Dict[str, Any]
) -> Dict[str, Any]:
    """Dry run — report problems (``errors`` and field-level ``issues``) without writing."""
    return await _proxy(
        "POST", f"{_base_url(user_id)}/validate",
        operation="custom_agent_validate",
        public_detail="The agent definition could not be validated. Please try again.",
        json_body=payload,
    )


async def render_custom_agent_yaml(
    user_id: str, payload: Dict[str, Any]
) -> Dict[str, Any]:
    """A draft as ``agent.yaml`` (the builder's YAML view). Writes nothing.

    Stateless and keyed by the caller like validate: the draft need not be
    saved, so there is no catalog row to check — only the session's own user
    can ask, and the agents service renders exactly what it is sent.
    """
    return await _proxy(
        "POST", f"{_base_url(user_id)}/render",
        operation="custom_agent_render",
        public_detail="The agent could not be shown as YAML. Please try again.",
        json_body=payload,
    )


async def import_custom_agent(
    user_id: str, yaml_text: str | None, uploads: Sequence[UploadFile]
) -> dict[str, Any]:
    """Check an uploaded ``agent.yaml`` (+ files, or one ``.zip``). Saves nothing.

    The upload is unpacked and size-checked here (``utils.agent_import``), then
    the agents service parses and validates it. Its answer — ``valid``,
    ``issues``, the parsed ``spec`` and the ``files`` to send — goes back to
    the builder, which opens it as a draft; the later create is what saves it,
    and what refuses a slug the user already has.
    """
    body = await build_import_payload(yaml_text, uploads)
    result = await _proxy(
        "POST", f"{_base_url(user_id)}/import",
        operation="custom_agent_import",
        public_detail="The agent file could not be checked. Please try again.",
        json_body=body,
    )
    logger.info(
        "custom_agent_import_checked",
        "Checked an imported agent definition",
        file_count=len(body["files"]),
        valid=bool((result or {}).get("valid")),
    )
    return result


async def export_custom_agent(
    db: AsyncSession, user_id: str, agent_id: str
) -> dict[str, Any]:
    """An owned agent as a ``.zip`` (``agent.yaml`` + its files), from upstream.

    Returns ``content``, ``media_type`` and ``content_disposition`` (the
    upstream header, or one built from the slug) for the router to send.
    """
    row = await _require_owned_row(db, user_id, agent_id)
    resp = await _proxy_bytes(
        "GET", f"{_base_url(user_id)}/{row.slug}/export",
        operation="custom_agent_export",
        public_detail="The agent could not be exported. Please try again.",
        max_bytes=_MAX_EXPORT_BYTES,
    )
    logger.info(
        "custom_agent_exported",
        "Exported a user-authored agent",
        agent_id=row.id,
        agent_slug=row.slug,
        size_bytes=len(resp.content),
    )
    return {
        "content": resp.content,
        "media_type": resp.headers.get("content-type") or "application/zip",
        "content_disposition": resp.headers.get("content-disposition")
        or f'attachment; filename="{row.slug}.zip"',
    }


async def create_custom_agent(
    db: AsyncSession, user_id: str, payload: Dict[str, Any]
) -> dict[str, Any]:
    """Write the definition, then the catalog row. Returns the public row.

    If the row cannot be written after the definition was, the definition is
    deleted upstream again before the error is re-raised. Without that, the
    agents service would hold a definition no row points at: invisible in the
    UI, and the slug blocked by a 409 on every retry.
    """
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
    try:
        row = await _upsert_row(db, user_id, summary or {})
        # `get_db` does not commit on close, so this is what makes the row durable.
        await db.commit()
    except Exception:
        await db.rollback()
        await _compensate_create(user_id, str((summary or {}).get("slug") or ""))
        raise
    logger.info(
        "custom_agent_created",
        "Created a user-authored agent",
        agent_id=row.id,
        agent_slug=row.slug,
    )
    return _public_from_row(row, summary)


async def _compensate_create(user_id: str, slug: str) -> None:
    """Undo an upstream create whose catalog row failed. Best effort: the
    original error is what the caller sees, so a failure here is only logged."""
    if not slug:
        return
    try:
        await _proxy(
            "DELETE", f"{_base_url(user_id)}/{slug}",
            operation="custom_agent_create_compensate",
            public_detail="The agent could not be created. Please try again.",
            expect_json=False,
        )
    except HTTPException as exc:
        logger.error(
            "custom_agent_create_compensation_failed",
            "Could not delete an upstream definition after its catalog row failed",
            agent_slug=slug,
            status_code=exc.status_code,
            failure_reason="compensation_failed",
        )
        return
    logger.warning(
        "custom_agent_create_compensated",
        "Deleted the upstream definition of a create whose catalog row failed",
        agent_slug=slug,
    )


async def update_custom_agent(
    db: AsyncSession, user_id: str, agent_id: str, payload: Dict[str, Any]
) -> dict[str, Any]:
    """Replace an owned definition and refresh its catalog row. Returns the public row."""
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
    return _public_from_row(updated, summary)


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
    # the docstring): conversations hold a foreign key to it.
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
    "export_custom_agent",
    "get_custom_agent_definition",
    "import_custom_agent",
    "list_custom_agent_definitions",
    "update_custom_agent",
    "validate_custom_agent_definition",
]
