"""Endpoint helpers for compacting a branch on request, and undoing it (plan 34).

The router stays thin: these build the agent bound to the durable saver on the
branch's thread — exactly as ``/resume`` does, so it is the same graph, state
schema and summarizer a run on that thread would use — and hand the checkpoint
work to :mod:`harness.checkpointer.compaction`.
"""
from __future__ import annotations

from typing import Any

from fastapi import HTTPException, status

from core.logging import get_logger, set_context
from harness.checkpointer import (
    CompactionConflict,
    CompactionFailed,
    compact_thread,
    has_checkpointer_initialized,
    undo_compaction,
)
from schema import (
    CompactionUsageOut,
    CompactRequest,
    CompactResponse,
    UndoCompactionRequest,
    UndoCompactionResponse,
)
from utils.agents import resolve_agent_definition

logger = get_logger(__name__)

_CONFLICT_DETAIL = "The conversation moved on since this answer; nothing was changed."


async def _build_bound_agent(agent_slug: str, config: dict[str, Any], thread_id: str) -> Any:
    """Build the agent on ``thread_id`` and compile its graph (no MCP tools — a
    compaction calls none, and the state schema does not depend on them)."""
    context_data = config.get("context", {}) if isinstance(config, dict) else {}
    set_context(
        agent_slug=agent_slug,
        user_id=context_data.get("user_id"),
        conversation_id=context_data.get("conversation_id"),
        thread_id=thread_id,
    )
    if not has_checkpointer_initialized():
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Checkpointer is not ready.")
    definition = await resolve_agent_definition(agent_slug, context_data.get("agent_owner_id"))
    if definition is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown agent.")

    # The thread keys the durable saver; forcing it here binds the graph to the
    # same branch the bridge names, whatever the incoming run_config says.
    bound = dict(config)
    run_config = dict(bound.get("run_config") or {})
    run_config["configurable"] = {**dict(run_config.get("configurable") or {}), "thread_id": thread_id}
    bound["run_config"] = run_config
    try:
        agent = definition.build(config=bound)
        await agent.ensure_built()
    except Exception as exc:
        logger.warning(
            "compaction_agent_init_failed",
            "Failed to initialise the agent for a compaction",
            exc_info=True,
            failure_reason="agent_init_failed",
        )
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Failed to initialise the requested agent.") from exc
    return agent


async def compact_agent_thread(agent_slug: str, req: CompactRequest) -> CompactResponse:
    """Compact the branch now. ``unsupported`` for an agent without a summarizer
    (LangGraph agents, or a deep agent whose stack carries none); 409 when the
    branch's head is not the one expected; 502 when the summary call failed."""
    agent = await _build_bound_agent(agent_slug, req.config, req.thread_id)
    summarizer = getattr(agent, "summarizer", None)
    if summarizer is None:
        return CompactResponse(status="unsupported")
    try:
        result = await compact_thread(
            graph=agent.compiled,
            summarizer=summarizer,
            thread_id=req.thread_id,
            expected_checkpoint_id=req.expected_checkpoint_id,
        )
    except CompactionConflict as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=_CONFLICT_DETAIL) from exc
    except CompactionFailed as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="The summary could not be written; nothing was compacted.",
        ) from exc
    if not result.compacted:
        return CompactResponse(status="nothing_to_compact")
    logger.info(
        "manual_compaction_completed",
        "Compacted a conversation branch on request",
        summarized_messages=result.summarized_messages,
        kept_messages=result.kept_messages,
        freed=result.freed,
    )
    return CompactResponse(
        status="compacted",
        checkpoint_id=result.checkpoint_id,
        tokens_before=result.tokens_before,
        tokens_after=result.tokens_after,
        freed=result.freed,
        window=result.window,
        summarized_messages=result.summarized_messages,
        kept_messages=result.kept_messages,
        summary=result.summary,
        model=result.model,
        usage=CompactionUsageOut(**result.usage),
    )


async def undo_agent_compaction(agent_slug: str, req: UndoCompactionRequest) -> UndoCompactionResponse:
    """Take back the compaction that is still the branch's head (409 otherwise)."""
    agent = await _build_bound_agent(agent_slug, req.config, req.thread_id)
    try:
        checkpoint_id = await undo_compaction(
            graph=agent.compiled,
            thread_id=req.thread_id,
            expected_checkpoint_id=req.expected_checkpoint_id,
        )
    except CompactionConflict as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=_CONFLICT_DETAIL) from exc
    logger.info("manual_compaction_undone", "Undid a manual compaction")
    return UndoCompactionResponse(checkpoint_id=checkpoint_id)
