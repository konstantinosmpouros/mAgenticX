"""Internal routes over a conversation's sources (plan 42): the bridge's calls.

Keyed by user and conversation, like the conversation's files: the sources
belong to the conversation, whichever agent or task found them.
Internal-caller only — the bridge checks the session and ownership first.
"""
from fastapi import APIRouter, Depends, status

from core.security.internal_trust import require_internal_caller
from schema import ConversationSourcesResponse, CopyConversationSourcesRequest
from utils.conversation_sources import (
    copy_conversation_sources,
    delete_conversation_sources,
    list_conversation_sources,
)

router = APIRouter(prefix="/users/{user_id}/conversations/{conversation_id}/sources")


@router.get(
    "",
    response_model=ConversationSourcesResponse,
    dependencies=[Depends(require_internal_caller)],
)
async def read_conversation_sources(user_id: str, conversation_id: str) -> ConversationSourcesResponse:
    """The conversation's sources, newest first, at most 500."""
    return ConversationSourcesResponse(sources=await list_conversation_sources(user_id, conversation_id))


@router.post(
    "/copy",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_internal_caller)],
)
async def copy_sources_to_fork(
    user_id: str, conversation_id: str, payload: CopyConversationSourcesRequest
) -> None:
    """Give a fork the source conversation's sources (a retried copy changes nothing)."""
    await copy_conversation_sources(user_id, conversation_id, payload.target_conversation_id)


@router.delete(
    "",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_internal_caller)],
)
async def delete_sources(user_id: str, conversation_id: str) -> None:
    """Delete the conversation's sources (the reap does this too)."""
    await delete_conversation_sources(user_id, conversation_id)
