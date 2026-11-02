"""The agent builder's "Try it" chat (plan 40): start, Reset, and the sweeper.

A trial is an ordinary run on a conversation flagged ``is_trial`` (always also
``is_private``), so it reuses the whole pipeline — event log, WebSocket frames,
approvals, cancel, usage — with the draft sent inline instead of loaded from
the agents service's database:

* **Start** (``POST /v1/agents/{uid}/custom/try``) checks the draft with the
  agents service (422 with the same ``{message, errors, issues}`` Commit
  shows), writes the user's message on a new or continued trial conversation,
  creates the run through the same tail as every chat start
  (:func:`utils.inference_start.create_run_and_respond`: per-user active-run
  cap, one active run per conversation) and, before committing, stashes the
  draft in Redis for the run (:mod:`utils.trial_drafts`).
* An **existing** agent is tried on its own row: the trial conversation points
  at it, memory and tool rows are its real ones. A **new** draft has no row:
  ``agent_id`` stays NULL (allowed only on a trial) and the run uses a
  stand-in built from the draft, with memory off.
* **Reset** (``DELETE …/custom/try/{conversation_id}``) is the normal
  conversation delete, which reaps the agents-service threads and files.
* The **sweeper** deletes trials older than ``AGENT_TRIAL_CONVERSATION_TTL_HOURS``
  — the builder normally Resets them, but a closed tab never does.

Only ``new`` and ``send``: no edit, retry, fork, branch or share — every
conversation route treats a trial as not found (``utils.validators``). No
title and no suggestions are generated for a trial.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException, status
from redis.exceptions import RedisError
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import AgentTable, ConversationTable, MessageTable, SessionLocal, UserTable
from core.logging import get_logger
from core.settings import settings
from schema import AgentTrialStart, InferenceStartResponse, MessageIn
from utils.conversations import _preview, init_message
from utils.inference_runs import inference_run_manager
from utils.inference_start import create_run_and_respond
from utils.runtime_reaps import delete_conversation, drain_runtime_reaps, enqueue_runtime_reap
from utils.trial_drafts import TrialDraft, trial_drafts
from utils.user_agents import validate_custom_agent_definition
from utils.validators import load_conversation_full

logger = get_logger(__name__)


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


# ---------------------------------------------------------------------------
# Start
# ---------------------------------------------------------------------------
async def _owned_agent(db: AsyncSession, user_id: str, agent_id: str) -> AgentTable:
    """The caller's own active agent, or 404 — someone else's id looks exactly
    like one that does not exist. Only a user's own agents have a builder."""
    row = (
        await db.execute(
            select(AgentTable).where(
                AgentTable.id == agent_id,
                AgentTable.owner_user_id == user_id,
                AgentTable.is_active.is_(True),
            )
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent not found.")
    return row


def _invalid(errors: list[str], issues: list[dict[str, Any]]) -> HTTPException:
    """The 422 Commit answers for an invalid definition, so the builder shows
    a trial's problems exactly as it shows a save's."""
    return HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
        detail={"message": "; ".join(errors), "errors": errors, "issues": issues},
    )


async def _check_draft(user_id: str, definition: dict[str, Any], existing: AgentTable | None) -> None:
    """Have the agents service validate the draft (it validates again when it
    builds it); 422 when it would not be accepted.

    A trial of a saved agent must keep its slug: memory, skills and files are
    keyed by it, and a renamed draft would run as a different agent.
    """
    result = await validate_custom_agent_definition(user_id, definition)
    errors = [str(e) for e in (result or {}).get("errors") or []]
    issues = [i for i in (result or {}).get("issues") or [] if isinstance(i, dict)]
    spec = definition.get("spec") if isinstance(definition.get("spec"), dict) else {}
    if existing is not None and spec.get("slug") != existing.slug:
        message = f"An agent's slug cannot change ({existing.slug!r} → {spec.get('slug')!r}); try it as a new agent instead."
        errors.append(message)
        issues.append({"path": "slug", "message": message, "severity": "error"})
    if errors or not (result or {}).get("valid", False):
        raise _invalid(errors or ["The agent definition is not valid."], issues)


async def _new_trial_conversation(
    db: AsyncSession, user: UserTable, agent: Any, message: MessageIn
) -> tuple[ConversationTable, str]:
    conversation = ConversationTable(
        user_id=user.id,
        agent_id=agent.id,
        agent_name=agent.name,
        is_private=True,
        is_trial=True,
        title=None,
        last_message_preview=_preview(message.content),
    )
    db.add(conversation)
    await db.flush()
    first = await init_message(db, conversation, message, parent_message_id=None)
    return conversation, first.id


async def _continue_trial_conversation(
    db: AsyncSession, conversation: ConversationTable, message: MessageIn
) -> str:
    """Append the message to the trial's one branch: a trial is linear (no
    edit, retry or branch), so the parent is simply its newest message."""
    leaf = conversation.messages[-1] if conversation.messages else None
    created = await init_message(db, conversation, message, parent_message_id=leaf.id if leaf else None)
    preview = _preview(message.content)
    if preview:
        conversation.last_message_preview = preview
    conversation.last_message_at = _now()
    return created.id


async def start_agent_trial(
    db: AsyncSession, user: UserTable, payload: AgentTrialStart
) -> InferenceStartResponse:
    """Write the trial message and create its run (not launched — the route
    launches it, as the chat's start route does)."""
    user_id = user.id
    definition = payload.draft.model_dump(mode="json")
    # The cheap ownership checks first: a 404 must not wait on (or reveal
    # anything through) the agents service's validation.
    existing = await _owned_agent(db, user_id, payload.agentId) if payload.agentId else None
    conversation = (
        await load_conversation_full(db, user_id, payload.conversationId, trial=True)
        if payload.conversationId
        else None
    )
    await _check_draft(user_id, definition, existing)

    draft = TrialDraft(definition=definition, approvals=dict(payload.approvals), existing=existing is not None)
    agent: Any = existing if existing is not None else draft.agent_for(user_id)
    message = MessageIn(sender="user", content=payload.message)

    if conversation is None:
        mode = "new"
        conversation, parent_message_id = await _new_trial_conversation(db, user, agent, message)
    else:
        mode = "send"
        parent_message_id = await _continue_trial_conversation(db, conversation, message)
    await db.flush()
    db.expire(conversation, ["messages"])
    conversation = await load_conversation_full(db, user_id, conversation.id, trial=True)

    async def stash(run: MessageTable) -> None:
        try:
            await trial_drafts.put(run.id, draft)
        except RedisError as exc:
            logger.warning("agent_trial_stash_failed", "Could not keep a trial's draft for its run",
                           error_type=type(exc).__name__)
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Try it is temporarily unavailable. Please try again shortly.",
            ) from exc

    response = await create_run_and_respond(
        db=db,
        user_id=user_id,
        conversation=conversation,
        parent_message_id=parent_message_id,
        message_path=None,
        agent=agent,
        mode=mode,
        trial=True,
        before_commit=stash,
    )
    logger.info(
        "agent_trial_started",
        "Started a Try it run on an agent draft",
        conversation_id=response.detail.id,
        run_id=response.run.id,
        mode=mode,
        existing_agent=existing is not None,
    )
    return response


# ---------------------------------------------------------------------------
# Reset
# ---------------------------------------------------------------------------
async def delete_agent_trial(db: AsyncSession, user_id: str, conversation_id: str) -> None:
    """Reset: stop the trial's run, if any, then the normal conversation delete
    (which reaps its threads and files). 404 unless it is the caller's trial."""
    conversation = await load_conversation_full(db, user_id, conversation_id, trial=True)
    if conversation.active_assistant_message_id:
        # The run notices the conversation is gone when it finishes; stopping
        # it first spares the agents service the rest of a turn nobody sees.
        inference_run_manager.request_cancel(conversation.active_assistant_message_id)
    await delete_conversation(db, user_id, conversation)
    logger.info("agent_trial_reset", "Deleted a Try it conversation", conversation_id=conversation_id)


# ---------------------------------------------------------------------------
# Sweeper
# ---------------------------------------------------------------------------
async def sweep_expired_trials_once() -> int:
    """Delete one batch of trials older than the TTL; returns how many.

    A trial with a run still active is left for the next pass. The reaps are
    noted in the same transaction and sent once it commits, as on every delete.
    """
    cutoff = _now() - timedelta(hours=settings.agent_trial.conversation_ttl_hours)
    async with SessionLocal() as db:
        expired = list(
            (
                await db.execute(
                    select(ConversationTable)
                    .where(
                        ConversationTable.is_trial.is_(True),
                        ConversationTable.created_at < cutoff,
                        ConversationTable.active_assistant_message_id.is_(None),
                    )
                    .order_by(ConversationTable.created_at)
                    .limit(settings.agent_trial.sweep_batch_size)
                )
            ).scalars()
        )
        if not expired:
            return 0
        for conversation in expired:
            await enqueue_runtime_reap(db, conversation.user_id, conversation.id)
            await db.delete(conversation)
        await db.commit()
    await drain_runtime_reaps()
    logger.info("agent_trials_swept", "Deleted expired Try it conversations", count=len(expired))
    return len(expired)


async def run_trial_sweeper(stop_event: asyncio.Event) -> None:
    """Background loop: delete expired trials every ``sweep_interval_seconds``.

    A full batch looks again at once; otherwise it sleeps. Exits promptly when
    ``stop_event`` is set. Errors are logged and the loop lives on — a dead
    sweeper would let trials pile up silently.
    """
    logger.info("agent_trial_sweeper_started", "Try it sweeper started")
    while not stop_event.is_set():
        swept = 0
        try:
            swept = await sweep_expired_trials_once()
        except SQLAlchemyError as exc:
            logger.warning("agent_trial_sweep_failed", "Could not sweep expired trials", error_type=type(exc).__name__)
        except Exception:
            logger.error("agent_trial_sweeper_unexpected_error", "Unexpected error in the Try it sweeper", exc_info=True)
        if swept >= settings.agent_trial.sweep_batch_size:
            continue
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=settings.agent_trial.sweep_interval_seconds)
        except asyncio.TimeoutError:
            pass


__all__ = [
    "delete_agent_trial",
    "run_trial_sweeper",
    "start_agent_trial",
    "sweep_expired_trials_once",
]
