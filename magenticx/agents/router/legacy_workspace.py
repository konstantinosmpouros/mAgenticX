"""TEMPORARY — the previous bridge's file routes, answered by the new store (plan 43).

TODO(plan 43): remove once agents v1.22.0 has deployed (with
``harness/conversation_files/legacy_volume.py``).

During a rolling deploy a bridge task from the previous release (≤ v2.18.2)
can still call these agent-scoped routes for a minute. Each answers the way
the new design means it, so no run fails and no reap is lost in that window:

* uploads are read from the bridge now, so a seed is accepted and ignored;
* files are durable rows now, so there is nothing for a background capture
  to collect — the manifest is empty;
* the presented-file read and the reap go to the conversation-keyed routes.
"""
from fastapi import APIRouter, Depends, Query, status

from core.security.internal_trust import require_internal_caller
from router.conversation_files import read_conversation_files, reap_deleted_conversation
from schema import ReadOutputFilesResponse, ReapConversationRequest

router = APIRouter(
    prefix="/agents/{agent_slug}/users/{user_id}/conversations/{conversation_id}",
    dependencies=[Depends(require_internal_caller)],
    include_in_schema=False,
)


@router.put("/input-files")
async def accept_input_seed(agent_slug: str, user_id: str, conversation_id: str) -> dict[str, list[str]]:
    return {"written": []}


@router.get("/output-files/manifest")
async def empty_output_manifest(agent_slug: str, user_id: str, conversation_id: str) -> dict[str, list]:
    return {"files": []}


@router.get("/output-files", response_model=ReadOutputFilesResponse)
async def read_output_files_by_agent(
    agent_slug: str, user_id: str, conversation_id: str, paths: list[str] = Query(default_factory=list)
) -> ReadOutputFilesResponse:
    return await read_conversation_files(user_id, conversation_id, paths)


@router.post("/reap", status_code=status.HTTP_204_NO_CONTENT)
async def reap_by_agent(
    agent_slug: str, user_id: str, conversation_id: str, payload: ReapConversationRequest
) -> None:
    await reap_deleted_conversation(user_id, conversation_id, payload)
