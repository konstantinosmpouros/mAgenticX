"""The HITL decisions of one paused run, queued per interrupt.

A run can be paused on several interrupts at once: parallel sub-agents each
reach an approval gate, and every one of them surfaces its own
``HITL_INTERRUPT``. The user answers them in any order, often within a second,
while a resume leg for an earlier answer may still be streaming. So every
decision is kept under the interrupt it answers, never in one shared slot: a
second answer arriving before the first is dispatched used to overwrite it, and
the run then sat paused on an interrupt that had no decision while the UI said
"Decision sent".

The rules:

* a decision is accepted only for an interrupt the run is paused on right now
  (``pending_ids``, in the order the run surfaced them);
* a decision for any other interrupt is refused — it is stale, or the client
  made it up — and the route answers 409, never a silent 200;
* a repeat for an interrupt that already has a decision is **idempotent when
  identical** (a client retry after a dropped response is harmless) and refused
  when it differs (409: the first decision stands, it may already be applied);
* :meth:`HitlDecisionQueue.take_ready` hands the run every queued decision for
  the interrupts still pending, in their pending order — all of them for one
  batched resume, or only the first when the batch cannot be keyed by id.

One queue per run, created and dropped with the run's task, so nothing outlives
it. Everything here is synchronous: the asyncio loop runs ``offer`` and
``take_ready`` without interleaving, so the run cannot miss a decision between
checking the queue and waiting for the next one.
"""
from __future__ import annotations

from enum import Enum
from typing import Any


class ResumeOutcome(str, Enum):
    """What became of one resume request."""

    ACCEPTED = "accepted"
    #: The same decision again for the same interrupt: accepted, nothing queued twice.
    ALREADY_RECEIVED = "already_received"
    #: No live run, or a live run that is not paused on any interrupt.
    NOT_PAUSED = "not_paused"
    #: The interrupt is not one the run is paused on.
    UNKNOWN_INTERRUPT = "unknown_interrupt"
    #: A different decision for an interrupt that already has one.
    CONFLICTING_DECISION = "conflicting_decision"
    #: No interrupt id given, and every pending interrupt already has a decision.
    NOTHING_UNDECIDED = "nothing_undecided"

    @property
    def accepted(self) -> bool:
        return self in (ResumeOutcome.ACCEPTED, ResumeOutcome.ALREADY_RECEIVED)

    @property
    def detail(self) -> str:
        """The 409 message for a refused request."""
        return _DETAILS.get(self, "")


_DETAILS = {
    ResumeOutcome.NOT_PAUSED: "Run is not paused on a HITL interrupt.",
    ResumeOutcome.UNKNOWN_INTERRUPT: "This approval is not pending on the run any more. Reload to see its current state.",
    ResumeOutcome.CONFLICTING_DECISION: "A different decision for this approval was already received.",
    ResumeOutcome.NOTHING_UNDECIDED: "Every pending approval on this run already has a decision.",
}

# The fields that make up a decision (the interrupt id is the key, not a field).
_DECISION_FIELDS = ("decision", "reason", "value", "decisions")


def _same_decision(a: dict[str, Any], b: dict[str, Any]) -> bool:
    return all(a.get(field) == b.get(field) for field in _DECISION_FIELDS)


class HitlDecisionQueue:
    """Decisions of one run, keyed by the pending-interrupt token they answer.

    The token is the interrupt's id, or the runtime's ``anon-<n>`` stand-in for
    an interrupt without one (then the payload's ``interrupt_id`` stays None and
    the agents service resumes its first pending interrupt, as before).
    """

    def __init__(self) -> None:
        self._queued: dict[str, dict[str, Any]] = {}
        self._dispatched: dict[str, dict[str, Any]] = {}

    def __len__(self) -> int:
        return len(self._queued)

    def offer(self, payload: dict[str, Any], pending_ids: list[str]) -> tuple[ResumeOutcome, str | None]:
        """Queue ``payload`` under the interrupt it answers; returns the outcome and that token."""
        requested = payload.get("interrupt_id")
        if requested is None:
            # A client that names no interrupt answers the first undecided one.
            if not pending_ids:
                return ResumeOutcome.NOT_PAUSED, None
            token = next((i for i in pending_ids if i not in self._queued and i not in self._dispatched), None)
            if token is None:
                return ResumeOutcome.NOTHING_UNDECIDED, None
            self._queued[token] = payload
            return ResumeOutcome.ACCEPTED, token

        token = str(requested)
        prior = self._queued.get(token) or self._dispatched.get(token)
        if prior is not None:
            if _same_decision(prior, payload):
                return ResumeOutcome.ALREADY_RECEIVED, token
            return ResumeOutcome.CONFLICTING_DECISION, token
        if token not in pending_ids:
            return (ResumeOutcome.UNKNOWN_INTERRUPT if pending_ids else ResumeOutcome.NOT_PAUSED), token
        self._queued[token] = payload
        return ResumeOutcome.ACCEPTED, token

    def take_ready(self, pending_ids: list[str], *, batch: bool = True) -> list[tuple[str, dict[str, Any]]]:
        """Remove and return the queued decisions for the pending interrupts, in pending order.

        ``batch`` hands over all of them; a batch is only possible when every
        one names its interrupt (the agents service keys the batch by id), so
        otherwise — and with ``batch=False`` — only the first is handed over and
        the rest stay queued for the next leg.
        """
        ready = [(token, self._queued[token]) for token in pending_ids if token in self._queued]
        if not batch or any(payload.get("interrupt_id") is None for _, payload in ready):
            ready = ready[:1]
        for token, payload in ready:
            del self._queued[token]
            self._dispatched[token] = payload
        return ready

    def restore(self, token: str, payload: dict[str, Any]) -> None:
        """Put a dispatched decision back in the queue: the agents service
        refused its batch for another decision's sake and never applied it."""
        self._dispatched.pop(token, None)
        self._queued[token] = payload

    def discard(self, token: str) -> None:
        """Drop a queued decision whose interrupt the agent no longer has."""
        self._queued.pop(token, None)

    def forget_answered(self, pending_ids: list[str]) -> None:
        """The run paused again on an interrupt whose decision already went out
        (a second pause in the same task reuses its id): that is a new
        question, so it takes a new decision."""
        for token in pending_ids:
            self._dispatched.pop(token, None)


#: The resolved marker's decision for an approval the agent no longer had
#: pending: the decision was not applied (the UI shows it as not run).
EXPIRED_DECISION = "expired"
EXPIRED_REASON = "Not applied: this approval was no longer pending on the agent."


class StaleDecisions(Exception):
    """The agents service refused a resume because some of its decisions name
    interrupts it no longer has pending. Nothing in that resume was applied."""

    def __init__(self, stale_ids: list[str], pending_ids: list[str]) -> None:
        super().__init__(f"stale interrupts: {', '.join(stale_ids)}")
        self.stale_ids = stale_ids
        self.pending_ids = pending_ids


def stale_decisions_from_conflict(body: Any) -> StaleDecisions | None:
    """The agents service's 409 for stale interrupts, or None for any other 409
    (no paused checkpoint at all)."""
    detail = body.get("detail") if isinstance(body, dict) else None
    if not isinstance(detail, dict) or not isinstance(detail.get("stale_interrupt_ids"), list):
        return None
    pending = detail.get("pending_interrupt_ids")
    return StaleDecisions(
        [str(i) for i in detail["stale_interrupt_ids"]],
        [str(i) for i in pending] if isinstance(pending, list) else [],
    )


__all__ = [
    "EXPIRED_DECISION",
    "EXPIRED_REASON",
    "HitlDecisionQueue",
    "ResumeOutcome",
    "StaleDecisions",
    "stale_decisions_from_conflict",
]
