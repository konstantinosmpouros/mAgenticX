"""Slash commands in the bridge (plan 35): the ``/`` menu, and checking an invocation.

The agents service owns the commands — their files, which an agent can run, the
instruction a turn receives. The bridge asks it for one (user, agent)'s catalog,
with the user's preference flags that decide the memory commands, and:

* serves that catalog to the composer's ``/`` menu (:func:`list_agent_commands`);
* refuses a message whose command the catalog does not list as a runnable
  *prompt* command (:func:`check_invocation`) before any row is committed. The
  agents service checks again at run time — two independent checks, as for
  everything else that crosses the trust boundary.

An ``action`` (``/compact``, ``/new`` …) never reaches here as a message: the UI
calls that action's own endpoint.
"""
from __future__ import annotations

from typing import Any

import httpx
from fastapi import HTTPException, status
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import AgentTable, MessageTable, UserPreferencesTable
from core.logging import get_context, get_logger
from core.security.internal_trust import internal_service_headers
from core.security.tls import get_httpx_client_cert, get_httpx_verify
from core.settings import settings
from schema import CommandInvocation, CommandListResponse, CommandOut
from utils.agents import build_agent_commands_url, get_agent_by_id

logger = get_logger(__name__)

_UNAVAILABLE = "Commands are unavailable right now. Try again in a moment."


def command_context(user_message: MessageTable | None) -> dict[str, Any]:
    """The run context's ``command`` entry for the turn ``user_message`` starts, or ``{}``.

    ``{"command": {"name", "args"}}`` — the argument is the message's content.
    Retry reaches here with the same user message, so it re-runs the command.
    """
    command = getattr(user_message, "command", None)
    if not isinstance(command, dict) or not isinstance(command.get("name"), str):
        return {}
    return {"command": {"name": command["name"], "args": user_message.content or ""}}


async def _preference_flags(db: AsyncSession, user_id: str) -> tuple[bool, bool]:
    """``(use_memory, search_past_convs)`` — the same defaults a run uses without a row."""
    row = (
        await db.execute(select(UserPreferencesTable).where(UserPreferencesTable.user_id == user_id))
    ).scalar_one_or_none()
    return (bool(row.use_memory) if row else True, bool(row.search_past_convs) if row else False)


async def _fetch_catalog(db: AsyncSession, user_id: str, agent: AgentTable) -> list[CommandOut]:
    """The agents service's catalog for this (user, agent). 503 when it cannot answer."""
    use_memory, search_past_convs = await _preference_flags(db, user_id)
    params: dict[str, Any] = {"use_memory": use_memory, "search_past_convs": search_past_convs}
    if getattr(agent, "owner_user_id", None):
        params["agent_owner_id"] = str(agent.owner_user_id)
    try:
        async with httpx.AsyncClient(
            timeout=settings.http.agents_timeout, verify=get_httpx_verify(), cert=get_httpx_client_cert()
        ) as client:
            response = await client.get(
                build_agent_commands_url(agent, user_id),
                params=params,
                headers=internal_service_headers(get_context().get("request_id")),
            )
        response.raise_for_status()
        return CommandListResponse.model_validate(response.json()).commands
    except (httpx.HTTPError, ValueError, ValidationError) as exc:
        logger.warning("command_catalog_unavailable", "Could not read the agent's commands",
                       agent_id=agent.id, error_type=type(exc).__name__)
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=_UNAVAILABLE) from exc


def _usable_agent(agent: AgentTable | None, user_id: str) -> AgentTable:
    """The agent, if this user may run it (a custom agent is its owner's alone)."""
    if agent is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown agent.")
    if agent.owner_user_id is not None and agent.owner_user_id != user_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="This agent is private to its owner.")
    return agent


async def list_agent_commands(db: AsyncSession, user_id: str, agent_id: str) -> CommandListResponse:
    """The ``/`` menu for one agent: every command, runnable or with its reason."""
    agent = _usable_agent(await get_agent_by_id(agent_id), user_id)
    return CommandListResponse(commands=await _fetch_catalog(db, user_id, agent))


async def check_invocation(db: AsyncSession, user_id: str, agent: AgentTable, invocation: CommandInvocation) -> None:
    """Refuse (422) a command this agent does not offer this user as a runnable prompt."""
    catalog = {command.name: command for command in await _fetch_catalog(db, user_id, agent)}
    command = catalog.get(invocation.name)
    if command is None:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=f"/{invocation.name} isn't a command.")
    if command.kind != "prompt":
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=f"/{invocation.name} runs in the app, not as a message.",
        )
    if not command.available:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=command.unavailableReason or f"/{invocation.name} isn't available for this agent.",
        )
