"""Slash-command catalog (plan 35): the commands the composer's ``/`` menu offers.

Thin: the commands, their availability and the checks live in
``harness.commands``. Internal-caller only — the bridge proxies it, adding the
user's preference flags (which decide whether the memory commands can run).
"""
from fastapi import APIRouter, Depends, HTTPException, status

from core.logging import set_context
from core.security.internal_trust import require_internal_caller
from harness.commands import AgentFacts, list_commands
from schema import CommandListResponse, CommandOut
from utils.agents import resolve_agent_definition

router = APIRouter()


@router.get(
    "/commands/{user_id}/{agent_slug}",
    response_model=CommandListResponse,
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(require_internal_caller)],
)
async def get_commands(
    user_id: str,
    agent_slug: str,
    agent_owner_id: str | None = None,
    use_memory: bool = True,
    search_past_convs: bool = False,
) -> CommandListResponse:
    """Every command, each marked runnable or not for this agent and user."""
    set_context(user_id=user_id, agent_slug=agent_slug)
    definition = await resolve_agent_definition(agent_slug, agent_owner_id)
    if definition is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown agent.")
    facts = AgentFacts.for_run(
        definition.manifest.get("type"), {"use_memory": use_memory, "search_past_convs": search_past_convs}
    )
    return CommandListResponse(
        agentSlug=agent_slug,
        commands=[
            CommandOut(
                name=spec.name,
                kind=spec.kind,
                description=spec.description,
                argumentHint=spec.argument_hint,
                readOnly=spec.read_only,
                source=spec.source,
                available=reason is None,
                unavailableReason=reason,
            )
            for spec, reason in list_commands(facts)
        ],
    )
