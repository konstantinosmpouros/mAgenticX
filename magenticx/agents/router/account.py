"""Internal account-deletion routes (plan 32): the bridge's purge calls these.

Thin on purpose — what is deleted, and how, lives in ``utils.account_purge``.
Internal-caller only: the bridge has already checked the request, the grace
period and the step order before it calls. A failed purge answers 503 so the
bridge retries the same, idempotent step.
"""
from fastapi import APIRouter, Depends, HTTPException, status

from core.security.internal_trust import require_internal_caller
from schema import PurgeThreadsRequest, PurgeThreadsResponse, PurgeUserResponse
from utils.account_purge import AccountPurgeError, purge_threads, purge_user

router = APIRouter()

_RETRY = "The purge step did not finish; retry it."


@router.post(
    "/users/{user_id}/purge/threads",
    response_model=PurgeThreadsResponse,
    dependencies=[Depends(require_internal_caller)],
)
async def purge_user_threads(user_id: str, payload: PurgeThreadsRequest) -> PurgeThreadsResponse:
    """Delete a batch of the user's checkpoint threads."""
    try:
        deleted = await purge_threads(user_id, payload.thread_ids)
    except AccountPurgeError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, _RETRY) from exc
    return PurgeThreadsResponse(deleted=deleted)


@router.delete(
    "/users/{user_id}",
    response_model=PurgeUserResponse,
    dependencies=[Depends(require_internal_caller)],
)
async def purge_user_data(user_id: str) -> PurgeUserResponse:
    """Delete the user's memories, skills, agent definitions and conversation files."""
    try:
        counts = await purge_user(user_id)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid user id.") from exc
    except AccountPurgeError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, _RETRY) from exc
    return PurgeUserResponse.model_validate(counts)
