import asyncio
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from langchain_mcp_adapters.tools import load_mcp_tools
from langgraph.types import Command

from core.proxy import require_internal_caller
from observability import get_context, get_logger, set_context
from runtime.checkpointer import get_checkpointer, has_checkpointer_initialized
from runtime.checkpointer.fork import seed_thread_from_checkpoint
from runtime.filesystem import delete_conversation_files, seed_input_files
from schemas import (
    AgentResumeRequest,
    ReapConversationRequest,
    Request,
    SeedInputFilesRequest,
    SeedInputFilesResponse,
)
from utils import emit_checkpoint_committed, mcp_session_context, release_checkpoint_unless_paused
from utils.agents import AGENT_REGISTRY

logger = get_logger(__name__)

router = APIRouter()


# ------------------------------------------------------------------
# Agent Interaction Endpoint
# ------------------------------------------------------------------
@router.post("/agents/{agent_slug}/stream", status_code=status.HTTP_200_OK, dependencies=[Depends(require_internal_caller)])
async def stream_agent(agent_slug: str, req: Request):
    """Stream responses from the requested agent template."""
    context_data = req.config.get("context", {}) if isinstance(req.config, dict) else {}
    run_config = req.config.get("run_config", {}) if isinstance(req.config, dict) else {}
    configurable = run_config.get("configurable", {}) if isinstance(run_config, dict) else {}
    agent_logger = logger.bind(agent_slug=agent_slug)
    set_context(
        agent_slug=agent_slug,
        user_id=context_data.get("user_id"),
        conversation_id=context_data.get("conversation_id"),
        thread_id=configurable.get("thread_id"),
    )
    agent_logger.info(
        "agent_stream_request_received",
        "Agent stream request received",
        input_messages=len(req.messages),
        configured_tools=len(req.config.get("tools", []) if isinstance(req.config, dict) else []),
    )
    try:
        # Check if the agent is disabled
        definition = AGENT_REGISTRY.get(agent_slug, None)
        if definition is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Unknown agent.",
            )
        # Initialise the agent
        agent_logger.info("agent_initialization_started", "Agent initialization started")
        agent = definition.cls(config=req.config)
    except HTTPException:
        raise
    except Exception as exc:
        agent_logger.warning(
            "agent_initialization_failed",
            "Failed to initialise the requested agent",
            exc_info=True,
            failure_reason="agent_init_failed",
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Failed to initialise the requested agent.",
        ) from exc
    agent_logger.info("agent_initialization_completed", "Agent initialization completed", agent_type=type(agent).__name__)
    request_context = get_context()
    stream_thread_id = configurable.get("thread_id") or ""
    # Per-run identity (assistant message id) used for the namespace-binding
    # cache; distinct from the branch-scoped checkpoint thread_id.
    run_id = context_data.get("run_id") or stream_thread_id
    # Edit/retry forks: seed this (fresh) branch thread from the parent branch's
    # checkpoint at the fork point before running the delta. Continue/new omit it.
    fork_from = req.config.get("fork_from") if isinstance(req.config, dict) else None

    # Stream agent responses. NOTE: durable threads — a fresh /stream must NOT
    # wipe the checkpoint; resume relies on it persisting across turns.
    async def event_stream():
        try:
            agent_logger.info("agent_stream_started", "Agent stream execution started", context=request_context)
            async with mcp_session_context() as session:
                agent_logger.info("mcp_session_connected", "MCP session connected for agent stream", context=request_context)
                live_tools = await load_mcp_tools(session)
                agent_logger.info("mcp_tools_loaded", "Loaded live MCP tools for agent stream", context=request_context, live_tool_count=len(live_tools))
                agent.attach_tools(live_tools)
                agent_logger.info("agent_tools_attached", "Agent tools attached for stream", context=request_context, attached_tool_count=len(getattr(agent, "tools_names", [])))
                if isinstance(fork_from, dict) and stream_thread_id:
                    # Build with tools first (deep agents compile against self.tools),
                    # then seed the new thread from the fork-point checkpoint.
                    await agent.ensure_built()
                    await seed_thread_from_checkpoint(
                        graph=agent.compiled,
                        source_thread_id=str(fork_from.get("thread_id") or ""),
                        source_checkpoint_id=fork_from.get("checkpoint_id"),
                        target_thread_id=stream_thread_id,
                    )
                async for chunk in agent.astream(payload={"messages": req.messages}):
                    yield chunk
            committed = await emit_checkpoint_committed(agent, stream_thread_id, agent_logger, request_context)
            if committed is not None:
                yield committed
            agent_logger.info("agent_stream_completed", "Agent stream execution completed", context=request_context)
        except asyncio.CancelledError:
            agent_logger.info("agent_stream_cancelled", "Agent stream execution cancelled", context=request_context)
            return
        except Exception as exc:
            agent_logger.error("agent_stream_failed", "Agent stream execution failed", context=request_context, exc_info=True)
            yield agent._encode_run_error(exc)
        finally:
            try:
                await release_checkpoint_unless_paused(agent, run_id)
            except Exception:
                agent_logger.warning("checkpoint_release_failed", "Failed to release namespace cache after stream", context=request_context, exc_info=True)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


# ------------------------------------------------------------------
# Agent HITL Resume Endpoint
# ------------------------------------------------------------------
@router.post("/agents/{agent_slug}/resume", status_code=status.HTTP_200_OK, dependencies=[Depends(require_internal_caller)])
async def resume_agent(agent_slug: str, req: AgentResumeRequest):
    """Resume a LangGraph run paused on a ``__interrupt__`` HITL event.

    Instantiates a fresh agent bound to the shared durable saver on the run's
    branch thread, reads the paused checkpoint (``aget_state``), builds a
    ``Command(resume=...)`` from the bridge's decision payload, and streams the
    resulting AG-UI events back. Stream framing and error encoding mirror the
    regular ``/stream`` endpoint so the bridge can plumb resume output through
    the same Redis stream + WebSocket observer pipeline. Because the checkpoint
    is durable, this now works even across an agents-service restart.
    """
    context_data = req.config.get("context", {}) if isinstance(req.config, dict) else {}
    run_config = req.config.get("run_config", {}) if isinstance(req.config, dict) else {}
    configurable = run_config.get("configurable", {}) if isinstance(run_config, dict) else {}
    # The thread the run was using; the cache key for the saved checkpoint.
    effective_thread_id = req.thread_id or configurable.get("thread_id") or ""
    agent_logger = logger.bind(agent_slug=agent_slug)
    set_context(
        agent_slug=agent_slug,
        user_id=context_data.get("user_id"),
        conversation_id=context_data.get("conversation_id"),
        thread_id=effective_thread_id,
    )
    agent_logger.info(
        "agent_resume_request_received",
        "Agent resume request received",
        decision=req.decision,
        has_value=req.value is not None,
        has_reason=bool(req.reason),
    )

    if not effective_thread_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="thread_id is required to resume a paused run.",
        )
    if not has_checkpointer_initialized():
        # Saver not wired (startup race) — distinct from "no paused interrupt",
        # which is detected below from the durable checkpoint itself.
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Checkpointer is not ready.",
        )

    definition = AGENT_REGISTRY.get(agent_slug, None)
    if definition is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Unknown agent.",
        )

    try:
        # Force the thread_id onto the run_config so the agent binds the shared
        # durable saver to the SAME branch thread the original stream used.
        resume_config = dict(req.config)
        run_config_in = dict(resume_config.get("run_config") or {})
        configurable_in = dict(run_config_in.get("configurable") or {})
        configurable_in["thread_id"] = effective_thread_id
        run_config_in["configurable"] = configurable_in
        resume_config["run_config"] = run_config_in
        agent = definition.cls(config=resume_config)
    except HTTPException:
        raise
    except Exception as exc:
        agent_logger.warning(
            "agent_resume_initialization_failed",
            "Failed to initialise agent for resume",
            exc_info=True,
            failure_reason="agent_init_failed",
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Failed to initialise the requested agent.",
        ) from exc

    request_context = get_context()

    # Build the LangChain HumanInTheLoopMiddleware-compatible resume payload.
    # The middleware expects a dict of the form
    #     {"decisions": [<decision>, <decision>, ...]}
    # with one entry per pending tool call in the SAME order. The middleware
    # raises a ValueError if the count is wrong, so we read it back from the
    # saved checkpoint instead of guessing.
    try:
        # Build the graph bound to the durable saver, then read the saved state
        # (async — AsyncPostgresSaver has no sync get_state) before issuing the
        # resume command. astream() reuses the same built graph.
        await agent.ensure_built()
        snapshot = await agent.compiled.aget_state(agent.run_config)
        pending_interrupts = list(snapshot.interrupts or [])
    except Exception as exc:
        agent_logger.warning(
            "agent_resume_state_load_failed",
            "Failed to load saved state for resume",
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to load the paused checkpoint.",
        ) from exc

    if not pending_interrupts:
        # The cached checkpointer exists but no interrupt is parked on it.
        # This happens if the previous resume already drained the queue or the
        # cache was warmed without ever pausing. Treat as "not paused".
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="No pending interrupt found on the checkpoint.",
        )

    pending_interrupt = pending_interrupts[0]
    pending_id = getattr(pending_interrupt, "id", None)
    # When the bridge passes the interrupt_id the user clicked, verify it
    # matches the graph's currently-pending interrupt. A mismatch means the
    # user clicked a stale card (e.g. the run already advanced past that
    # interrupt) — better to 409 than silently resolve the wrong one.
    if req.interrupt_id and pending_id and req.interrupt_id != str(pending_id):
        agent_logger.warning(
            "agent_resume_stale_interrupt",
            "Resume request targets an interrupt that is no longer pending",
            requested_interrupt_id=req.interrupt_id,
            pending_interrupt_id=str(pending_id),
        )
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="The targeted interrupt is no longer pending.",
        )

    # The first interrupt's value is a langchain HITLRequest:
    #   { "action_requests": [...], "review_configs": [...] }
    interrupt_value = pending_interrupt.value
    if isinstance(interrupt_value, dict):
        action_requests = interrupt_value.get("action_requests") or []
    else:
        action_requests = getattr(interrupt_value, "action_requests", []) or []
    decision_count = max(1, len(action_requests))

    def _to_lc_decision(decision: str, reason: Optional[str]) -> dict[str, Any]:
        # LangChain's RejectDecision requires `message`. Falling back to a
        # generic string when the user didn't type a reason avoids a KeyError
        # in HumanInTheLoopMiddleware.after_model when it does
        # `decision["message"]` to build the ToolMessage. Reject is non-
        # terminal in LangChain — the rejection becomes a ToolMessage and the
        # agent loop continues, which is exactly the "rehydrate after reject"
        # behavior the bridge expects.
        if decision == "approve":
            return {"type": "approve"}
        return {"type": "reject", "message": reason or "User rejected this action."}

    if req.decisions is not None:
        # Per-action path (batched interrupt): one decision per hanging tool
        # call, in order. LangChain maps decisions[i] -> action_requests[i]
        # positionally and raises ValueError on a count mismatch, so we guard
        # with a 422 (clearer than a 500 from a leaked ValueError).
        if len(req.decisions) != len(action_requests):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail=(
                    f"Decision count ({len(req.decisions)}) does not match the "
                    f"number of pending actions ({len(action_requests)})."
                ),
            )
        decisions = [_to_lc_decision(d.decision, d.reason) for d in req.decisions]
    else:
        # Legacy / single-action path: replicate the one decision across every
        # hanging tool call.
        decisions = [dict(_to_lc_decision(req.decision, req.reason)) for _ in range(decision_count)]

    resume_command = Command(resume={"decisions": decisions})

    agent_logger.info(
        "agent_resume_command_built",
        "Built LangChain HITL resume command",
        decision=req.decision,
        decision_count=len(decisions),
        decision_types=[d["type"] for d in decisions],
        per_action=req.decisions is not None,
    )

    resume_run_id = context_data.get("run_id") or effective_thread_id

    async def event_stream():
        try:
            agent_logger.info("agent_resume_started", "Agent resume execution started", context=request_context)
            async with mcp_session_context() as session:
                live_tools = await load_mcp_tools(session)
                agent.attach_tools(live_tools)
                async for chunk in agent.astream(payload={"messages": []}, command=resume_command):
                    yield chunk
            committed = await emit_checkpoint_committed(agent, effective_thread_id, agent_logger, request_context)
            if committed is not None:
                yield committed
            agent_logger.info("agent_resume_completed", "Agent resume execution completed", context=request_context)
        except asyncio.CancelledError:
            agent_logger.info("agent_resume_cancelled", "Agent resume execution cancelled", context=request_context)
            return
        except Exception as exc:
            agent_logger.error("agent_resume_failed", "Agent resume execution failed", context=request_context, exc_info=True)
            yield agent._encode_run_error(exc)
        finally:
            # Resume drained the interrupt → drop the namespace cache. Resume
            # re-paused on another interrupt → keep it for the next /resume.
            # The durable checkpoint is never deleted here.
            try:
                await release_checkpoint_unless_paused(agent, resume_run_id)
            except Exception:
                agent_logger.warning("checkpoint_release_failed", "Failed to release namespace cache after resume", context=request_context, exc_info=True)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


# ------------------------------------------------------------------
# Per-conversation input files (user uploads) + cleanup
# ------------------------------------------------------------------
@router.put(
    "/agents/{agent_slug}/users/{user_id}/conversations/{conversation_id}/input-files",
    response_model=SeedInputFilesResponse,
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(require_internal_caller)],
)
async def seed_conversation_input_files(
    agent_slug: str, user_id: str, conversation_id: str, payload: SeedInputFilesRequest
) -> SeedInputFilesResponse:
    """Persist user-uploaded files into the conversation's read-only ``input/``.

    Called by the bridge before a deep-agent run when the new user turn carries
    attachments. Idempotent (overwrite by filename); 422 on a bad/oversized file.
    """
    try:
        written = seed_input_files(
            user_id=user_id,
            agent_slug=agent_slug,
            conversation_id=conversation_id,
            files=payload.files,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc
    return SeedInputFilesResponse(written=written)


@router.post(
    "/agents/{agent_slug}/users/{user_id}/conversations/{conversation_id}/reap",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_internal_caller)],
)
async def reap_conversation(
    agent_slug: str, user_id: str, conversation_id: str, payload: ReapConversationRequest
) -> None:
    """Reap a conversation on delete: drop its durable checkpoint threads and
    its per-(user, agent) filesystem dir (input/output/artifacts). Called
    best-effort by the bridge, which owns the thread-id metadata. Idempotent —
    unknown threads / missing dirs are no-ops."""
    checkpointer = get_checkpointer()
    for thread_id in payload.thread_ids:
        if not thread_id:
            continue
        try:
            await checkpointer.adelete_thread(thread_id)
        except Exception:
            logger.warning(
                "checkpoint_thread_reap_failed",
                "Failed to delete a checkpoint thread during conversation reap",
                exc_info=True,
                thread_id=thread_id,
            )
    try:
        delete_conversation_files(user_id=user_id, agent_slug=agent_slug, conversation_id=conversation_id)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
