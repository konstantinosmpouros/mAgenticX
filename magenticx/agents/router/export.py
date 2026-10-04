"""Internal export route (plan 27): stream a user's agents and skills to the bridge.

Thin on purpose — the framing, paging and what is (and is not) exported live in
``utils.data_export``. Internal-caller only: the bridge has already checked the
user's session, cooldown and the service-wide concurrency limit before it calls.
"""
from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse

from core.security.internal_trust import require_internal_caller
from utils.data_export import stream_user_export

router = APIRouter()


@router.get(
    "/users/{user_id}/export",
    dependencies=[Depends(require_internal_caller)],
)
async def export_user_agents_and_skills(user_id: str) -> StreamingResponse:
    """Framed NDJSON: the user's custom agents, skills and assignments."""
    return StreamingResponse(stream_user_export(user_id), media_type="application/x-ndjson")
