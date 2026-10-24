"""Internal (service-to-service) endpoints over a conversation's uploads.

**Not** browser-facing: gated by `require_internal_caller` (the shared internal
proxy secret) AND blocked at the nginx edge (`/api/v1/internal/`), so only the
agents service — reaching the bridge directly on the `backend` network — can
call them. They back the agent's read-only ``/conversation/input/`` folder
(plan 43): the uploads stay here, and the agent reads them on demand.
"""
from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import get_db
from core.logging import get_logger, set_context
from core.security.internal_trust import require_internal_caller
from schema import (
    ExistingConversationsIn,
    ExistingConversationsOut,
    InputFilesOut,
)
from utils.conversation_inputs import (
    conversation_is_owned,
    existing_conversation_ids,
    list_input_files,
    read_input_file,
)

router = APIRouter(prefix="/conversations", dependencies=[Depends(require_internal_caller)])
logger = get_logger(__name__)


@router.get(
    "/{conversation_id}/input-files",
    response_model=InputFilesOut,
    summary="Internal: a conversation's uploads, as the agent's input folder lists them",
)
async def listInputFiles(
    conversation_id: str,
    user_id: str = Query(min_length=1),
    db: AsyncSession = Depends(get_db),
) -> InputFilesOut:
    set_context(user_id=user_id, conversation_id=conversation_id)
    if not await conversation_is_owned(db, conversation_id, user_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Conversation not found.")
    files = await list_input_files(db, conversation_id, user_id)
    logger.info("input_files_listed", "Listed a conversation's uploads for the agent", files=len(files))
    return InputFilesOut.model_validate({"files": files})


@router.get(
    "/{conversation_id}/input-files/{attachment_id}",
    summary="Internal: one upload's bytes (at most the 25 MB upload cap, so sent whole)",
)
async def readInputFile(
    conversation_id: str,
    attachment_id: str,
    user_id: str = Query(min_length=1),
    db: AsyncSession = Depends(get_db),
) -> Response:
    set_context(user_id=user_id, conversation_id=conversation_id)
    data = await read_input_file(db, conversation_id, user_id, attachment_id)
    if data is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Upload not found.")
    return Response(content=data, media_type="application/octet-stream")


# TODO(plan 43): remove after the first deploy past dialogue_bridge v2.18.2 —
# only the agents service's one-off move of its old volume trees calls it.
@router.post(
    "/existing",
    response_model=ExistingConversationsOut,
    summary="Internal: which of these conversations the user still has",
)
async def existingConversations(
    body: ExistingConversationsIn, db: AsyncSession = Depends(get_db)
) -> ExistingConversationsOut:
    set_context(user_id=body.user_id)
    found = await existing_conversation_ids(db, body.user_id, body.conversation_ids)
    return ExistingConversationsOut(conversation_ids=found)
