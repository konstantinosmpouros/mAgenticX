"""Endpoint helpers for ``/resume``: the LangGraph ``Command`` that answers a pause.

A run pauses for one of two things, told apart by the pending interrupt's value:
an approval gate (LangChain's ``HumanInTheLoopMiddleware``, answered with one
decision per pending tool call) or an ``ask_user`` question panel (answered with
the user's answers, or a skip). The router reads the pause back from the durable
checkpoint and hands it here.
"""
from __future__ import annotations

from typing import Any

from fastapi import HTTPException, status
from langgraph.types import Command

from harness.tools.ask_user import is_ask_user_interrupt
from harness.tools.ask_user import resume_value as ask_user_resume_value
from schema import AgentResumeRequest


def build_resume_command(
    req: AgentResumeRequest, interrupt_value: Any, pending_interrupts: list[Any], agent_logger: Any
) -> Command:
    """The resume for the pending interrupt, by the kind of pause it is."""
    if is_ask_user_interrupt(interrupt_value):
        return ask_user_resume_command(req, interrupt_value, pending_interrupts, agent_logger)
    return approval_resume_command(req, interrupt_value, agent_logger)


def approval_resume_command(req: AgentResumeRequest, interrupt_value: Any, agent_logger: Any) -> Command:
    """The resume for an approval gate: one decision per pending tool call."""
    # The interrupt's value is a langchain HITLRequest:
    #   { "action_requests": [...], "review_configs": [...] }
    if isinstance(interrupt_value, dict):
        action_requests = interrupt_value.get("action_requests") or []
    else:
        action_requests = getattr(interrupt_value, "action_requests", []) or []
    decision_count = max(1, len(action_requests))

    def _to_lc_decision(decision: str, reason: str | None) -> dict[str, Any]:
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

    agent_logger.info(
        "agent_resume_command_built",
        "Built LangChain HITL resume command",
        decision=req.decision,
        decision_count=len(decisions),
        decision_types=[d["type"] for d in decisions],
        per_action=req.decisions is not None,
    )
    return Command(resume={"decisions": decisions})


def ask_user_resume_command(
    req: AgentResumeRequest, interrupt_value: Any, pending_interrupts: list[Any], agent_logger: Any
) -> Command:
    """The resume for an ``ask_user`` pause: the user's answers, or a skip.

    ``approve`` carries ``value = {"answers": [...]}``; ``reject`` is the user
    skipping the questions. The tool turns the result into its reply text.
    """
    try:
        resume = ask_user_resume_value(interrupt_value, decision=req.decision, value=req.value)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(exc)) from exc
    agent_logger.info(
        "agent_resume_command_built",
        "Built ask_user resume command",
        decision=req.decision,
        skipped=resume["skipped"],
        answer_count=len(resume["answers"]),
    )
    # One pause is the norm (the prompt asks for a single call). Should the
    # model have asked twice in one turn, LangGraph refuses a bare value with
    # several interrupts pending, so answer the first by id; the run then
    # pauses again on the other.
    pending_id = getattr(pending_interrupts[0], "id", None)
    if len(pending_interrupts) > 1 and pending_id:
        return Command(resume={str(pending_id): resume})
    return Command(resume=resume)


__all__ = ["approval_resume_command", "ask_user_resume_command", "build_resume_command"]
