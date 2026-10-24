import asyncio

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from langchain_mcp_adapters.tools import load_mcp_tools

from core.security.internal_trust import require_internal_caller
from core.logging import get_context, get_logger, set_context
from harness.checkpointer import has_checkpointer_initialized
from harness.checkpointer.fork import seed_thread_from_checkpoint
from harness.commands import AgentFacts, CommandRefused, apply_command, resolve_invocation
from schema import (
    AgentResumeRequest,
    CompactRequest,
    CompactResponse,
    Request,
    UndoCompactionRequest,
    UndoCompactionResponse,
)
from utils import emit_checkpoint_committed, optional_mcp_session, release_checkpoint_unless_paused
from utils.agents import resolve_agent_definition
from utils.compaction import compact_agent_thread, undo_agent_compaction
from utils.hitl_resume import build_resume_command

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
    )
    try:
        # Platform agent, or one this user authored in their own workspace —
        # `agent_owner_id` is set by the bridge from the agents table.
        definition = await resolve_agent_definition(agent_slug, context_data.get("agent_owner_id"))
        if definition is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Unknown agent.",
            )
        # A slash command (plan 35): checked here even though the bridge checked
        # it — this service never trusts that alone — and applied to this turn's
        # message only.
        try:
            invocation = resolve_invocation(
                context_data.get("command"), AgentFacts.for_run(definition.manifest.get("type"), context_data)
            )
        except CommandRefused as exc:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(exc)) from exc
        messages = apply_command(req.messages, invocation) if invocation else req.messages
        # Initialise the agent
        agent_logger.info("agent_initialization_started", "Agent initialization started")
        agent = definition.build(config=req.config)
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
            # MCP is optional: no gateway (off, or unreachable) means a run with
            # the agent's own tools only, never a failed run.
            async with optional_mcp_session() as session:
                live_tools = await load_mcp_tools(session) if session is not None else []
                agent_logger.info("mcp_tools_loaded", "Loaded live MCP tools for agent stream", context=request_context, live_tool_count=len(live_tools), mcp_available=session is not None)
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
                async for chunk in agent.astream(payload={"messages": messages}):
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

    Two kinds of pause share it: an approval gate (approve/reject decisions)
    and an ``ask_user`` question panel (``value.answers``, or ``reject`` to
    skip), told apart by the pending interrupt's value.
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

    definition = await resolve_agent_definition(agent_slug, context_data.get("agent_owner_id"))
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
        agent = definition.build(config=resume_config)
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

    # Build the resume payload from what the checkpoint is paused on. An
    # approval gate is LangChain's HumanInTheLoopMiddleware, which expects
    #     {"decisions": [<decision>, <decision>, ...]}
    # with one entry per pending tool call in the SAME order (and raises a
    # ValueError if the count is wrong), so we read it back from the saved
    # checkpoint instead of guessing. An `ask_user` pause takes the answers.
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

    # The resume stream runs through a fresh normalizer: re-teach it the `task`
    # calls still awaiting their result, so a sub-agent spawned once its gated
    # `task` is approved keeps that call's id (one card in the UI) and its
    # result raises SUBAGENT_COMPLETED.
    normalizer = getattr(agent, "agui_normalizer", None)
    values = getattr(snapshot, "values", None)
    if normalizer is not None and isinstance(values, dict):
        normalizer.seed_pending_tasks(values.get("messages"))

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

    resume_command = build_resume_command(req, pending_interrupt.value, pending_interrupts, agent_logger)

    resume_run_id = context_data.get("run_id") or effective_thread_id

    async def event_stream():
        try:
            agent_logger.info("agent_resume_started", "Agent resume execution started", context=request_context)
            async with optional_mcp_session() as session:
                live_tools = await load_mcp_tools(session) if session is not None else []
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
# Manual compaction of a branch thread (plan 34)
# ------------------------------------------------------------------
@router.post(
    "/agents/{agent_slug}/compact",
    response_model=CompactResponse,
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(require_internal_caller)],
)
async def compact_thread_endpoint(agent_slug: str, req: CompactRequest) -> CompactResponse:
    """Summarize the branch's older messages now, between turns. Called by the
    bridge when the user clicks the composer's context ring; the bridge books
    the summary call's spend and records the compaction on the answer."""
    return await compact_agent_thread(agent_slug, req)


@router.post(
    "/agents/{agent_slug}/compact/undo",
    response_model=UndoCompactionResponse,
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(require_internal_caller)],
)
async def undo_compaction_endpoint(agent_slug: str, req: UndoCompactionRequest) -> UndoCompactionResponse:
    """Restore the state from before a manual compaction that is still the head."""
    return await undo_agent_compaction(agent_slug, req)
