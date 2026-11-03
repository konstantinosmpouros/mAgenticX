"""The ``/v1/exec`` business logic: admit, stage files, run, collect, audit, clean up.

The router stays thin and maps the typed errors raised here onto HTTP:

=====================  ======  ==========================================
error                  status  meaning
=====================  ======  ==========================================
``TimeoutTooLong``     422     above the server ceiling
``InvalidFiles``       422     bad base64, or paths that clash
``InputTooLarge``      413     files decode above ``SANDBOX_MAX_INPUT_BYTES``
``RunnerBusy``         429     every slot taken for ``queue_timeout_seconds``
``DaemonUnavailable``  503     the inner daemon / runsc cannot start a box
=====================  ======  ==========================================

Every path — success or refusal — produces exactly one audit record, and the
per-call temp dir is removed in a ``finally`` whatever happened.
"""
from __future__ import annotations

import asyncio
import logging

from core.settings import settings
from schema import ExecRequest, ExecResponse
from utils.audit import audit_exec
from utils.health import health_monitor
from utils.runner import DaemonUnavailable, run_command
from utils.workspace import (
    InputTooLarge,
    InvalidFiles,
    Workspace,
    collect_outputs,
    decode_files,
    prepare_workspace,
    remove_workspace,
)

# Bounds concurrent boxes so a burst of calls cannot exhaust the host.
_slots = asyncio.Semaphore(settings.sandbox.max_concurrent)


class TimeoutTooLong(Exception):
    """``timeout_seconds`` above ``SANDBOX_MAX_WALL_SECONDS``."""


class RunnerBusy(Exception):
    """No free slot within the queue timeout."""


async def _acquire_slot() -> None:
    try:
        await asyncio.wait_for(_slots.acquire(), timeout=settings.sandbox.queue_timeout_seconds)
    except asyncio.TimeoutError as exc:
        raise RunnerBusy() from exc


async def execute(request: ExecRequest) -> ExecResponse:
    """Run one request end to end; raises one of the typed errors above on refusal."""
    cfg = settings.sandbox
    audit = {
        "user_id": request.user_id,
        "agent_slug": request.agent_slug,
        "conversation_id": request.conversation_id,
        "command": request.command,
        "workdir": request.workdir,
    }

    timeout = request.timeout_seconds or cfg.default_timeout_seconds
    if timeout > cfg.max_wall_seconds:
        audit_exec(outcome="refused", refusal="timeout_too_long", level=logging.WARNING, **audit)
        raise TimeoutTooLong()

    try:
        decoded = decode_files(request.files, cfg.max_input_bytes)
    except (InvalidFiles, InputTooLarge) as exc:
        audit_exec(outcome="refused", refusal=exc.__class__.__name__, level=logging.WARNING, **audit)
        raise
    input_bytes = sum(len(d) for _, _, d in decoded)

    try:
        await _acquire_slot()
    except RunnerBusy:
        audit_exec(outcome="busy", level=logging.WARNING, **audit)
        raise

    ws: Workspace | None = None
    try:
        try:
            ws = await asyncio.to_thread(prepare_workspace, cfg.calls_root, decoded)
        except InvalidFiles:
            audit_exec(outcome="refused", refusal="InvalidFiles", level=logging.WARNING, **audit)
            raise
        outcome = await run_command(
            cfg, workspace=ws, workdir=request.workdir, command=request.command, timeout_seconds=timeout
        )
        collected = await asyncio.to_thread(
            collect_outputs, ws, max_file=cfg.max_output_file_bytes, max_total=cfg.max_output_total_bytes
        )
    except DaemonUnavailable:
        health_monitor.invalidate()
        audit_exec(outcome="unavailable", level=logging.ERROR, **audit)
        raise
    except InvalidFiles:
        raise
    except BaseException as exc:
        audit_exec(outcome="failed", error_type=exc.__class__.__name__, level=logging.ERROR, **audit)
        raise
    finally:
        if ws is not None:
            await asyncio.to_thread(remove_workspace, ws)
        _slots.release()

    result = outcome.response.model_copy(
        update={"files": collected.files, "files_truncated": collected.truncated}
    )
    audit_exec(
        outcome="completed",
        exit_code=result.exit_code,
        duration_ms=result.duration_ms,
        killed_reason=result.killed_reason,
        truncated=result.truncated,
        input_files=len(decoded),
        input_bytes=input_bytes,
        bytes_written=outcome.bytes_written,
        files_returned=len(result.files),
        files_truncated=result.files_truncated,
        timeout_seconds=timeout,
        **audit,
    )
    return result
