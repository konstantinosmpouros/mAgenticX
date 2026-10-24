"""Internal routes over a conversation's files (plan 43): the bridge's calls.

Keyed by user and conversation — never by agent: a conversation's files belong
to the conversation, whichever agents worked in it. Internal-caller only.
"""
from fastapi import APIRouter, Depends, HTTPException, Query, status

from core.security.internal_trust import require_internal_caller
from schema import (
    CopyConversationFilesRequest,
    CopyConversationFilesResponse,
    OutputFileOut,
    ReadOutputFilesResponse,
    ReapConversationRequest,
)
from utils.conversation_files import (
    ReapFailed,
    copy_conversation_files,
    read_output_files,
    reap_conversation,
)

router = APIRouter(prefix="/users/{user_id}/conversations/{conversation_id}")


@router.get(
    "/files",
    response_model=ReadOutputFilesResponse,
    dependencies=[Depends(require_internal_caller)],
)
async def read_conversation_files(
    user_id: str, conversation_id: str, paths: list[str] = Query(default_factory=list)
) -> ReadOutputFilesResponse:
    """The presented files, by exact path, for the run-end snapshot.

    Absent, oversized or off-output paths come back in ``missing`` (not an
    error) so the bridge stores what it can. 422 only for too many paths."""
    try:
        files, missing = await read_output_files(user_id, conversation_id, paths)
    except ValueError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from exc
    return ReadOutputFilesResponse(files=[OutputFileOut(**f) for f in files], missing=missing)


@router.post(
    "/files/copy",
    response_model=CopyConversationFilesResponse,
    dependencies=[Depends(require_internal_caller)],
)
async def copy_files_to_fork(
    user_id: str, conversation_id: str, payload: CopyConversationFilesRequest
) -> CopyConversationFilesResponse:
    """Give a fork the source conversation's files — rows only, never bytes."""
    copied = await copy_conversation_files(user_id, conversation_id, payload.target_conversation_id)
    return CopyConversationFilesResponse(copied=copied)


@router.post(
    "/reap",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_internal_caller)],
)
async def reap_deleted_conversation(
    user_id: str, conversation_id: str, payload: ReapConversationRequest
) -> None:
    """Delete a deleted conversation's checkpoint threads and files.

    503 when any of it is still there, so the bridge's outbox retries."""
    try:
        await reap_conversation(user_id, conversation_id, payload.thread_ids)
    except ReapFailed as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "The reap did not finish; retry it.") from exc
