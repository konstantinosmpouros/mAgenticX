import asyncio
import json
import time
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from typing import Any, AsyncIterator
from uuid import uuid4

import httpx
from fastapi import HTTPException, status
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import (
    AgentTable,
    AttachmentTable,
    ConversationTable,
    MessageTable,
    MessageUsageTable,
    SessionLocal,
    ToolUsageTable,
    UserPreferencesTable,
)
from core.security.internal_trust import internal_service_headers
from core.settings import settings
from utils import agent_tool_prefs
from core.security.tls import get_httpx_client_cert, get_httpx_verify
from core.logging import get_context, get_logger
from schema import ConversationSummary, InferenceRunOut, MessageOut
from utils.agents import (
    build_agent_resume_url,
    build_agent_stream_url,
    get_agent_by_id,
)
from utils.commands import command_context
from utils.compaction_lock import compaction_locks
from utils.conversations import _preview
from utils.event_log import event_log
from utils.model_pricing import call_cost_micros
from utils.output_capture import capture_presented_files
from utils.run_activity import RunActivity, count_run_activity
from utils.usage_rollups import add_answer_to_rollups
from utils.inference import (
    nearest_committed_ai,
    prepare_inference_history,
    resolve_inference_message_path,
    serialise_message_with_images_for_agent,
)
from utils.validators import validate_convId_full

ACTIVE_RUN_STATUSES = {"queued", "running", "cancelling"}
TERMINAL_RUN_STATUSES = {"completed", "cancelled", "failed"}
MAX_ACTIVE_RUNS_PER_USER = settings.rate_limit.inference_max_active_runs
STALE_QUEUED_RUN_AFTER = timedelta(minutes=2)

logger = get_logger(__name__)


async def get_active_run_for_user(db: AsyncSession, user_id: str, run_id: str) -> MessageTable | None:
    """Load an inference run (assistant message with a streaming status) scoped to its owner."""
    result = await db.execute(
        select(MessageTable)
        .join(ConversationTable, ConversationTable.id == MessageTable.conversation_id)
        .where(
            MessageTable.id == run_id,
            ConversationTable.user_id == user_id,
            MessageTable.streaming_status.is_not(None),
        )
    )
    return result.scalar_one_or_none()


async def list_runs_for_user(
    db: AsyncSession, user_id: str, status_filter: str | None
) -> list[MessageTable]:
    """List the user's inference runs, optionally filtered by streaming status."""
    stmt = (
        select(MessageTable)
        .join(ConversationTable, ConversationTable.id == MessageTable.conversation_id)
        .where(
            ConversationTable.user_id == user_id,
            MessageTable.streaming_status.is_not(None),
        )
    )
    if status_filter == "active":
        stmt = stmt.where(MessageTable.streaming_status.in_(ACTIVE_RUN_STATUSES))
    elif status_filter:
        stmt = stmt.where(MessageTable.streaming_status == status_filter)
    stmt = stmt.order_by(MessageTable.streaming_started_at.desc())
    result = await db.execute(stmt)
    return list(result.scalars().all())


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _as_int(value: Any) -> int:
    """A token or millisecond count from an event, or 0 for anything else."""
    return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else 0


def _detail_sum(details: Any, kind: str) -> int:
    """Sum a usage detail across provider variants: OpenAI reports
    ``cache_read`` / ``reasoning`` and, on a service tier, prefixed copies
    such as ``flex_cache_read`` — the same tokens, never both at once."""
    if not isinstance(details, dict):
        return 0
    return sum(_as_int(v) for k, v in details.items() if str(k) == kind or str(k).endswith(f"_{kind}"))


# Plan 41: cost, truncation and speed, derived per settled call — run totals,
# and columns of the same name on message_usage and usage_daily_groups.
_GROUP_METRICS = (
    "cost_micros", "unpriced_calls", "truncated_calls", "ttft_ms", "ttft_calls", "gen_ms", "gen_output_tokens",
)
# The run totals summed from TOKEN_USAGE (each also a per-group counter).
_USAGE_TOTALS = (
    "input_tokens", "output_tokens", "cached_input_tokens", "reasoning_tokens", "model_latency_ms",
    *_GROUP_METRICS,
)


def _call_metrics(value: dict[str, Any], input_tokens: int, cached: int, output_tokens: int) -> dict[str, int]:
    """Plan 41's derivations for one settled model call.

    * cost from ``utils/model_pricing.py``; a model with no price (or no model
      reported at all) is one unpriced call and adds no cost;
    * truncated when the agents service says the call hit the output limit;
    * speed only for a call that streamed (it reports ``ttft_ms``): its time to
      first token, the time after it, and the output tokens of that time — so
      tokens per second never mixes in a call that delivered everything at once.
    """
    cost = call_cost_micros(value.get("model"), input_tokens, cached, output_tokens)
    ttft = value.get("ttft_ms")
    streamed = isinstance(ttft, (int, float)) and not isinstance(ttft, bool) and ttft >= 0
    ttft_ms = int(ttft) if streamed else 0
    return {
        "cost_micros": cost or 0,
        "unpriced_calls": 1 if cost is None else 0,
        "truncated_calls": 1 if value.get("truncated") is True else 0,
        "ttft_ms": ttft_ms,
        "ttft_calls": 1 if streamed else 0,
        "gen_ms": max(_as_int(value.get("latency_ms")) - ttft_ms, 0) if streamed else 0,
        "gen_output_tokens": output_tokens if streamed else 0,
    }


def _add_to_groups(groups: dict[Any, dict[str, int]], key: Any, contribution: dict[str, int], sign: int) -> None:
    """Add (or, with ``sign=-1``, take back) one call's contribution to its group."""
    group = groups.setdefault(key, dict.fromkeys(contribution, 0))
    for field, amount in contribution.items():
        group[field] += sign * amount
    if not any(group.values()):
        del groups[key]


def _effective_personalization(prefs_row: UserPreferencesTable | None) -> dict[str, Any]:
    """Reduce a preference row to the personalization payload a run should carry.

    Only *effective* data survives: the personality preset when non-default,
    and the custom-instruction text fields only while the user has the feature
    enabled and at least one field filled. Returns ``{}`` when nothing applies
    so the caller can omit the context key entirely — the agents service treats
    an absent key as "no personalization" (and re-validates whatever does
    arrive fail-closed).
    """
    if prefs_row is None:
        return {}
    payload: dict[str, Any] = {}

    personality = (prefs_row.personality or "").strip().lower()
    if personality and personality != "default":
        payload["personality"] = personality

    ci = prefs_row.custom_instructions if isinstance(prefs_row.custom_instructions, dict) else {}
    if ci.get("enabled"):
        fields = {
            key: value.strip()
            for key in ("nickname", "occupation", "traits", "about")
            if isinstance((value := ci.get(key)), str) and value.strip()
        }
        if fields:
            payload["custom_instructions"] = fields

    return payload


def run_is_interactive(run: MessageTable) -> bool:
    """Whether a person is there to answer this run's questions (``ask_user``).

    A chat turn is; a scheduled task's run is not — nobody would ever resume
    it, so the agents service leaves the tool out."""
    return run.scheduled_task_id is None


def hitl_resolved_value(resume_payload: dict[str, Any], decision: str) -> dict[str, Any]:
    """The ``BRIDGE_HITL_RESOLVED`` marker's value for one resume.

    Persisted in the event log so a reloaded client knows the pause was
    resolved, and how. An ``ask_user`` reply also carries the user's
    ``answers`` (``value.answers`` of the resume), so the panel can show what
    was answered after a reload.
    """
    marker: dict[str, Any] = {
        "interrupt_id": resume_payload.get("interrupt_id"),
        "decision": decision,
        "reason": resume_payload.get("reason"),
        "decisions": resume_payload.get("decisions"),
    }
    value = resume_payload.get("value")
    if isinstance(value, dict) and isinstance(value.get("answers"), list):
        marker["answers"] = value["answers"]
    return marker


def _parse_sse_bytes(buffer: str, chunk: bytes) -> tuple[str, list[dict[str, Any]]]:
    buffer += chunk.decode("utf-8", errors="ignore")
    events: list[dict[str, Any]] = []
    while "\n\n" in buffer:
        raw_event, buffer = buffer.split("\n\n", 1)
        data_lines = []
        for line in raw_event.splitlines():
            stripped = line.strip()
            if stripped.startswith("data:"):
                data_lines.append(stripped[5:].strip())
        if not data_lines:
            continue
        payload = "\n".join(data_lines).strip()
        if not payload:
            continue
        try:
            value = json.loads(payload)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict) and value.get("type"):
            events.append(value)
    return buffer, events


def _message_payload_from_runtime(runtime: "InferenceRunRuntime", *, error: bool, error_message: str | None) -> dict[str, Any]:
    return {
        "content": runtime.content or "",
        "reasoning_steps": deepcopy(runtime.thoughts) or None,
        "reasoning_time_seconds": runtime.thinking_duration_seconds(),
        "is_error": error,
        "error_message": error_message,
        "raw_events": deepcopy(runtime.raw_events) or [],
    }


_TEXT_DELTA_TYPES = {"TEXT_MESSAGE_CHUNK", "TEXT_MESSAGE_CONTENT"}


def _coalesce_key(event: dict[str, Any]) -> tuple[Any, ...] | None:
    """Merge identity for delta-bearing events. Consecutive stored events with
    the same key are collapsed into one event with a concatenated ``delta`` so
    the persisted log stays block-lossless without keeping per-token entries.

    THINKING_TEXT_MESSAGE_CONTENT is deliberately NOT coalesced: each thinking
    event is a discrete thought step (custom-mode agents emit one event per
    thought), so merging them would collapse steps on hydration that the live
    stream showed separately.
    """
    event_type = event.get("type")
    if event_type in _TEXT_DELTA_TYPES:
        return ("text", event.get("messageId"), repr(event.get("namespace")))
    if event_type == "TOOL_CALL_ARGS":
        return ("tool_args", event.get("toolCallId"))
    return None


def _merge_delta_into(last: dict[str, Any], incoming: dict[str, Any]) -> bool:
    key = _coalesce_key(incoming)
    if key is None or key != _coalesce_key(last):
        return False
    last["delta"] = str(last.get("delta") or "") + str(incoming.get("delta") or "")
    if incoming.get("timestamp") is not None:
        last["timestampEnd"] = incoming["timestamp"]
    return True


def _truncate_tool_result(event: dict[str, Any]) -> dict[str, Any]:
    """Cap an oversized tool result, live and stored.

    Image results are exempt: the agents service already replaced the original
    with a bounded thumbnail, and cutting a base64 string mid-way only makes it
    undecodable — which is exactly what used to reach the UI.
    """
    content = event.get("content")
    if not isinstance(content, str):
        return event
    limit = settings.inference.tool_result_max_chars
    if len(content) <= limit or "preview_base64" in content:
        return event
    return {**event, "content": content[:limit], "truncated": True}


class InferenceRunRuntime:
    def __init__(self) -> None:
        self.content = ""
        self.thoughts: list[str] = []
        self.raw_events: list[dict[str, Any]] = []
        self.first_event_ts = 0.0
        self.thinking_start = 0.0
        self.thinking_end = 0.0
        self.closed_thinking_on_first_chunk = False
        self.next_seq = 0
        # Outstanding HITL interrupt identities emitted by the agent but not
        # yet resumed. Used by `InferenceRunManager._run` to decide whether to
        # wait for a /resume after the upstream stream ends, rather than
        # finalising the run as completed. Tracked by `interrupt.id`, never a
        # bare counter: a sub-agent interrupt is delivered TWICE (top-level
        # HITL_INTERRUPT with namespace metadata + the same event wrapped in
        # SUBAGENT_EVENT) while each /resume resolves exactly one interrupt —
        # a counter drifts upward and the run never finalises.
        self.pending_interrupt_ids: list[str] = []
        # Per-run token usage, summed across every AI message (main + sub-agents,
        # across all resume legs). Deduped by message_id since a settled AI
        # message can surface both directly and wrapped in a SUBAGENT_EVENT.
        self.input_tokens = 0
        self.output_tokens = 0
        self.cached_input_tokens = 0
        self.reasoning_tokens = 0
        self.model_latency_ms = 0
        # Plan 41, summed the same way: cost in micro-USD and calls on a model
        # with no price; calls cut off at the output limit; and, over the calls
        # that streamed, time to first token, generation time after it and the
        # output tokens of that time (see _call_metrics).
        self.cost_micros = 0
        self.unpriced_calls = 0
        self.truncated_calls = 0
        self.ttft_ms = 0
        self.ttft_calls = 0
        self.gen_ms = 0
        self.gen_output_tokens = 0
        # The answer's time to first text (plan 41): from the moment this run
        # started — the runtime is created as the run's task begins — to the
        # main agent's first text delta, measured here because only the bridge
        # sees the whole run (queueing, attachment seeding, every model call
        # and tool before the text). Monotonic clock. Settled once: by the
        # first text, or by a HITL interrupt before it, in which case it stays
        # None — the wait was the human's, not the model's.
        self.started_at = time.perf_counter()
        self.first_token_ms: int | None = None
        self._first_token_settled = False
        # The same usage split by who spent it — (scope, agent, model) → sums —
        # for the message_usage rows (plan 33). Scope is "main" or "subagent";
        # the main agent's label is filled in at finish (the runtime does not
        # know it). Each counted call remembers its group, so a call first seen
        # bare and then wrapped in SUBAGENT_EVENT moves to its sub-agent.
        self.usage_groups: dict[tuple[str, str, str | None], dict[str, int]] = {}
        self._usage_by_call: dict[str, tuple[tuple[str, str, str | None], dict[str, int]]] = {}
        # Tool calls from TOOL_USAGE (plan 41), the same way: (scope, agent,
        # tool) → calls / errors / duration_ms / output_chars, each call counted
        # once by its tool_call_id and moved to its sub-agent when it turns up
        # wrapped after being seen bare.
        self.tool_groups: dict[tuple[str, str, str], dict[str, int]] = {}
        self._tool_by_call: dict[str, tuple[tuple[str, str, str], dict[str, int]]] = {}
        # task_id → sub-agent type, from TASK_SUBAGENT, so a wrapped call is
        # booked to "researcher" rather than to an anonymous sub-agent.
        self._subagent_types: dict[str, str] = {}
        # The main agent's context on its most recent model call — prompt size,
        # the model's window, where it compacts, which model (sub-agents run
        # their own, separate contexts, so they never overwrite this).
        self.context: dict[str, Any] = {}
        # The durable checkpoint head the agent committed this run (captured
        # from the terminal CHECKPOINT_COMMITTED event). Persisted on the AI
        # message by _finish_run so the next turn resumes / forks from it.
        self.produced_checkpoint_id: str | None = None
        # Deliverables the agent designated via present_artifact (captured from
        # PRESENT_ARTIFACT custom events). Each entry is
        # {artifact_id, path, title, summary}; deduped by path (last wins). At
        # finalize _finish_run reads these files back from the agents service and
        # persists them as generated attachments on the assistant message.
        self.presented_artifacts: list[dict[str, Any]] = []

    def _usage_group(self, value: dict[str, Any], *, main_agent: bool, task_id: Any) -> tuple[str, str, str | None]:
        """Who spent a call: ("main" | "subagent" | "compaction", name, model).

        The summary call of the main agent's automatic compaction (plan 34) is
        its own group, so Usage can say what compaction costs.
        """
        model = str(value["model"])[:200] if value.get("model") else None
        if main_agent and value.get("purpose") == "compaction":
            return ("compaction", "Compaction", model)
        if main_agent:
            return ("main", "", model)
        return ("subagent", self._subagent_label(task_id), model)

    def _register_subagent_type(self, value: Any) -> None:
        """Remember a TASK_SUBAGENT's type under its `task` call id."""
        if isinstance(value, dict) and value.get("task_id") and value.get("subagent_type"):
            self._subagent_types[str(value["task_id"])] = str(value["subagent_type"])[:200]

    def _subagent_label(self, task_id: Any) -> str:
        subagent_type = self._subagent_types.get(str(task_id)) if task_id is not None else None
        return subagent_type or "sub-agent"

    def _add_to_group(self, key: tuple[str, str, str | None], contribution: dict[str, int], sign: int) -> None:
        _add_to_groups(self.usage_groups, key, contribution, sign)

    @staticmethod
    def _book_once(
        by_call: dict[str, tuple[Any, dict[str, int]]],
        groups: dict[Any, dict[str, int]],
        token: str,
        key: Any,
    ) -> bool:
        """True when ``token`` was already counted. A call booked to the main
        agent that now turns out to be a sub-agent's is moved — every field of
        its contribution, so no total ever counts it twice or loses it."""
        counted = by_call.get(token)
        if counted is None:
            return False
        previous_key, contribution = counted
        if previous_key[0] == "main" and key[0] == "subagent":
            _add_to_groups(groups, previous_key, contribution, -1)
            _add_to_groups(groups, key, contribution, 1)
            by_call[token] = (key, contribution)
        return True

    def _accumulate_usage(self, value: Any, *, main_agent: bool, task_id: Any = None) -> None:
        """Fold one TOKEN_USAGE event into the run's totals (deduped by message)."""
        if not isinstance(value, dict):
            return
        mid = value.get("message_id")
        token = str(mid) if mid is not None else f"usage-{self.next_seq}"
        key = self._usage_group(value, main_agent=main_agent, task_id=task_id)
        if self._book_once(self._usage_by_call, self.usage_groups, token, key):
            return
        input_tokens = _as_int(value.get("input_tokens"))
        cached = _detail_sum(value.get("input_token_details"), "cache_read")
        output_tokens = _as_int(value.get("output_tokens"))
        contribution = {
            "calls": 1,
            "input_tokens": input_tokens,
            "cached_input_tokens": cached,
            "output_tokens": output_tokens,
            "reasoning_tokens": _detail_sum(value.get("output_token_details"), "reasoning"),
            "model_latency_ms": _as_int(value.get("latency_ms")),
            **_call_metrics(value, input_tokens, cached, output_tokens),
        }
        self._usage_by_call[token] = (key, contribution)
        self._add_to_group(key, contribution, 1)
        for field in _USAGE_TOTALS:
            setattr(self, field, getattr(self, field) + contribution[field])
        if main_agent and isinstance(value.get("context_tokens"), int):
            self.context = {
                "context_tokens": value.get("context_tokens"),
                "context_window": value.get("context_window") if isinstance(value.get("context_window"), int) else None,
                "compaction_percent": value.get("compaction_percent")
                if isinstance(value.get("compaction_percent"), (int, float)) else None,
                "model_name": str(value["model"])[:200] if value.get("model") else None,
            }

    def _accumulate_tool_usage(self, value: Any, *, main_agent: bool, task_id: Any = None) -> None:
        """Fold one TOOL_USAGE event into the tool groups (plan 41).

        Deduped by ``tool_call_id`` and grouped by (scope, agent, tool) exactly
        like token usage — a call first seen bare and then wrapped in
        SUBAGENT_EVENT moves to its sub-agent. Metrics only: the event never
        carries arguments or output, and nothing here would keep them.
        """
        if not isinstance(value, dict):
            return
        call_id = value.get("tool_call_id")
        token = str(call_id) if call_id is not None else f"tool-{self.next_seq}"
        tool_name = str(value.get("tool_name") or "")[:200] or "unknown tool"
        key = ("main", "", tool_name) if main_agent else ("subagent", self._subagent_label(task_id), tool_name)
        if self._book_once(self._tool_by_call, self.tool_groups, token, key):
            return
        contribution = {
            "calls": 1,
            "errors": 1 if value.get("status") == "error" else 0,
            "duration_ms": _as_int(value.get("duration_ms")),
            "output_chars": _as_int(value.get("output_chars")),
        }
        self._tool_by_call[token] = (key, contribution)
        _add_to_groups(self.tool_groups, key, contribution, 1)

    def _note_first_text(self, delta: Any) -> None:
        """Settle the answer's time to first text on its first non-empty delta."""
        if self._first_token_settled or not delta:
            return
        self._first_token_settled = True
        self.first_token_ms = max(0, round((time.perf_counter() - self.started_at) * 1000))

    @property
    def pending_interrupts(self) -> int:
        return len(self.pending_interrupt_ids)

    def register_interrupt(self, value: Any) -> None:
        # An approval before the first text makes the wait the human's: the
        # answer's time to first text is then left unmeasured (None).
        self._first_token_settled = True
        wrapped = value.get("interrupt") if isinstance(value, dict) else None
        raw_id = wrapped.get("id") if isinstance(wrapped, dict) else None
        token = str(raw_id) if raw_id is not None else f"anon-{self.next_seq}"
        if token not in self.pending_interrupt_ids:
            self.pending_interrupt_ids.append(token)

    def _register_presented_artifact(self, value: Any) -> None:
        """Record a PRESENT_ARTIFACT event's metadata, deduped by path.

        Only top-level (orchestrator) present calls reach here — a sub-agent's
        is never emitted as a top-level PRESENT_ARTIFACT (see the agents-service
        normalizer). Re-presenting the same path overwrites the earlier entry so
        the finalize fetch reads the file's latest bytes once."""
        if not isinstance(value, dict):
            return
        path = value.get("path")
        if not path:
            return
        entry = {
            "artifact_id": value.get("artifact_id"),
            "path": str(path),
            "title": value.get("title") or "",
            "summary": value.get("summary"),
        }
        self.presented_artifacts = [
            a for a in self.presented_artifacts if a["path"] != entry["path"]
        ]
        self.presented_artifacts.append(entry)

    def resolve_interrupt(self, interrupt_id: Any) -> None:
        token = str(interrupt_id) if interrupt_id is not None else None
        if token and token in self.pending_interrupt_ids:
            self.pending_interrupt_ids.remove(token)
        elif self.pending_interrupt_ids:
            self.pending_interrupt_ids.pop(0)

    def thinking_duration_seconds(self) -> int | None:
        if not (self.thinking_start or self.first_event_ts):
            return None
        start = self.first_event_ts or self.thinking_start
        end = self.thinking_end or time.perf_counter()
        return max(0, round(end - start))

    def _append_raw(self, event: dict[str, Any]) -> None:
        stored = deepcopy(event)
        if self.raw_events:
            last = self.raw_events[-1]
            if _merge_delta_into(last, stored):
                last["seq"] = stored.get("seq", last.get("seq"))
                return
            # SUBAGENT_EVENT envelopes wrap the inner delta, so the merge has
            # to happen one level down: same task_id + mergeable inner events.
            if (
                last.get("type") == "CUSTOM"
                and stored.get("type") == "CUSTOM"
                and last.get("name") == "SUBAGENT_EVENT"
                and stored.get("name") == "SUBAGENT_EVENT"
            ):
                last_value, stored_value = last.get("value"), stored.get("value")
                if (
                    isinstance(last_value, dict)
                    and isinstance(stored_value, dict)
                    and last_value.get("task_id") == stored_value.get("task_id")
                    and isinstance(last_value.get("event"), dict)
                    and isinstance(stored_value.get("event"), dict)
                    and _merge_delta_into(last_value["event"], stored_value["event"])
                ):
                    last["seq"] = stored.get("seq", last.get("seq"))
                    if stored.get("timestamp") is not None:
                        last["timestampEnd"] = stored["timestamp"]
                    return
        self.raw_events.append(stored)

    def apply_event(self, event: dict[str, Any]) -> dict[str, Any] | None:
        """Fold one upstream AG-UI event into the run state and return the
        seq-stamped wire event for the delta frame, or ``None`` for events that
        are captured internally but must not be persisted/streamed (e.g.
        CHECKPOINT_COMMITTED).

        Every event lands in ``raw_events`` (the durable per-run log the UI
        replays into its timeline); consecutive delta events are coalesced on
        append. Aggregates (``content``/``thoughts``) are kept only for
        previews, search, voice read-aloud and export.
        """
        event_type = event.get("type")
        if not self.first_event_ts:
            self.first_event_ts = time.perf_counter()
        self.next_seq += 1

        if event_type == "TOOL_CALL_RESULT":
            event = _truncate_tool_result(event)
        elif event_type == "CUSTOM" and event.get("name") == "SUBAGENT_EVENT":
            value = event.get("value")
            if isinstance(value, dict):
                inner = value.get("event")
                if isinstance(inner, dict) and inner.get("type") == "TOOL_CALL_RESULT":
                    truncated = _truncate_tool_result(inner)
                    if truncated is not inner:
                        event = {**event, "value": {**value, "event": truncated}}
        event = {**event, "seq": self.next_seq}

        if event_type == "CUSTOM":
            name = event.get("name")
            value = event.get("value")
            if name == "SUBAGENT_EVENT":
                # A subagent that emits __interrupt__ surfaces BOTH as a
                # top-level HITL_INTERRUPT (namespace in metadata) and as
                # SUBAGENT_EVENT(value={..., event: CUSTOM HITL_INTERRUPT}).
                # register_interrupt dedupes by interrupt.id, so whichever
                # envelope arrives second is a no-op and one approval resolves
                # the whole identity.
                if isinstance(value, dict):
                    inner = value.get("event")
                    if isinstance(inner, dict) and inner.get("type") == "CUSTOM":
                        inner_name = inner.get("name")
                        if inner_name == "HITL_INTERRUPT":
                            self.register_interrupt(inner.get("value"))
                        elif inner_name == "TOKEN_USAGE":
                            self._accumulate_usage(
                                inner.get("value"), main_agent=False, task_id=value.get("task_id")
                            )
                        elif inner_name == "TOOL_USAGE":
                            self._accumulate_tool_usage(
                                inner.get("value"), main_agent=False, task_id=value.get("task_id")
                            )
                        elif inner_name == "TASK_SUBAGENT":
                            # A sub-agent that delegates in turn: its `task` call
                            # arrives inside its own envelope, while the nested
                            # sub-agent's usage arrives under that call's id.
                            self._register_subagent_type(inner.get("value"))
            elif name == "HITL_INTERRUPT":
                self.register_interrupt(value)
            elif name == "TOKEN_USAGE":
                self._accumulate_usage(value, main_agent=True)
            elif name == "TOOL_USAGE":
                self._accumulate_tool_usage(value, main_agent=True)
            elif name == "TASK_SUBAGENT":
                self._register_subagent_type(value)
            elif name == "PRESENT_ARTIFACT":
                # Capture the deliverable for the finalize fetch, but let the
                # event flow into raw_events unchanged — the UI renders it as a
                # live artifact card (Phase 2) and it must survive reconnection.
                self._register_presented_artifact(value)
            elif name == "CHECKPOINT_COMMITTED":
                # Internal bridge<->agent metadata: capture the durable head but
                # do NOT persist it into raw_events (it is not a render event,
                # and it would carry the internal thread/checkpoint uuids into
                # share snapshots + conversation clones). Suppressed from the
                # wire and the durable log by returning None below.
                if isinstance(value, dict):
                    committed = value.get("checkpoint_id")
                    if committed:
                        self.produced_checkpoint_id = str(committed)
                return None
        elif event_type == "THINKING_START":
            self.thinking_start = time.perf_counter()
            self.thinking_end = 0.0
        elif event_type == "THINKING_TEXT_MESSAGE_CONTENT":
            self.thoughts.append(str(event.get("delta") or ""))
        elif event_type == "TOOL_CALL_START":
            self.thoughts.append(f"[tool] {event.get('toolCallName') or 'tool'}")
        elif event_type == "THINKING_END":
            self.thinking_end = time.perf_counter()
        elif event_type in _TEXT_DELTA_TYPES:
            self.content += str(event.get("delta") or "")
            # Top-level text is the main agent's (a sub-agent's arrives wrapped
            # in SUBAGENT_EVENT), so this is the answer's first token.
            self._note_first_text(event.get("delta"))
            if not self.closed_thinking_on_first_chunk:
                self.closed_thinking_on_first_chunk = True
                self.thinking_end = time.perf_counter()

        self._append_raw(event)
        return event


class InferenceRunManager:
    def __init__(self) -> None:
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._cancel_events: dict[str, asyncio.Event] = {}
        # Live run state exposed to WebSocket subscribers: a late subscriber
        # gets one synthesized snapshot frame built from the in-process
        # runtime (full coalesced event log) instead of replaying the Redis
        # stream from 0, which makes MAXLEN trimming irrelevant.
        self._runtimes: dict[str, InferenceRunRuntime] = {}
        self._run_metas: dict[str, dict[str, Any]] = {}
        # HITL resume signalling: a per-run event flipped by the bridge /resume
        # route, plus the structured payload the route hands to the manager so
        # _do_resume can forward it to the agents-service /resume endpoint.
        self._resume_events: dict[str, asyncio.Event] = {}
        self._resume_payloads: dict[str, dict[str, Any]] = {}

    def launch(self, run_id: str) -> None:
        if run_id in self._tasks and not self._tasks[run_id].done():
            return
        cancel_event = asyncio.Event()
        self._cancel_events[run_id] = cancel_event
        self._resume_events[run_id] = asyncio.Event()
        task = asyncio.create_task(self._run(run_id, cancel_event))
        self._tasks[run_id] = task
        task.add_done_callback(lambda _: (
            self._tasks.pop(run_id, None),
            self._cancel_events.pop(run_id, None),
            self._runtimes.pop(run_id, None),
            self._run_metas.pop(run_id, None),
            self._resume_events.pop(run_id, None),
            self._resume_payloads.pop(run_id, None),
        ))

    def request_cancel(self, run_id: str) -> bool:
        event = self._cancel_events.get(run_id)
        if event:
            event.set()
            return True
        return False

    def request_resume(self, run_id: str, payload: dict[str, Any]) -> bool:
        """Hand a resume payload to a paused run and unblock its _run task.

        Returns True only if a live _run task is currently waiting on the
        resume event; the caller (bridge /resume route) uses False to surface
        a 409 to the client because the run is not actually paused.
        """
        event = self._resume_events.get(run_id)
        if event is None or not self.has_live_task(run_id):
            return False
        self._resume_payloads[run_id] = payload
        event.set()
        return True

    def has_live_task(self, run_id: str) -> bool:
        task = self._tasks.get(run_id)
        return bool(task and not task.done())

    def build_live_snapshot(self, run_id: str) -> dict[str, Any] | None:
        """Synthesize a snapshot frame for an in-flight run from the
        in-process runtime: full coalesced event log + current run meta.

        Returns None when this process doesn't own a live task for the run
        (other replica, or the run already terminated) — callers fall back to
        replaying the Redis stream from the beginning.
        """
        runtime = self._runtimes.get(run_id)
        run_meta = self._run_metas.get(run_id)
        if runtime is None or run_meta is None or not self.has_live_task(run_id):
            return None
        return {
            "type": "snapshot",
            "run": {
                **run_meta,
                "updatedAt": _now().isoformat(),
                "pendingInterrupts": runtime.pending_interrupts,
                "rawEvents": deepcopy(runtime.raw_events),
            },
            "message": None,
            "summary": None,
        }

    async def publish_run_status(self, run: MessageTable, *, user_id: str) -> None:
        """Publish a status-only delta frame (no events) so observers learn
        about lifecycle flips that happen outside the stream loop, e.g. a
        cancel request moving the run to ``cancelling``/``cancelled``.
        """
        frame = {
            "type": "events",
            "events": [],
            "run": build_run_out_from_message(run, user_id=user_id).model_dump(mode="json", by_alias=False),
        }
        await self.publish(run.id, frame)

    async def publish(self, run_id: str, event: dict[str, Any]) -> None:
        """Append the event to the durable per-run Redis Stream.

        Subscribers consume via :func:`stream_run_events` over the WebSocket
        endpoint, backed by the same stream. Failure to write is logged but
        never raised — losing the wire frame is preferable to crashing the
        inference run.
        """
        try:
            await event_log.append(run_id, event)
        except Exception:
            logger.error(
                "event_log_publish_failed",
                "Failed to append inference event to Redis stream",
                exc_info=True,
                run_id=run_id,
            )

    async def _run(self, run_id: str, cancel_event: asyncio.Event) -> None:
        runtime = InferenceRunRuntime()
        self._runtimes[run_id] = runtime
        try:
            async with SessionLocal() as db:
                run = await _load_run(db, run_id)
                if not run or run.streaming_status not in ACTIVE_RUN_STATUSES:
                    return
                run.streaming_status = "running"
                run.updated_at = _now()
                await db.commit()

            async with SessionLocal() as db:
                run = await _load_run(db, run_id)
                if not run:
                    return
                # The owning user_id is resolved via the conversation row since
                # the assistant message itself doesn't carry user_id directly.
                conv_row = await db.get(ConversationTable, run.conversation_id)
                if not conv_row:
                    return
                user_id = conv_row.user_id
                # Reload with eager-loaded messages for the inference history builder.
                conversation = await validate_convId_full(user_id, run.conversation_id, db)
                started_at = run.streaming_started_at or run.created_at
                # Capture static run fields once so the stream loop can build
                # lightweight in-memory events without hitting the DB per chunk.
                run_meta: dict[str, Any] = {
                    "id": run.id,
                    "userId": user_id,
                    "conversationId": run.conversation_id,
                    "assistantMessageId": run.id,
                    "parentMessageId": run.parent_message_id,
                    "status": "running",
                    "messagePath": run.streaming_message_path or [],
                    "startedAt": started_at.isoformat(),
                    "updatedAt": started_at.isoformat(),
                    "errorMessage": None,
                    "completedAt": None,
                    "cancelRequestedAt": None,
                }
                self._run_metas[run_id] = run_meta
                # Per-message agent: resolve from the run (the AI message) so a
                # conversation can mix agents. Fall back to the conversation's
                # agent for pre-migration runs whose message has no agent_id.
                agent = await get_agent_by_id(run.agent_id or conversation.agent_id)
                agent_url = build_agent_stream_url(agent)
                resume_url = build_agent_resume_url(agent)
                # Deep agents have a per-conversation filesystem; LangGraph
                # agents do not. Only deep agents get files seeded into input/
                # and the input/ path references in serialised attachments.
                is_deep_agent = getattr(agent, "type", "") == "deep agent"

                # Decide how to feed the agent this turn against its durable
                # checkpoint thread (re-derived from the message tree):
                #   delta_resume — the branch thread already has committed state
                #     (a `send` continuing the leaf) → send only the new message.
                #   delta_fork — a fresh branch thread (edit/retry) whose fork
                #     point is a committed ancestor on the parent branch → send
                #     the new message + fork_from so the agent seeds the new
                #     thread from that checkpoint before running.
                #   full_seed — no committed checkpoint to resume/fork from (new
                #     conversation, pre-migration branch, shared_continue, or a
                #     fork target that never committed) → send the full
                #     reconstructed history, seeding a fresh checkpoint. The next
                #     turn on this branch is then delta.
                # thread_id is branch-scoped (shared across a branch's runs);
                # run.id stays the per-run id (run_id below) the agents-service
                # normalizer uses for AG-UI message_id + namespace bindings.
                thread_id = run.checkpoint_thread_id or str(run.id)
                parent_user_message = next(
                    (m for m in conversation.messages if m.id == run.parent_message_id), None
                )
                committed_ancestor = nearest_committed_ai(conversation.messages, run.parent_message_id)
                fork_from: dict[str, str] | None = None

                if (
                    parent_user_message is not None
                    and committed_ancestor is not None
                    and committed_ancestor.checkpoint_thread_id == thread_id
                ):
                    payload_mode = "delta_resume"
                elif parent_user_message is not None and committed_ancestor is not None:
                    payload_mode = "delta_fork"
                    fork_from = {
                        "thread_id": committed_ancestor.checkpoint_thread_id,
                        "checkpoint_id": committed_ancestor.checkpoint_id,
                    }
                else:
                    payload_mode = "full_seed"

                if payload_mode == "full_seed":
                    _history_messages, history = prepare_inference_history(
                        logger=logger,
                        messages=conversation.messages,
                        message_ids=run.streaming_message_path,
                        include_input_paths=is_deep_agent,
                    )
                    sent_messages = len(history)
                else:
                    history = [
                        serialise_message_with_images_for_agent(
                            parent_user_message, include_input_paths=is_deep_agent
                        )
                    ]
                    sent_messages = 1

                logger.info(
                    "inference_run_started",
                    "Detached inference run started",
                    run_id=run.id,
                    conversation_id=run.conversation_id,
                    thread_id=thread_id,
                    payload_mode=payload_mode,
                    forked=fork_from is not None,
                    sent_messages=sent_messages,
                )
                # Per-user prefs, loaded once and threaded into the run context.
                # `search_past_convs` (opt-in) gates the deep agent's
                # cross-conversation `search_past_conversations` tool; `use_memory`
                # (on by default) gates its persistent memory (the /memories/
                # AGENTS.md + entries mount and the `remember` tool). Both default
                # to the no-row stance.
                prefs_row = (
                    await db.execute(
                        select(UserPreferencesTable).where(UserPreferencesTable.user_id == user_id)
                    )
                ).scalar_one_or_none()
                search_past_convs = bool(prefs_row.search_past_convs) if prefs_row else False
                use_memory = bool(prefs_row.use_memory) if prefs_row else True
                # Personalization (personality preset + custom instructions) from
                # the same row — only *effective* data is threaded: the preset
                # when non-default, the custom-instruction fields only while the
                # user has them enabled and non-empty. A run with no effective
                # personalization carries no `personalization` key at all, so
                # its agent prompt is byte-identical to the pre-feature one. The
                # agents service re-validates the payload fail-closed on its side.
                personalization = _effective_personalization(prefs_row)
                tool_config = await agent_tool_prefs.read_config(db, str(user_id), agent.slug)

                # Shared config block forwarded to both the initial /stream call
                # and any /resume legs. thread_id keys the durable saver (branch-
                # scoped); run_id is the per-run identity for the AG-UI layer.
                base_request_config: dict[str, Any] = {
                    "run_config": {
                        "configurable": {"thread_id": thread_id},
                    },
                    "context": {
                        "user_id": str(user_id),
                        "conversation_id": str(run.conversation_id),
                        "run_id": str(run.id),
                        "search_past_convs": search_past_convs,
                        "use_memory": use_memory,
                        # Someone is watching this run and can answer it. A
                        # scheduled task's run has nobody to resume a pause,
                        # so its agent never gets `ask_user`.
                        "interactive": run_is_interactive(run),
                        # The user's per-agent tool choices, from chat_db,
                        # decoded once by the agent's abstraction layer. They
                        # ride the run config rather than being materialised on
                        # the agents volume, exactly like the two above.
                        "tool_config": tool_config,
                        # Whose agent this is: absent/None for a platform agent,
                        # the owner's id for a user-authored one. The agents
                        # service resolves the definition from the global
                        # registry or that user's workspace accordingly — the DB
                        # is the authority, so a user can never shadow a
                        # platform agent by naming theirs the same.
                        **(
                            {"agent_owner_id": str(agent.owner_user_id)}
                            if getattr(agent, "owner_user_id", None)
                            else {}
                        ),
                        **({"personalization": personalization} if personalization else {}),
                        # The slash command this turn runs (plan 35). It rides the
                        # shared block, so the /resume legs of a paused run keep
                        # it too — a paused /code-review must stay read-only.
                        **command_context(parent_user_message),
                    },
                }
                if fork_from is not None:
                    # Consumed by /stream only (idempotent seed before the run);
                    # /resume ignores it.
                    base_request_config["fork_from"] = fork_from
                request_payload: dict[str, Any] = {
                    "messages": history,
                    "config": base_request_config,
                }

            cancel_waiter = asyncio.create_task(cancel_event.wait())
            # First leg: the initial /stream call. Subsequent legs (if any) come
            # from /resume after each HITL interrupt.
            stream_task: asyncio.Task[str] = asyncio.create_task(
                self._do_stream(run_id, run_meta, runtime, agent_url, request_payload)
            )

            try:
                while True:
                    done, _ = await asyncio.wait(
                        {stream_task, cancel_waiter},
                        return_when=asyncio.FIRST_COMPLETED,
                    )

                    # Cancellation wins outright: kill the in-flight HTTP stream
                    # and mark the run cancelled. _do_stream may emit one more
                    # frame after cancellation; that's fine — it's in Redis.
                    if cancel_waiter in done and stream_task not in done:
                        stream_task.cancel()
                        await asyncio.gather(stream_task, return_exceptions=True)
                        await _mark_run_cancelled(run_id, runtime)
                        await self._publish_snapshot(run_id, "terminal")
                        return

                    # Stream leg ended. Surface upstream errors, then decide
                    # whether the run is genuinely terminal, paused on a HITL
                    # interrupt, or implicitly failed.
                    if not stream_task.cancelled():
                        exc = stream_task.exception()
                        if exc:
                            raise exc
                        result = stream_task.result()
                        if result == "failed":
                            # _do_stream already marked the run failed via _finish_run.
                            return

                    if cancel_event.is_set():
                        await _mark_run_cancelled(run_id, runtime)
                        await self._publish_snapshot(run_id, "terminal")
                        return

                    # No interrupt pending → normal terminal completion.
                    if runtime.pending_interrupts <= 0:
                        await _mark_run_completed(run_id, runtime)
                        await self._publish_snapshot(run_id, "terminal")
                        return

                    # Paused on a HITL interrupt. Hold the task alive and race
                    # the cancel event against the bridge /resume signal.
                    resume_event = self._resume_events.get(run_id)
                    if resume_event is None:
                        # Shouldn't happen (launch sets it) — treat as failure.
                        await _mark_run_failed(run_id, runtime, "Resume signalling not initialised.")
                        await self._publish_snapshot(run_id, "terminal")
                        return

                    logger.info(
                        "inference_run_awaiting_resume",
                        "Run paused on HITL interrupt; awaiting resume signal",
                        run_id=run_id,
                        pending_interrupts=runtime.pending_interrupts,
                    )

                    resume_waiter = asyncio.create_task(resume_event.wait())
                    try:
                        done, _ = await asyncio.wait(
                            {resume_waiter, cancel_waiter},
                            return_when=asyncio.FIRST_COMPLETED,
                        )
                    finally:
                        if not resume_waiter.done():
                            resume_waiter.cancel()
                            await asyncio.gather(resume_waiter, return_exceptions=True)

                    if cancel_waiter in done:
                        await _mark_run_cancelled(run_id, runtime)
                        await self._publish_snapshot(run_id, "terminal")
                        return

                    # Resume requested. Resolve the pending identity for the
                    # interrupt we're now resolving and kick off /resume.
                    resume_payload = self._resume_payloads.pop(run_id, {}) or {}
                    runtime.resolve_interrupt(resume_payload.get("interrupt_id"))
                    resume_event.clear()
                    # Persist the resolution in the event log itself so a
                    # reloaded client doesn't re-show an answered approval —
                    # resolution state must survive in the durable log, not in
                    # client memory.
                    # `decisions` (per-action list) drives the UI's per-tool
                    # approval chips for a batched interrupt; the scalar
                    # `decision` (overall: approve if any approved) keeps the
                    # single-action reducer path and legacy clients working.
                    resume_decisions = resume_payload.get("decisions")
                    overall_decision = resume_payload.get("decision", "approve")
                    if resume_decisions:
                        overall_decision = (
                            "approve" if any(d.get("decision") == "approve" for d in resume_decisions) else "reject"
                        )
                    marker = runtime.apply_event({
                        "type": "CUSTOM",
                        "name": "BRIDGE_HITL_RESOLVED",
                        "value": hitl_resolved_value(resume_payload, overall_decision),
                        "timestamp": int(time.time() * 1000),
                    })
                    await self._publish_delta(run_id, run_meta, runtime, [marker])
                    logger.info(
                        "inference_run_resume_dispatched",
                        "Dispatching resume to agents service",
                        run_id=run_id,
                        decision=resume_payload.get("decision"),
                    )

                    stream_task = asyncio.create_task(
                        self._do_resume(run_id, run_meta, runtime, resume_url, base_request_config, resume_payload)
                    )
            finally:
                if not cancel_waiter.done():
                    cancel_waiter.cancel()
                    await asyncio.gather(cancel_waiter, return_exceptions=True)
        except asyncio.CancelledError:
            await _mark_run_cancelled(run_id, runtime)
            await self._publish_snapshot(run_id, "terminal")
        except Exception:
            logger.error("inference_run_failed", "Detached inference run failed", exc_info=True, run_id=run_id)
            await _mark_run_failed(run_id, runtime, "The agent stream ended unexpectedly.")
            await self._publish_snapshot(run_id, "terminal")
        finally:
            self._cancel_events.pop(run_id, None)

    async def _do_stream(
        self,
        run_id: str,
        run_meta: dict[str, Any],
        runtime: InferenceRunRuntime,
        agent_url: str,
        request_payload: dict[str, Any],
    ) -> str:
        sse_buffer = ""
        timeout = settings.http.inference_timeout
        async with httpx.AsyncClient(timeout=timeout, verify=get_httpx_verify(), cert=get_httpx_client_cert()) as client:
            headers = internal_service_headers(get_context().get("request_id"))
            headers["Accept"] = "text/event-stream"
            async with client.stream("POST", agent_url, json=request_payload, headers=headers) as response:
                response.raise_for_status()
                async for chunk in response.aiter_bytes():
                    sse_buffer, events = _parse_sse_bytes(sse_buffer, chunk)
                    new_events: list[dict[str, Any]] = []
                    for event in events:
                        if event.get("type") == "RUN_ERROR":
                            runtime.apply_event(event)
                            await _mark_run_failed(run_id, runtime, str(event.get("message") or "Agent stream failed."))
                            await self._publish_snapshot(run_id, "terminal")
                            return "failed"
                        applied = runtime.apply_event(event)
                        if applied is not None:
                            new_events.append(applied)
                    if new_events:
                        await self._publish_delta(run_id, run_meta, runtime, new_events)
        return "completed"

    async def _do_resume(
        self,
        run_id: str,
        run_meta: dict[str, Any],
        runtime: InferenceRunRuntime,
        resume_url: str,
        base_request_config: dict[str, Any],
        resume_payload: dict[str, Any],
    ) -> str:
        """Resume a paused HITL run via the agents-service /resume endpoint.

        The body shape matches :class:`AgentResumeRequest` on the agents side.
        Output framing is identical to ``/stream`` so the existing SSE parser,
        runtime accumulator, and Redis publisher all work unchanged.
        """
        sse_buffer = ""
        thread_id = base_request_config.get("run_config", {}).get("configurable", {}).get("thread_id", "")
        body: dict[str, Any] = {
            "config": base_request_config,
            "thread_id": thread_id,
            "decision": resume_payload.get("decision", "approve"),
            "reason": resume_payload.get("reason"),
            "value": resume_payload.get("value"),
            "interrupt_id": resume_payload.get("interrupt_id"),
            "decisions": resume_payload.get("decisions"),
        }
        timeout = settings.http.inference_timeout
        async with httpx.AsyncClient(timeout=timeout, verify=get_httpx_verify(), cert=get_httpx_client_cert()) as client:
            headers = internal_service_headers(get_context().get("request_id"))
            headers["Accept"] = "text/event-stream"
            try:
                async with client.stream("POST", resume_url, json=body, headers=headers) as response:
                    response.raise_for_status()
                    async for chunk in response.aiter_bytes():
                        sse_buffer, events = _parse_sse_bytes(sse_buffer, chunk)
                        new_events: list[dict[str, Any]] = []
                        for event in events:
                            if event.get("type") == "RUN_ERROR":
                                runtime.apply_event(event)
                                await _mark_run_failed(run_id, runtime, str(event.get("message") or "Agent resume failed."))
                                await self._publish_snapshot(run_id, "terminal")
                                return "failed"
                            applied = runtime.apply_event(event)
                            if applied is not None:
                                new_events.append(applied)
                        if new_events:
                            await self._publish_delta(run_id, run_meta, runtime, new_events)
            except httpx.HTTPStatusError as exc:
                # 409 → checkpoint missing (process restart or LRU eviction).
                # Anything else upstream → fail the run with the status code in the message.
                status_code = exc.response.status_code if exc.response is not None else None
                detail = "Inference run could not be resumed."
                if status_code == 409:
                    detail = "The agent has no paused checkpoint for this run. Start a new message instead."
                await _mark_run_failed(run_id, runtime, detail)
                await self._publish_snapshot(run_id, "terminal")
                return "failed"
        return "completed"

    async def _publish_delta(
        self,
        run_id: str,
        run_meta: dict[str, Any],
        runtime: InferenceRunRuntime,
        events: list[dict[str, Any]],
    ) -> None:
        """Publish the new seq-stamped events of one upstream chunk.

        Frames are O(chunk), not O(run): the client folds them into its
        timeline incrementally and a late subscriber gets the synthesized
        snapshot frame first, so nothing here needs to be cumulative.
        """
        frame = {
            "type": "events",
            "run": {
                **run_meta,
                "updatedAt": _now().isoformat(),
                "pendingInterrupts": runtime.pending_interrupts,
            },
            "events": events,
        }
        await self.publish(run_id, frame)

    async def _publish_snapshot(self, run_id: str, event_type: str) -> None:
        async with SessionLocal() as db:
            payload = await build_run_event_payload(db, run_id, event_type)
        if payload:
            await self.publish(run_id, payload)
        if event_type == "terminal":
            # Stamp a TTL on the stream so reconnecting clients can still replay
            # for the configured window. After expiry Redis drops the stream and
            # the durable record stays in PostgreSQL.
            try:
                await event_log.mark_terminal(run_id)
            except Exception:
                logger.warning(
                    "event_log_mark_terminal_failed",
                    "Failed to set terminal TTL on Redis stream",
                    exc_info=True,
                    run_id=run_id,
                )


inference_run_manager = InferenceRunManager()


async def _load_run(db: AsyncSession, run_id: str) -> MessageTable | None:
    """Load the AI message that represents a streaming run.

    ``run_id`` is the assistant message ID — after the InferenceRunTable collapse
    the message row carries the streaming_* columns that used to live there.
    """
    result = await db.execute(select(MessageTable).where(MessageTable.id == run_id))
    return result.scalar_one_or_none()


async def _load_message(db: AsyncSession, message_id: str) -> MessageTable | None:
    result = await db.execute(
        select(MessageTable)
        .options(selectinload(MessageTable.attachments).selectinload(AttachmentTable.blob))
        .where(MessageTable.id == message_id)
    )
    return result.scalar_one_or_none()



async def _record_usage_breakdown(
    db: AsyncSession,
    run: MessageTable,
    conversation: ConversationTable,
    runtime: InferenceRunRuntime,
    activity: RunActivity,
) -> None:
    """Book a finished answer's usage for the Usage tab (plan 33).

    Writes one ``message_usage`` row per (scope, agent, model) group and one
    ``tool_usage`` row per (scope, agent, tool) (plan 41), adds the answer to
    its conversation's running totals, and adds it to the user's daily rollups
    (``tool_usage_daily`` included) — all in the caller's transaction, so the
    answer and every figure derived from it land together or not at all. Totals are SQL
    expressions (``col = col + n``), so runs finishing concurrently can never
    lose each other's update.
    """
    created_at = run.created_at or _now()
    main_label = run.agent_name or "Agent"
    for (scope, agent_name, model_name), group in runtime.usage_groups.items():
        db.add(
            MessageUsageTable(
                message_id=run.id,
                conversation_id=run.conversation_id,
                user_id=conversation.user_id,
                agent_id=run.agent_id,
                main_agent_name=run.agent_name,
                scope=scope,
                agent_name=main_label if scope == "main" else agent_name,
                model_name=model_name,
                created_at=created_at,
                **group,
            )
        )
    # What the answer's tools took (plan 41), split the same way.
    for (scope, agent_name, tool_name), group in runtime.tool_groups.items():
        db.add(
            ToolUsageTable(
                message_id=run.id,
                conversation_id=run.conversation_id,
                user_id=conversation.user_id,
                agent_id=run.agent_id,
                main_agent_name=run.agent_name,
                scope=scope,
                agent_name=main_label if scope == "main" else agent_name,
                tool_name=tool_name,
                created_at=created_at,
                **group,
            )
        )
    # The day's tool rollup keys on the main agent and the tool alone: a
    # sub-agent's calls of a tool count under the agent that delegated them.
    tools_by_name: dict[str, dict[str, int]] = {}
    for (_scope, _agent, tool_name), group in runtime.tool_groups.items():
        total = tools_by_name.setdefault(tool_name, dict.fromkeys(group, 0))
        for field, amount in group.items():
            total[field] += amount

    table = ConversationTable
    conversation.usage_answers = table.usage_answers + 1
    conversation.usage_input_tokens = table.usage_input_tokens + runtime.input_tokens
    conversation.usage_cached_tokens = table.usage_cached_tokens + runtime.cached_input_tokens
    conversation.usage_output_tokens = table.usage_output_tokens + runtime.output_tokens
    conversation.usage_total_tokens = table.usage_total_tokens + runtime.input_tokens + runtime.output_tokens
    conversation.usage_model_calls = table.usage_model_calls + activity.model_calls
    conversation.usage_tool_calls = table.usage_tool_calls + activity.tool_calls
    conversation.usage_model_ms = table.usage_model_ms + runtime.model_latency_ms
    conversation.usage_cost_micros = table.usage_cost_micros + runtime.cost_micros
    conversation.usage_truncated_calls = table.usage_truncated_calls + runtime.truncated_calls
    if runtime.context.get("context_tokens") is not None:
        conversation.last_context_tokens = runtime.context["context_tokens"]
        conversation.last_context_window = runtime.context.get("context_window")
    conversation.usage_updated_at = _now()

    await add_answer_to_rollups(
        db,
        user_id=conversation.user_id,
        day=created_at.date(),
        agent_id=run.agent_id,
        agent_name=run.agent_name,
        answer={
            "answers": 1,
            "input_tokens": runtime.input_tokens,
            "cached_input_tokens": runtime.cached_input_tokens,
            "output_tokens": runtime.output_tokens,
            "reasoning_tokens": runtime.reasoning_tokens,
            "model_ms": runtime.model_latency_ms,
            "model_calls": activity.model_calls,
            "tool_calls": activity.tool_calls,
            # Every answer finished from here on records calls and model time.
            "detailed_answers": 1,
            "detailed_input_tokens": runtime.input_tokens,
            "cost_micros": runtime.cost_micros,
            "unpriced_calls": runtime.unpriced_calls,
            "truncated_calls": runtime.truncated_calls,
            # Added only when measured: first_token_answers is the average's
            # denominator, so an unmeasured answer never drags it down.
            "first_token_ms": runtime.first_token_ms or 0,
            "first_token_answers": 1 if runtime.first_token_ms is not None else 0,
        },
        groups=[
            {
                "scope": scope,
                "group_name": main_label if scope == "main" else agent_name,
                "model_name": model_name or "",
                "calls": group["calls"],
                "input_tokens": group["input_tokens"],
                "cached_input_tokens": group["cached_input_tokens"],
                "output_tokens": group["output_tokens"],
                "reasoning_tokens": group["reasoning_tokens"],
                "model_ms": group["model_latency_ms"],
                **{field: group[field] for field in _GROUP_METRICS},
            }
            for (scope, agent_name, model_name), group in runtime.usage_groups.items()
        ],
        tools=[{"tool_name": name, **counters} for name, counters in tools_by_name.items()],
    )


async def _finish_run(run_id: str, runtime: InferenceRunRuntime, status_value: str, error_message: str | None = None) -> None:
    async with SessionLocal() as db:
        run = await _load_run(db, run_id)
        if not run:
            return
        if run.streaming_status in TERMINAL_RUN_STATUSES:
            return
        # If a cancel was requested mid-flight, normalize a "completed" verdict
        # to "cancelled" so the user-visible outcome matches their intent.
        if status_value == "completed" and (
            run.streaming_status == "cancelling" or run.streaming_cancel_requested_at is not None
        ):
            status_value = "cancelled"
            error_message = None

        is_error = status_value == "failed"
        payload = _message_payload_from_runtime(runtime, error=is_error, error_message=error_message)

        # Write streaming metadata + final content onto the single MessageTable row.
        run.streaming_status = status_value
        run.streaming_completed_at = _now()
        run.content = payload["content"] or (
            "An error occurred while generating the response." if is_error else ""
        )
        run.reasoning_steps = payload["reasoning_steps"]
        run.reasoning_time_seconds = payload["reasoning_time_seconds"]
        run.raw_events = payload["raw_events"]
        run.input_tokens = runtime.input_tokens or None
        run.output_tokens = runtime.output_tokens or None
        run.cached_input_tokens = runtime.cached_input_tokens or None
        run.reasoning_tokens = runtime.reasoning_tokens or None
        run.model_latency_ms = runtime.model_latency_ms or None
        run.context_tokens = runtime.context.get("context_tokens")
        run.context_window = runtime.context.get("context_window")
        run.compaction_percent = runtime.context.get("compaction_percent")
        run.model_name = runtime.context.get("model_name")
        # Only an answer that spent tokens has work to count; one that failed
        # before its first model call stays NULL, like its token columns.
        has_usage = bool(runtime.input_tokens or runtime.output_tokens)
        activity = count_run_activity(payload["raw_events"])
        run.model_calls = activity.model_calls if has_usage else None
        run.tool_calls = activity.tool_calls if has_usage else None
        # Plan 41's figures, NULL like the counts above on an answer that spent
        # nothing. On one that did, a 0 is a measurement (no call was cut off).
        for field in _GROUP_METRICS:
            setattr(run, field, getattr(runtime, field) if has_usage else None)
        # Measured by the bridge from the text it saw, so kept whenever there was
        # text — None when there was none, or when a HITL approval came first.
        run.first_token_ms = runtime.first_token_ms
        run.is_error = is_error
        run.error_message = error_message
        # Advance the branch head so the next turn resumes / forks from the
        # state this run committed. Only overwrite when the agent actually
        # reported a head (keep any prior value otherwise).
        if runtime.produced_checkpoint_id:
            run.checkpoint_id = runtime.produced_checkpoint_id
        run.updated_at = _now()

        conversation = await db.get(ConversationTable, run.conversation_id)
        if conversation:
            if conversation.active_assistant_message_id == run.id:
                conversation.active_assistant_message_id = None
            preview = _preview(run.content)
            if preview:
                conversation.last_message_preview = preview
            conversation.last_message_at = _now()
            conversation.updated_at = _now()
            if has_usage:
                await _record_usage_breakdown(db, run, conversation, runtime, activity)

        # The files the agent presented this run, in this transaction: their
        # cards must find them when the terminal frame reaches the UI.
        await capture_presented_files(db, run, conversation, runtime.presented_artifacts)

        await db.commit()


async def _mark_run_completed(run_id: str, runtime: InferenceRunRuntime) -> None:
    await _finish_run(run_id, runtime, "completed")


async def _mark_run_cancelled(run_id: str, runtime: InferenceRunRuntime) -> None:
    await _finish_run(run_id, runtime, "cancelled")


async def _mark_run_failed(run_id: str, runtime: InferenceRunRuntime, error_message: str) -> None:
    await _finish_run(run_id, runtime, "failed", error_message)


async def mark_run_launch_failed(run_id: str) -> None:
    await _finish_run(run_id, InferenceRunRuntime(), "failed", "Inference run could not be launched.")


def build_run_out_from_message(message: MessageTable, *, user_id: str) -> InferenceRunOut:
    """Build the wire-shape :class:`InferenceRunOut` from a :class:`MessageTable`.

    After the inference_runs-table collapse the "run" is just the assistant
    message with ``streaming_*`` columns. The wire shape is preserved so the
    frontend doesn't need a parallel migration: ``id`` and ``assistantMessageId``
    are both the message ID.
    """
    started = message.streaming_started_at or message.created_at
    return InferenceRunOut(
        id=message.id,
        userId=user_id,
        conversationId=message.conversation_id,
        assistantMessageId=message.id,
        parentMessageId=message.parent_message_id,
        status=message.streaming_status or "completed",
        scheduledTaskId=message.scheduled_task_id,
        messagePath=message.streaming_message_path or [],
        content=message.content,
        thinking=message.reasoning_steps,
        rawEvents=message.raw_events or [],
        inputTokens=message.input_tokens,
        outputTokens=message.output_tokens,
        cachedInputTokens=message.cached_input_tokens,
        reasoningTokens=message.reasoning_tokens,
        modelLatencyMs=message.model_latency_ms,
        contextTokens=message.context_tokens,
        contextWindow=message.context_window,
        compactionPercent=message.compaction_percent,
        modelName=message.model_name,
        costMicros=message.cost_micros,
        unpricedCalls=message.unpriced_calls,
        truncatedCalls=message.truncated_calls,
        firstTokenMs=message.first_token_ms,
        ttftMs=message.ttft_ms,
        ttftCalls=message.ttft_calls,
        genMs=message.gen_ms,
        genOutputTokens=message.gen_output_tokens,
        errorMessage=message.error_message,
        startedAt=started,
        completedAt=message.streaming_completed_at,
        cancelRequestedAt=message.streaming_cancel_requested_at,
        updatedAt=message.updated_at,
    )


async def build_run_event_payload(db: AsyncSession, run_id: str, event_type: str) -> dict[str, Any] | None:
    run = await _load_run(db, run_id)
    if not run:
        return None
    # `_load_run` returns a bare MessageTable; reload with attachments eagerly so
    # the wire-side MessageOut serializer doesn't lazy-load mid-coroutine.
    message = await _load_message(db, run.id)
    conversation = await db.get(ConversationTable, run.conversation_id)
    if conversation is not None:
        await db.refresh(conversation, attribute_names=["agent"])
    user_id = conversation.user_id if conversation else ""
    return {
        "type": event_type,
        "run": build_run_out_from_message(run, user_id=user_id).model_dump(mode="json", by_alias=False),
        "message": MessageOut.model_validate(message).model_dump(mode="json", by_alias=False) if message else None,
        "summary": ConversationSummary.model_validate(conversation).model_dump(mode="json", by_alias=False) if conversation else None,
    }


SNAPSHOT_SEQ_SENTINEL = "__snapshot__"


async def stream_run_events(
    run_id: str,
    since: str | None = None,
) -> AsyncIterator[tuple[str, dict[str, Any]]]:
    """Yield ``(seq, event)`` pairs from the run's stream for WebSocket consumers.

    The entry ID is exposed as the ``seq`` cursor so the client can resume
    after disconnect. Frames carrying the :data:`SNAPSHOT_SEQ_SENTINEL` seq
    must NOT be sent back as a ``since`` cursor.

    - Terminal run: one DB-built snapshot frame, then return.
    - Fresh subscribe (``since`` is None) on an in-flight run owned by this
      process: one synthesized live snapshot frame (full coalesced log), then
      live-tail from the stream position captured *before* the snapshot was
      built. Events published in between appear in both — the client's
      per-event ``seq`` guard dedupes them.
    - Reconnect (``since`` given) or no in-process runtime: plain Redis replay.
    """
    async with SessionLocal() as db:
        run = await _load_run(db, run_id)
        if run and run.streaming_status in TERMINAL_RUN_STATUSES:
            snapshot = await build_run_event_payload(db, run_id, "snapshot")
            if snapshot:
                yield (SNAPSHOT_SEQ_SENTINEL, snapshot)
            return

    cursor = since
    if cursor is None:
        last_entry_id = await event_log.last_entry_id(run_id)
        live_snapshot = inference_run_manager.build_live_snapshot(run_id)
        if live_snapshot is not None:
            yield (SNAPSHOT_SEQ_SENTINEL, live_snapshot)
            cursor = last_entry_id

    # Escape hatch for the tail loop: if the run reaches a terminal status in
    # the DB but its terminal frame never flows through this consumer's XREAD
    # (publish raced the subscribe, stream trimmed), the generator would block
    # forever and the client would never get the closing terminal frame.
    async def _run_went_terminal() -> bool:
        async with SessionLocal() as idle_db:
            status_value = await idle_db.scalar(
                select(MessageTable.streaming_status).where(MessageTable.id == run_id)
            )
        return status_value is None or status_value in TERMINAL_RUN_STATUSES

    async for entry_id, event in event_log.read_since(
        run_id,
        cursor if cursor else "0",
        terminal_statuses=TERMINAL_RUN_STATUSES,
        on_idle=_run_went_terminal,
    ):
        yield (entry_id, event)


def _is_active_run_integrity_conflict(exc: IntegrityError) -> bool:
    text = str(exc.orig).lower()
    return (
        "uq_messages_one_active_stream_per_conversation" in text
        or "messages_conversation_id" in text
    )


async def _fail_stale_queued_runs_for_conversation(db: AsyncSession, conversation_id: str) -> None:
    """Reap assistant-message rows that have been stuck in ``queued`` longer than
    :data:`STALE_QUEUED_RUN_AFTER` without anyone owning the asyncio task.
    """
    cutoff = _now() - STALE_QUEUED_RUN_AFTER
    stale_result = await db.execute(
        select(MessageTable).where(
            MessageTable.conversation_id == conversation_id,
            MessageTable.streaming_status == "queued",
            MessageTable.streaming_started_at < cutoff,
        )
    )
    stale_runs = stale_result.scalars().all()
    if not stale_runs:
        return

    now = _now()
    failed_run_ids: set[str] = set()
    for run in stale_runs:
        if inference_run_manager.has_live_task(run.id):
            continue
        failed_run_ids.add(run.id)
        run.streaming_status = "failed"
        run.streaming_completed_at = now
        run.is_error = True
        run.error_message = "Inference run was queued but never launched."
        run.updated_at = now
    if not failed_run_ids:
        return
    conversation = await db.get(ConversationTable, conversation_id)
    if conversation and conversation.active_assistant_message_id in failed_run_ids:
        conversation.active_assistant_message_id = None


async def create_inference_run_record(
    *,
    db: AsyncSession,
    user_id: str,
    conversation: ConversationTable,
    parent_message_id: str,
    message_path: list[str] | None,
    agent: AgentTable,
    mode: str,
    scheduled_task_id: str | None = None,
) -> MessageTable:
    """Create the AI placeholder message that represents the run.

    After the inference_runs-table collapse the run *is* the assistant message —
    the returned row carries both the streaming_* lifecycle columns and the
    final content/raw_events fields once the run terminates.

    ``mode`` drives durable-checkpointer branch allocation: ``send`` continues
    the leaf branch (inherit the nearest committed AI ancestor's
    ``checkpoint_thread_id``); every other mode (new/edit/retry/shared_continue)
    starts a fresh branch thread. The per-turn delta-vs-fork-vs-full decision is
    re-derived in ``_run`` from the message tree.
    """
    # Every run starts here, whatever the route, so this is where agent access is
    # enforced: a platform agent, or a custom agent the user owns. An agent id is
    # otherwise just a string the client sends (or a share snapshot carries).
    if agent.owner_user_id is not None and agent.owner_user_id != user_id:
        logger.warning("inference_agent_not_owned", "Refused a run on another user's private agent",
                       agent_id=agent.id, failure_reason="agent_not_owned")
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="This agent is private to its owner.")

    await _fail_stale_queued_runs_for_conversation(db, conversation.id)

    user_active_count = await db.scalar(
        select(func.count())
        .select_from(MessageTable)
        .join(ConversationTable, ConversationTable.id == MessageTable.conversation_id)
        .where(
            ConversationTable.user_id == user_id,
            MessageTable.streaming_status.in_(ACTIVE_RUN_STATUSES),
        )
    )
    if user_active_count >= MAX_ACTIVE_RUNS_PER_USER:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"You already have {MAX_ACTIVE_RUNS_PER_USER} active inference runs. Cancel one before starting a new one.",
        )

    existing = await db.execute(
        select(MessageTable).where(
            MessageTable.conversation_id == conversation.id,
            MessageTable.streaming_status.in_(ACTIVE_RUN_STATUSES),
        )
    )
    if existing.scalar_one_or_none() is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Conversation already has an active inference run.")
    # A manual compaction rewrites the branch's state; a run must not build on
    # the state it is about to replace (plan 34).
    if await compaction_locks.held(conversation.id):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This conversation is being compacted. Try again in a moment.",
        )

    parent = next((message for message in conversation.messages if message.id == parent_message_id), None)
    if not parent:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Parent message does not belong to this conversation.")

    parent_path = resolve_inference_message_path(conversation.messages, parent_message_id, message_path)

    # Branch-thread allocation. `send` continues the same linear branch, so it
    # resumes the nearest committed ancestor's thread; new/edit/retry/
    # shared_continue each start a fresh branch (a sibling row or a new
    # conversation) on its own thread, which `_run` seeds via copy-on-fork or a
    # full-history cold seed.
    if mode == "send":
        committed_ancestor = nearest_committed_ai(conversation.messages, parent_message_id)
        checkpoint_thread_id = (
            committed_ancestor.checkpoint_thread_id if committed_ancestor is not None else str(uuid4())
        )
    else:
        checkpoint_thread_id = str(uuid4())

    now = _now()
    assistant_message = MessageTable(
        conversation_id=conversation.id,
        parent_message_id=parent_message_id,
        sender="ai",
        content="",
        raw_events=[],
        agent_id=agent.id,
        agent_name=agent.name,
        streaming_status="queued",
        streaming_started_at=now,
        # After the user message it answers, never tied with it (see init_message).
        created_at=now,
        checkpoint_thread_id=checkpoint_thread_id,
        scheduled_task_id=scheduled_task_id,
    )
    db.add(assistant_message)
    try:
        await db.flush()
    except IntegrityError as exc:
        await db.rollback()
        if _is_active_run_integrity_conflict(exc):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Conversation already has an active inference run.") from exc
        raise

    # The streaming message path includes the new assistant message itself so the
    # detached task can hand it to the agent as the tail of the conversation
    # history. We have to set this after flush() so the id is available.
    assistant_message.streaming_message_path = [*parent_path, assistant_message.id]

    conversation.active_assistant_message_id = assistant_message.id
    conversation.last_message_at = now
    # The conversation's agent is a last-used pointer (per-message agent is on
    # the message rows), so reflect the agent that produced this run.
    conversation.agent_id = agent.id
    conversation.agent_name = agent.name
    return assistant_message


async def request_run_cancel(db: AsyncSession, run: MessageTable) -> MessageTable:
    if run.streaming_status not in ACTIVE_RUN_STATUSES:
        return run
    run.streaming_status = "cancelling"
    run.streaming_cancel_requested_at = _now()
    has_live_task = inference_run_manager.request_cancel(run.id)
    if not has_live_task:
        # No live task to interrupt — flip straight to cancelled without
        # touching content (we keep whatever the message already had).
        now = _now()
        run.streaming_status = "cancelled"
        run.streaming_completed_at = now
        run.updated_at = now
        conversation = await db.get(ConversationTable, run.conversation_id)
        if conversation and conversation.active_assistant_message_id == run.id:
            conversation.active_assistant_message_id = None
    await db.commit()
    await db.refresh(run)
    return run


async def request_run_resume(run: MessageTable, payload: dict[str, Any]) -> bool:
    """Hand a HITL resume decision to the live manager task.

    Returns True when a paused task accepted the resume signal; False when no
    live task is waiting on a HITL interrupt (e.g. the run already terminated,
    was cancelled, or the bridge process was restarted between interrupt and
    resume). Callers translate False into a 409 Conflict.
    """
    if run.streaming_status not in ACTIVE_RUN_STATUSES:
        return False
    return inference_run_manager.request_resume(run.id, payload)


async def cleanup_orphaned_inference_runs() -> None:
    """On service startup, flip every assistant-message that was mid-stream into
    ``failed`` so it doesn't appear active to hydrating clients indefinitely.
    """
    async with SessionLocal() as db:
        now = _now()
        await db.execute(
            update(MessageTable)
            .where(MessageTable.streaming_status.in_(ACTIVE_RUN_STATUSES))
            .values(
                streaming_status="failed",
                streaming_completed_at=now,
                is_error=True,
                error_message="Inference run was interrupted by service restart.",
                updated_at=now,
            )
        )
        await db.execute(
            update(ConversationTable)
            .where(ConversationTable.active_assistant_message_id.is_not(None))
            .values(active_assistant_message_id=None)
        )
        await db.commit()
