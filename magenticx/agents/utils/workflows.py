"""Endpoint helpers of the workflow routes (``router/workflows.py``).

The router stays thin: it maps these results to HTTP. Here: the store over the
shared ``agent_runtime`` pool, validation with this service's live context (the
MCP gateway catalogue), CRUD with ownership, and opening a run — resolving the
pinned version, compiling it (cached) over the durable checkpointer and running
the up-front checks.

Ownership is a filter, not a check after the fact: every query is scoped by
``owner_user_id``, so another user's workflow is simply "not found".
"""
from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

from core.logging import get_logger
from harness.checkpointer import get_checkpointer
from harness.memory.pool import get_memory_pool
from harness.workflows.compiler import forget_compiled, get_compiled
from harness.workflows.runner import (
    PreparedRun,
    ResumeDecision,
    RunRefused,
    RunTrigger,
    prepare_run,
)
from harness.workflows.spec import normalize_spec
from harness.workflows.store import WorkflowStore
from harness.workflows.validator import ValidationIssue, validate_spec
from schema.workflows import MAX_INPUT_BYTES, WorkflowRunRequest
from utils.mcp_tools import get_cached_tool_manifests, known_mcp_tool_keys

logger = get_logger(__name__)


class WorkflowNotFound(LookupError):
    """No such workflow (or version) for this owner."""


def workflow_store() -> WorkflowStore:
    """The store over the process-wide ``agent_runtime`` pool."""
    return WorkflowStore(get_memory_pool())


async def _known_mcp_tool_names() -> frozenset[str] | None:
    """The gateway's tool names, or ``None`` when the catalogue cannot be read
    (then MCP refs are not checked at save time; a run still fails on a missing one)."""
    keys = await known_mcp_tool_keys()
    if keys is None:
        return None
    return frozenset(m.tool_name for m in get_cached_tool_manifests()) if keys else frozenset()


async def validate_workflow(raw: Any) -> tuple[dict[str, Any] | None, list[ValidationIssue]]:
    """Validate a raw spec with live context. Returns the normalized spec JSON."""
    spec, issues = validate_spec(raw, known_mcp_tools=await _known_mcp_tool_names())
    return (spec.model_dump(mode="json") if spec is not None else None), issues


async def list_workflows(owner_user_id: str, *, limit: int, offset: int) -> list[dict[str, Any]]:
    return await workflow_store().list(owner_user_id, limit=limit, offset=offset)


async def get_workflow(owner_user_id: str, workflow_id: str) -> dict[str, Any]:
    """One workflow with its draft and newest version's spec, both normalized
    (a spec saved by an older engine comes back in today's shape)."""
    row = await workflow_store().get(owner_user_id, workflow_id)
    if row is None:
        raise WorkflowNotFound(workflow_id)
    return {**row, "draft": normalize_spec(row["draft"]), "spec": normalize_spec(row["spec"])}


async def create_workflow(owner_user_id: str, raw: Any) -> tuple[dict[str, Any] | None, list[ValidationIssue]]:
    """Validate and store a new workflow (draft + version 1)."""
    spec, issues = await validate_workflow(raw)
    if spec is None:
        return None, issues
    workflow_id = await workflow_store().create(owner_user_id, spec)
    logger.info("workflow_created", "Workflow created", workflow_id=workflow_id, node_count=len(spec["nodes"]))
    return await get_workflow(owner_user_id, workflow_id), []


async def update_workflow(
    owner_user_id: str, workflow_id: str, raw: Any
) -> tuple[dict[str, Any] | None, list[ValidationIssue]]:
    """Validate and save the draft; a new version only when the spec changed."""
    spec, issues = await validate_workflow(raw)
    if spec is None:
        return None, issues
    latest = await workflow_store().update(owner_user_id, workflow_id, spec)
    if latest is None:
        raise WorkflowNotFound(workflow_id)
    logger.info("workflow_updated", "Workflow saved", workflow_id=workflow_id, latest_version_no=latest)
    return await get_workflow(owner_user_id, workflow_id), []


async def list_workflow_versions(
    owner_user_id: str, workflow_id: str, *, limit: int, before: int | None
) -> dict[str, Any]:
    """One page of the workflow's history, newest first, with the next page's key."""
    rows = await workflow_store().list_versions(owner_user_id, workflow_id, limit=limit, before=before)
    if rows is None:
        raise WorkflowNotFound(workflow_id)
    # A full page may have more behind it; the oldest number shown is the key.
    oldest = rows[-1]["version_no"] if rows else None
    next_before = oldest if len(rows) >= limit and oldest is not None and oldest > 1 else None
    return {"items": rows, "next_before": next_before}


async def get_workflow_version(owner_user_id: str, workflow_id: str, version_no: int) -> dict[str, Any]:
    """One kept version with its spec (404 for another owner's or a missing one)."""
    row = await workflow_store().get_version_detail(owner_user_id, workflow_id, version_no)
    if row is None:
        raise WorkflowNotFound(workflow_id)
    return {**row, "spec": normalize_spec(row["spec"])}


async def restore_workflow_version(
    owner_user_id: str, workflow_id: str, version_no: int
) -> tuple[dict[str, Any] | None, list[ValidationIssue]]:
    """Save an old version's spec as the newest version — never rewrite history.

    The old spec is validated again with today's rules and live catalogue: a
    step kind or MCP tool may have gone since it was saved, and a restore must
    never store what a save would refuse (the issues come back instead). A
    spec equal to the newest one adds no version (the store's save rule).
    """
    row = await workflow_store().get_version_detail(owner_user_id, workflow_id, version_no)
    if row is None:
        raise WorkflowNotFound(workflow_id)
    spec, issues = await validate_workflow(row["spec"])
    if spec is None:
        logger.info(
            "workflow_restore_refused",
            "An old workflow version no longer validates",
            workflow_id=workflow_id,
            version_no=version_no,
            issue_count=len(issues),
        )
        return None, issues
    latest = await workflow_store().update(owner_user_id, workflow_id, spec, restored_from=version_no)
    if latest is None:
        raise WorkflowNotFound(workflow_id)
    logger.info(
        "workflow_version_restored",
        "Workflow version restored as a new version",
        workflow_id=workflow_id,
        restored_from=version_no,
        latest_version_no=latest,
    )
    return await get_workflow(owner_user_id, workflow_id), []


async def delete_workflow(owner_user_id: str, workflow_id: str) -> None:
    if not await workflow_store().delete(owner_user_id, workflow_id):
        raise WorkflowNotFound(workflow_id)
    forget_compiled(workflow_id)
    logger.info("workflow_deleted", "Workflow deleted", workflow_id=workflow_id)


async def open_workflow_run(req: WorkflowRunRequest) -> PreparedRun:
    """Resolve, compile and check a run. Raises ``WorkflowNotFound`` / ``RunRefused``."""
    if len(json.dumps(req.inputs, default=str).encode("utf-8")) > MAX_INPUT_BYTES:
        raise RunRefused(413, "The run inputs are larger than 64 KiB.")
    store = workflow_store()
    pinned = await store.get_version(req.owner_user_id, req.workflow_id, req.version_no)
    if pinned is None:
        raise WorkflowNotFound(req.workflow_id)
    version_no, raw_spec = pinned
    # A stored version passed validation when it was saved; re-validating here
    # (without the live MCP catalogue — that is checked per call) guards
    # against a version written by an older engine with looser rules.
    spec, issues = validate_spec(raw_spec)
    if spec is None:
        logger.warning(
            "workflow_version_invalid",
            "A stored workflow version no longer validates",
            workflow_id=req.workflow_id,
            version_no=version_no,
            issue_count=len(issues),
        )
        raise RunRefused(422, "This workflow version is no longer valid; save it again.",
                         [issue.message for issue in issues])
    compiled = get_compiled(req.workflow_id, version_no, spec, checkpointer=get_checkpointer())
    return await prepare_run(
        compiled,
        run_id=req.run_id,
        thread_id=req.thread_id,
        owner_user_id=req.owner_user_id,
        workflow_id=req.workflow_id,
        version_no=version_no,
        inputs=req.inputs,
        resume=ResumeDecision(req.resume.decision, req.resume.comment) if req.resume else None,
        store=store,
        trigger=RunTrigger(kind=req.trigger_kind, fired_at=_iso_utc(req.fired_at)),
    )


def _iso_utc(moment: datetime | None) -> str | None:
    """A request timestamp as ISO 8601 UTC with a ``Z`` (naive is read as UTC)."""
    if moment is None:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    return moment.astimezone(UTC).isoformat().replace("+00:00", "Z")


__all__ = [
    "WorkflowNotFound",
    "create_workflow",
    "delete_workflow",
    "get_workflow",
    "get_workflow_version",
    "list_workflow_versions",
    "list_workflows",
    "open_workflow_run",
    "restore_workflow_version",
    "update_workflow",
    "validate_workflow",
    "workflow_store",
]
