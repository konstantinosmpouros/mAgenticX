"""Compact a conversation on request, and undo it (plan 34).

The composer's context ring calls this between turns. The compaction is
recorded on the answer it follows (``messages.compaction``), never as a message
of its own, so the message tree, branch threads and edit/retry are untouched:
children of the answer resume from the compacted head, a retry of the answer
forks from before it.

The order of work is what keeps it safe:

1. the answer must be the finished, committed leaf of its branch, on a deep
   agent the user may use;
2. the conversation lock is taken (run creation refuses while it is held) and
   no run may be active;
3. the agents service compacts against the head recorded on the answer and
   refuses if it moved;
4. the answer's head, its compaction record and the summary call's spend are
   written in one transaction.

Undo is the same in reverse, while nothing was sent after the compaction.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
from fastapi import HTTPException, status
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import ConversationTable, MessageTable, MessageUsageTable
from core.logging import get_context, get_logger
from core.security.internal_trust import internal_service_headers
from core.security.tls import get_httpx_client_cert, get_httpx_verify
from core.settings import settings
from schema import AgentCompactionResult, AgentCompactionUndoResult
from utils.agents import build_agent_compact_undo_url, build_agent_compact_url, get_agent_by_id
from utils.compaction_lock import compaction_locks
from utils.inference_runs import ACTIVE_RUN_STATUSES
from utils.messages import get_owned_message
from utils.model_pricing import call_cost_micros
from utils.usage_rollups import add_answer_to_rollups

logger = get_logger(__name__)

#: How long after compacting the toast's Undo stays honoured (the UI offers it
#: for seconds; this is the server's ceiling, not the UX).
UNDO_WINDOW = timedelta(minutes=10)

#: Usage scope and group a compaction's summary call is booked under.
COMPACTION_SCOPE = "compaction"
COMPACTION_GROUP = "Compaction"


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


async def _find_answer(db: AsyncSession, conversation: ConversationTable, message_id: str) -> MessageTable:
    """The conversation's AI answer with this id — or 404, whoever owns the id.
    Loaded alone, without attachments: nothing here needs them."""
    message = await get_owned_message(db, conversation.id, message_id, with_attachments=False)
    if message is None or message.sender != "ai":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Answer not found in this conversation.")
    return message


async def _has_children(db: AsyncSession, message_id: str) -> bool:
    """Whether anything was sent after the answer (on any branch)."""
    child = await db.scalar(select(MessageTable.id).where(MessageTable.parent_message_id == message_id).limit(1))
    return child is not None


async def _compaction_agent(message: MessageTable, conversation: ConversationTable, user_id: str) -> Any:
    """The agent that wrote the answer, if this user may run it and it compacts."""
    agent = await get_agent_by_id(message.agent_id or conversation.agent_id)
    if agent is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="This answer's agent no longer exists.")
    if agent.owner_user_id is not None and agent.owner_user_id != user_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="This agent is private to its owner.")
    if getattr(agent, "type", "") != "deep agent":
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="This agent doesn't compact its context.",
        )
    return agent


async def _refuse_if_run_active(db: AsyncSession, conversation_id: str) -> None:
    active = await db.scalar(
        select(MessageTable.id)
        .where(
            MessageTable.conversation_id == conversation_id,
            MessageTable.streaming_status.in_(ACTIVE_RUN_STATUSES),
        )
        .limit(1)
    )
    if active is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Wait for the answer to finish before compacting.",
        )


def _agents_body(agent: Any, conversation: ConversationTable, user_id: str, message: MessageTable) -> dict[str, Any]:
    """The context block a run on this branch carries — enough to build the agent
    for this user's workspace (custom agents resolve through their owner)."""
    context: dict[str, Any] = {"user_id": str(user_id), "conversation_id": str(conversation.id)}
    if getattr(agent, "owner_user_id", None):
        context["agent_owner_id"] = str(agent.owner_user_id)
    return {
        "config": {"context": context},
        "thread_id": message.checkpoint_thread_id,
        "expected_checkpoint_id": message.checkpoint_id,
    }


async def _post_agents(url: str, body: dict[str, Any], *, action: str) -> dict[str, Any]:
    """Call the agents service; map its refusals to the user's terms."""
    try:
        async with httpx.AsyncClient(
            timeout=settings.http.compaction_timeout, verify=get_httpx_verify(), cert=get_httpx_client_cert()
        ) as client:
            response = await client.post(url, json=body, headers=internal_service_headers(get_context().get("request_id")))
    except httpx.TimeoutException as exc:
        logger.warning("compaction_agents_timeout", "The agents service timed out on a compaction", action=action)
        raise HTTPException(status_code=status.HTTP_504_GATEWAY_TIMEOUT, detail="Compacting took too long. Try again.") from exc
    except httpx.HTTPError as exc:
        logger.warning("compaction_agents_unreachable", "The agents service was unreachable for a compaction",
                       action=action, error_type=type(exc).__name__)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Compacting failed. Try again.") from exc
    if response.status_code == status.HTTP_409_CONFLICT:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="The conversation moved on; nothing was changed.")
    if response.status_code >= 400:
        logger.warning("compaction_agents_failed", "The agents service refused a compaction",
                       action=action, status_code=response.status_code)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Compacting failed. Try again.")
    try:
        return response.json()
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Compacting failed. Try again.") from exc


async def _book_compaction_usage(
    db: AsyncSession,
    *,
    message: MessageTable,
    conversation: ConversationTable,
    result: AgentCompactionResult,
    at: datetime,
) -> None:
    """Book the summary call like any model call — tokens, a call, model time —
    but never as an answer, under its own ``compaction`` scope (plan 34 D7)."""
    usage = result.usage
    if not (usage.input_tokens or usage.output_tokens):
        return
    model = result.model[:200] if result.model else None
    calls = usage.calls or 1
    # Priced like an answer's calls (plan 41). The summary arrives as one total,
    # so a long-context tier is chosen by its summed input — exact for the one
    # call a compaction makes.
    cost = call_cost_micros(model, usage.input_tokens, usage.cached_input_tokens, usage.output_tokens)
    priced = {"cost_micros": cost or 0, "unpriced_calls": calls if cost is None else 0}
    db.add(
        MessageUsageTable(
            message_id=message.id,
            conversation_id=conversation.id,
            user_id=conversation.user_id,
            agent_id=message.agent_id,
            main_agent_name=message.agent_name,
            scope=COMPACTION_SCOPE,
            agent_name=COMPACTION_GROUP,
            model_name=model,
            calls=usage.calls or 1,
            input_tokens=usage.input_tokens,
            cached_input_tokens=usage.cached_input_tokens,
            output_tokens=usage.output_tokens,
            reasoning_tokens=usage.reasoning_tokens,
            model_latency_ms=usage.latency_ms,
            created_at=at,
            **priced,
        )
    )
    table = ConversationTable
    conversation.usage_cost_micros = table.usage_cost_micros + priced["cost_micros"]
    conversation.usage_input_tokens = table.usage_input_tokens + usage.input_tokens
    conversation.usage_cached_tokens = table.usage_cached_tokens + usage.cached_input_tokens
    conversation.usage_output_tokens = table.usage_output_tokens + usage.output_tokens
    conversation.usage_total_tokens = table.usage_total_tokens + usage.input_tokens + usage.output_tokens
    conversation.usage_model_calls = table.usage_model_calls + (usage.calls or 1)
    conversation.usage_model_ms = table.usage_model_ms + usage.latency_ms
    conversation.usage_updated_at = at
    await add_answer_to_rollups(
        db,
        user_id=conversation.user_id,
        day=at.date(),
        agent_id=message.agent_id,
        agent_name=message.agent_name,
        answer={
            "answers": 0,
            "input_tokens": usage.input_tokens,
            "cached_input_tokens": usage.cached_input_tokens,
            "output_tokens": usage.output_tokens,
            "reasoning_tokens": usage.reasoning_tokens,
            "model_ms": usage.latency_ms,
            "model_calls": usage.calls or 1,
            "tool_calls": 0,
            "detailed_answers": 0,
            # Measured with full detail, so it belongs in the cache-hit base.
            "detailed_input_tokens": usage.input_tokens,
            **priced,
        },
        groups=[{
            "scope": COMPACTION_SCOPE,
            "group_name": COMPACTION_GROUP,
            "model_name": model or "",
            "calls": usage.calls or 1,
            "input_tokens": usage.input_tokens,
            "cached_input_tokens": usage.cached_input_tokens,
            "output_tokens": usage.output_tokens,
            "reasoning_tokens": usage.reasoning_tokens,
            "model_ms": usage.latency_ms,
            **priced,
        }],
    )


def _compaction_record(result: AgentCompactionResult, previous: dict[str, Any] | None, at: datetime) -> dict[str, Any]:
    """The ``messages.compaction`` JSON for a fresh compaction.

    Compacting the same answer twice starts from the first compaction's result
    (the reply's own usage still describes the context from before it), and
    keeps that record so an undo restores it rather than erasing both.
    """
    before = int(previous["tokens_after"]) if previous else result.tokens_before
    freed = min(result.freed, before)
    return {
        "trigger": "manual",
        "tokens_before": before,
        "tokens_after": before - freed,
        "freed": freed,
        "window": result.window,
        "summarized_messages": result.summarized_messages,
        "kept_messages": result.kept_messages,
        "summary": result.summary,
        "model": result.model[:200] if result.model else None,
        "input_tokens": result.usage.input_tokens,
        "cached_input_tokens": result.usage.cached_input_tokens,
        "output_tokens": result.usage.output_tokens,
        "latency_ms": result.usage.latency_ms,
        "compacted_at": at.isoformat(),
        "undone_at": None,
        "previous": previous,
    }


def _active_compaction(message: MessageTable) -> dict[str, Any] | None:
    record = message.compaction
    return record if isinstance(record, dict) and not record.get("undone_at") else None


async def compact_conversation(
    db: AsyncSession, *, user_id: str, conversation: ConversationTable, message_id: str
) -> MessageTable | None:
    """Compact the branch ending at ``message_id`` now.

    Returns the answer, now carrying its compaction, or ``None`` when nothing
    was old enough to summarize. Raises HTTP errors for every refusal: not the
    branch's finished leaf (409), an agent that does not compact (422), a
    compaction or run already in progress (409), the branch moved on (409).
    """
    message = await _find_answer(db, conversation, message_id)
    if message.streaming_status not in (None, "completed") or message.is_error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Only a finished answer can be compacted.")
    if not (message.checkpoint_thread_id and message.checkpoint_id):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This answer has no saved agent state to compact. Send a message first.",
        )
    if await _has_children(db, message.id):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Compact from the latest answer of the conversation.")
    agent = await _compaction_agent(message, conversation, user_id)

    if not await compaction_locks.acquire(conversation.id):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="This conversation is already being compacted.")
    try:
        await _refuse_if_run_active(db, conversation.id)
        payload = await _post_agents(build_agent_compact_url(agent), _agents_body(agent, conversation, user_id, message),
                                     action="compact")
        try:
            result = AgentCompactionResult.model_validate(payload)
        except ValidationError as exc:
            logger.warning("compaction_agents_reply_invalid", "The agents service sent an invalid compaction reply")
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Compacting failed. Try again.") from exc
        if result.status == "unsupported":
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="This agent doesn't compact its context.",
            )
        if result.status == "nothing_to_compact" or not result.checkpoint_id:
            return None

        at = _now()
        record = _compaction_record(result, _active_compaction(message), at)
        message.compaction = record
        message.checkpoint_id = result.checkpoint_id
        conversation.last_context_tokens = record["tokens_after"]
        await _book_compaction_usage(db, message=message, conversation=conversation, result=result, at=at)
        await db.commit()
    finally:
        await compaction_locks.release(conversation.id)

    logger.info(
        "conversation_compacted",
        "Compacted a conversation on request",
        freed=record["freed"],
        summarized_messages=record["summarized_messages"],
        kept_messages=record["kept_messages"],
    )
    return message


async def undo_conversation_compaction(
    db: AsyncSession, *, user_id: str, conversation: ConversationTable, message_id: str
) -> MessageTable:
    """Take back the compaction recorded on ``message_id``.

    Allowed while nothing was sent after it and within :data:`UNDO_WINDOW`.
    The agent's state goes back to what it was; the answer shows the compaction
    before (if it had been compacted twice) or none. The summary call's spend
    stays booked — it happened.
    """
    message = await _find_answer(db, conversation, message_id)
    record = _active_compaction(message)
    if record is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="There is no compaction to undo.")
    if await _has_children(db, message.id):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A message was sent after this compaction; it can no longer be undone.",
        )
    try:
        compacted_at = datetime.fromisoformat(str(record.get("compacted_at")))
    except ValueError:
        compacted_at = None
    if compacted_at is None or _now() - compacted_at.replace(tzinfo=None) > UNDO_WINDOW:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="This compaction can no longer be undone.")
    agent = await _compaction_agent(message, conversation, user_id)

    if not await compaction_locks.acquire(conversation.id):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="This conversation is already being compacted.")
    try:
        await _refuse_if_run_active(db, conversation.id)
        payload = await _post_agents(
            build_agent_compact_undo_url(agent), _agents_body(agent, conversation, user_id, message), action="undo"
        )
        try:
            result = AgentCompactionUndoResult.model_validate(payload)
        except ValidationError as exc:
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Undo failed. Try again.") from exc

        message.checkpoint_id = result.checkpoint_id
        previous = record.get("previous")
        message.compaction = previous if isinstance(previous, dict) else {**record, "undone_at": _now().isoformat()}
        conversation.last_context_tokens = int(record.get("tokens_before") or 0) or conversation.last_context_tokens
        await db.commit()
    finally:
        await compaction_locks.release(conversation.id)

    logger.info("conversation_compaction_undone", "Undid a manual compaction")
    return message
