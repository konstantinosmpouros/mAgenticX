"""``POST /v1/exec`` — thin: validate, call ``utils.exec_service``, map errors to HTTP."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from core.security import require_internal_caller
from schema import ExecRequest, ExecResponse
from utils.exec_service import RunnerBusy, TimeoutTooLong, execute
from utils.runner import DaemonUnavailable
from utils.workspace import InputTooLarge, InvalidFiles

router = APIRouter(prefix="/v1", tags=["exec"], dependencies=[Depends(require_internal_caller)])


@router.post("/exec", response_model=ExecResponse)
async def exec_command(body: ExecRequest) -> ExecResponse:
    """Run one command in a fresh gVisor box over the files sent with it.

    A command that fails or is killed is still 200 — the body says so. 4xx is
    for bad requests only; 503 when no box can be started at all.
    """
    try:
        return await execute(body)
    except TimeoutTooLong:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "timeout_seconds exceeds the server maximum.")
    except InvalidFiles:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "files could not be placed (bad base64 or clashing paths).")
    except InputTooLarge:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, "files exceed the server input limit.")
    except RunnerBusy:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "The sandbox runner is busy; try again.")
    except DaemonUnavailable:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "The sandbox is unavailable.")
