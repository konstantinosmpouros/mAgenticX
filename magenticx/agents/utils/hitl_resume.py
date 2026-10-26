"""Endpoint helpers for ``/resume``: the LangGraph ``Command`` that answers a pause.

A run pauses for one of two things, told apart by the pending interrupt's value:
an approval gate (LangChain's ``HumanInTheLoopMiddleware``, answered with one
decision per pending tool call) or an ``ask_user`` question panel (answered with
the user's answers, or a skip). The router reads the pause back from the durable
checkpoint and hands it here.

A run can be paused on several interrupts at once — parallel sub-agents, each at
its own approval gate. Each decision then targets its interrupt by id: LangGraph
applies ``Command(resume={interrupt_id: value, ...})`` to exactly those
interrupts (all of them, or some — the rest stay pending and the run pauses on
them again). That holds for a single pending interrupt too (see
``build_resume_command``): a bare value is stored as a run-wide answer that a
nested sub-agent can later read as its own. An answer naming an interrupt that
is not pending is refused with a 409 listing the stale and the pending ids.
"""
from __future__ import annotations

from typing import Any

from fastapi import HTTPException, status
from langgraph.types import Command

from harness.tools.ask_user import is_ask_user_interrupt
from harness.tools.ask_user import resume_value as ask_user_resume_value
from schema import AgentResumeRequest


def build_resume_command(req: AgentResumeRequest, pending_interrupts: list[Any], agent_logger: Any) -> Command:
    """The resume for the request's decision(s), by the kind of each pause.

    ``req.resumes`` answers several pending interrupts together; otherwise the
    top-level fields answer ``req.interrupt_id`` (or, from a client that names
    none, the first pending interrupt). A named interrupt that is not pending
    is a 409, a batch naming one interrupt twice a 422.
    """
    items: list[Any] = list(req.resumes) if req.resumes else [req]
    by_id = {str(i.id): i for i in pending_interrupts if getattr(i, "id", None)}
    _refuse_stale(items, by_id, agent_logger)
    answered: list[tuple[str | None, Any]] = []
    for item in items:
        target = by_id[str(item.interrupt_id)] if item.interrupt_id and by_id else pending_interrupts[0]
        target_id = getattr(target, "id", None)
        key = str(target_id) if target_id else None
        if key is not None and any(key == done for done, _ in answered):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="The resume answers the same interrupt twice.",
            )
        answered.append((key, resume_value(item, target.value, agent_logger)))

    # Keyed by interrupt id whenever the ids are LangGraph's, even for a single
    # pending interrupt. A bare value is stored on the checkpoint as a run-wide
    # resume and stays there while the step it belongs to is unfinished — which,
    # with parallel sub-agents, is until every one of them is through. A nested
    # sub-agent that pauses later (or is re-run by a partial resume) then reads
    # that stale value as its own answer: three decisions for a batched `task`
    # gate landed on a helper's single-action gate ("Number of human decisions
    # (3) does not match number of hanging tool calls (1)"), killing the helper
    # and its approval. A keyed resume only ever reaches its own interrupt.
    if all(key is not None and _is_langgraph_id(key) for key, _ in answered):
        return Command(resume={key: value for key, value in answered})
    if len(answered) == 1 and (len(pending_interrupts) == 1 or answered[0][0] is None):
        return Command(resume=answered[0][1])
    return Command(resume={key: value for key, value in answered})


def _is_langgraph_id(value: str) -> bool:
    """An interrupt id as LangGraph makes them (an xxh3-128 hex digest): the only
    keys it reads as a resume map rather than as one bare value."""
    return len(value) == 32 and all(c in "0123456789abcdef" for c in value)


def _refuse_stale(items: list[Any], by_id: dict[str, Any], agent_logger: Any) -> None:
    """409 when any answer names an interrupt that is not pending, listing
    every such id and the ones that are, so the caller can drop the stale
    answers and send the rest again instead of losing the whole batch."""
    if not by_id:
        return
    stale = [str(item.interrupt_id) for item in items if item.interrupt_id and str(item.interrupt_id) not in by_id]
    if not stale:
        return
    # A stale card (the run already moved past that interrupt): better to
    # refuse than to resolve another one.
    agent_logger.warning(
        "agent_resume_stale_interrupt",
        "Resume request targets interrupts that are no longer pending",
        requested_interrupt_id=stale[0],
        stale_interrupt_ids=stale,
        pending_interrupt_ids=list(by_id),
    )
    raise HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={
            "message": "The targeted interrupt is no longer pending.",
            "stale_interrupt_ids": stale,
            "pending_interrupt_ids": list(by_id),
        },
    )


def resume_value(item: Any, interrupt_value: Any, agent_logger: Any) -> Any:
    """The resume value for one pending interrupt, by the kind of pause it is."""
    if is_ask_user_interrupt(interrupt_value):
        return ask_user_resume(item, interrupt_value, agent_logger)
    return approval_resume(item, interrupt_value, agent_logger)


def approval_resume(item: Any, interrupt_value: Any, agent_logger: Any) -> dict[str, Any]:
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

    if item.decisions is not None:
        # Per-action path (batched interrupt): one decision per hanging tool
        # call, in order. LangChain maps decisions[i] -> action_requests[i]
        # positionally and raises ValueError on a count mismatch, so we guard
        # with a 422 (clearer than a 500 from a leaked ValueError).
        if len(item.decisions) != len(action_requests):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail=(
                    f"Decision count ({len(item.decisions)}) does not match the "
                    f"number of pending actions ({len(action_requests)})."
                ),
            )
        decisions = [_to_lc_decision(d.decision, d.reason) for d in item.decisions]
    else:
        # Legacy / single-action path: replicate the one decision across every
        # hanging tool call.
        decisions = [dict(_to_lc_decision(item.decision, item.reason)) for _ in range(decision_count)]

    agent_logger.info(
        "agent_resume_command_built",
        "Built LangChain HITL resume command",
        interrupt_id=item.interrupt_id,
        decision=item.decision,
        decision_count=len(decisions),
        decision_types=[d["type"] for d in decisions],
        per_action=item.decisions is not None,
    )
    return {"decisions": decisions}


def ask_user_resume(item: Any, interrupt_value: Any, agent_logger: Any) -> dict[str, Any]:
    """The resume for an ``ask_user`` pause: the user's answers, or a skip.

    ``approve`` carries ``value = {"answers": [...]}``; ``reject`` is the user
    skipping the questions. The tool turns the result into its reply text.
    """
    try:
        resume = ask_user_resume_value(interrupt_value, decision=item.decision, value=item.value)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(exc)) from exc
    agent_logger.info(
        "agent_resume_command_built",
        "Built ask_user resume command",
        interrupt_id=item.interrupt_id,
        decision=item.decision,
        skipped=resume["skipped"],
        answer_count=len(resume["answers"]),
    )
    return resume


__all__ = ["approval_resume", "ask_user_resume", "build_resume_command", "resume_value"]
