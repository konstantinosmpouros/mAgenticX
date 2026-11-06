"""Workflow definitions (plan 38): a thin, validated proxy to the agents service.

The agents service owns workflow specs (``agent_runtime``) and the engine that
runs them; the bridge stores none of a definition. Every call here goes out
with the internal-trust headers, scoped to the **session's** user id as
``owner_user_id`` — the router has already tied the path user to the session,
so a caller can only ever reach their own workflows (someone else's id is a 404
from upstream, indistinguishable from a missing one).

Upstream 4xx answers that carry a meaningful reason (an invalid spec, a missing
workflow, a cap) are forwarded with their ``detail``; anything else becomes a
502/503 with a generic message. Every JSON body coming back is validated
against the bridge's own schemas before it is returned.

Version history (list, one version, restore) is proxied the same way; a
restore is a save upstream (a new version with the old spec), so the router
re-syncs the schedule from its answer like after any save.

Run history is not here: see :mod:`utils.workflow_runs`.
"""
from typing import Any, NoReturn
from urllib.parse import quote

import httpx
from pydantic import TypeAdapter, ValidationError

from core.error_handling import upstream_error_handler
from core.logging import get_context, get_logger
from core.security.internal_trust import internal_service_headers
from core.security.tls import get_httpx_client_cert, get_httpx_verify
from core.settings import settings
from schema import WorkflowOut, WorkflowValidation, WorkflowVersionDetailOut, WorkflowVersionPage

logger = get_logger(__name__)

# Re-raised as themselves with the upstream ``detail``; anything else is a 502.
_FORWARDED_STATUSES = frozenset({400, 404, 409, 413, 422, 429})

_WORKFLOW = TypeAdapter(WorkflowOut)
_WORKFLOW_LIST = TypeAdapter(list[WorkflowOut])
_VALIDATION = TypeAdapter(WorkflowValidation)
_VERSION_PAGE = TypeAdapter(WorkflowVersionPage)
_VERSION = TypeAdapter(WorkflowVersionDetailOut)


def workflows_base_url() -> str:
    """The agents service's ``/workflows`` root."""
    return f"{settings.upstream.agents_service_url.rstrip('/')}/workflows"


def _owner_url(user_id: str, workflow_id: str | None = None) -> str:
    # Path segments are percent-encoded so an id can never step into another
    # upstream route; the router also restricts their alphabet.
    url = f"{workflows_base_url()}/{quote(user_id, safe='')}"
    return url if workflow_id is None else f"{url}/{quote(workflow_id, safe='')}"


async def _call(
    method: str,
    url: str,
    *,
    operation: str,
    public_detail: str,
    json_body: dict[str, Any] | None = None,
    expect_json: bool = True,
) -> Any:
    """One upstream call with the house retry and error mapping; returns the
    parsed JSON body (or ``None`` when ``expect_json`` is false)."""
    headers = internal_service_headers(get_context().get("request_id"))
    try:
        async with httpx.AsyncClient(
            timeout=settings.http.agents_timeout, verify=get_httpx_verify(), cert=get_httpx_client_cert()
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
            message="Agents service returned an HTTP error for a workflow call",
            public_detail=public_detail,
            upstream_service="agents", operation=operation,
            forward_statuses=_FORWARDED_STATUSES,
        )
    except httpx.RequestError as exc:
        upstream_error_handler.raise_request_error(
            logger, exc,
            event=f"{operation}_unreachable",
            message="Failed to reach the agents service for a workflow call",
            public_detail="Workflows are temporarily unavailable. Please try again shortly.",
            upstream_service="agents", operation=operation,
        )
    if not expect_json:
        return None
    try:
        return resp.json()
    except ValueError as exc:
        _invalid(exc, operation, public_detail)


def _invalid(exc: Exception | None, operation: str, public_detail: str) -> NoReturn:
    upstream_error_handler.raise_invalid_response(
        logger, exc,
        event=f"{operation}_invalid_response",
        message="Agents service returned an unexpected body for a workflow call",
        public_detail=public_detail,
        upstream_service="agents", operation=operation,
    )


def _validated(adapter: TypeAdapter, body: Any, operation: str, public_detail: str) -> Any:
    """Output validation: an upstream body that does not match is a 502."""
    try:
        return adapter.validate_python(body)
    except ValidationError as exc:
        _invalid(exc, operation, public_detail)


async def get_workflow_catalog() -> dict[str, Any] | list[Any]:
    """The node kinds the builder offers, with their JSON Schemas.

    Passed through as JSON (its shape belongs to the engine); only its type is
    checked here.
    """
    detail = "The workflow catalog is unavailable."
    body = await _call("GET", f"{workflows_base_url()}/catalog", operation="workflow_catalog", public_detail=detail)
    if not isinstance(body, (dict, list)):
        _invalid(None, "workflow_catalog", detail)
    return body


async def validate_workflow_spec(spec: dict[str, Any]) -> WorkflowValidation:
    """Dry-run a spec so the builder can show every problem before saving."""
    detail = "The workflow could not be validated."
    body = await _call(
        "POST", f"{workflows_base_url()}/validate",
        operation="workflow_validate", public_detail=detail, json_body={"spec": spec},
    )
    return _validated(_VALIDATION, body, "workflow_validate", detail)


async def list_workflows(user_id: str) -> list[WorkflowOut]:
    """The caller's workflows."""
    detail = "Your workflows could not be loaded."
    body = await _call("GET", _owner_url(user_id), operation="workflow_list", public_detail=detail)
    # Accept a bare list or an ``{"items": [...]}`` envelope.
    if isinstance(body, dict) and "items" in body:
        body = body["items"]
    return _validated(_WORKFLOW_LIST, body, "workflow_list", detail)


async def create_workflow(user_id: str, spec: dict[str, Any]) -> WorkflowOut:
    """Create a workflow from a spec (validated and stored upstream)."""
    detail = "The workflow could not be created."
    body = await _call(
        "POST", _owner_url(user_id), operation="workflow_create", public_detail=detail, json_body={"spec": spec}
    )
    return _validated(_WORKFLOW, body, "workflow_create", detail)


async def get_workflow(user_id: str, workflow_id: str) -> WorkflowOut:
    """One of the caller's workflows (404 when it is not theirs or not there)."""
    detail = "The workflow could not be loaded."
    body = await _call("GET", _owner_url(user_id, workflow_id), operation="workflow_get", public_detail=detail)
    return _validated(_WORKFLOW, body, "workflow_get", detail)


async def update_workflow(user_id: str, workflow_id: str, spec: dict[str, Any]) -> WorkflowOut:
    """Replace a workflow's spec."""
    detail = "The workflow could not be saved."
    body = await _call(
        "PUT", _owner_url(user_id, workflow_id),
        operation="workflow_update", public_detail=detail, json_body={"spec": spec},
    )
    return _validated(_WORKFLOW, body, "workflow_update", detail)


async def delete_workflow(user_id: str, workflow_id: str) -> None:
    """Delete a workflow upstream. Its run history is the caller's to delete
    (:func:`utils.workflow_runs.delete_runs_for_workflow`)."""
    await _call(
        "DELETE", _owner_url(user_id, workflow_id),
        operation="workflow_delete", public_detail="The workflow could not be deleted.", expect_json=False,
    )


def _version_url(user_id: str, workflow_id: str, version_no: int | None = None) -> str:
    url = f"{_owner_url(user_id, workflow_id)}/versions"
    return url if version_no is None else f"{url}/{int(version_no)}"


async def list_workflow_versions(
    user_id: str, workflow_id: str, *, limit: int, before: int | None
) -> WorkflowVersionPage:
    """One page of a workflow's kept versions, newest first."""
    detail = "The workflow's history could not be loaded."
    query = f"?limit={int(limit)}" + (f"&before={int(before)}" if before is not None else "")
    body = await _call(
        "GET", f"{_version_url(user_id, workflow_id)}{query}",
        operation="workflow_versions_list", public_detail=detail,
    )
    return _validated(_VERSION_PAGE, body, "workflow_versions_list", detail)


async def get_workflow_version(user_id: str, workflow_id: str, version_no: int) -> WorkflowVersionDetailOut:
    """One kept version with its spec (404 when it is not the caller's or not there)."""
    detail = "That version could not be loaded."
    body = await _call(
        "GET", _version_url(user_id, workflow_id, version_no),
        operation="workflow_version_get", public_detail=detail,
    )
    return _validated(_VERSION, body, "workflow_version_get", detail)


async def restore_workflow_version(user_id: str, workflow_id: str, version_no: int) -> WorkflowOut:
    """Save an old version's spec as the newest version (422 with the issues
    when it no longer validates); the answer is the workflow as after a save."""
    detail = "That version could not be restored."
    body = await _call(
        "POST", f"{_version_url(user_id, workflow_id, version_no)}/restore",
        operation="workflow_version_restore", public_detail=detail,
    )
    return _validated(_WORKFLOW, body, "workflow_version_restore", detail)
