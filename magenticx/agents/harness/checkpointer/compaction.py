"""Compact a branch thread on request, and undo it (plan 34).

deepagents compacts on its own inside a model call when the context is nearly
full. A manual compaction does the same work between turns, on the saved
checkpoint: it reads the branch's head, summarizes everything but a small recent
tail with the agent's own summarizer, offloads the full history to
``/conversation_history/`` exactly as an automatic compaction does, and writes
the one private key deepagents keeps a compaction under. The next model call on
the thread then sees ``summary + recent messages``.

The state is always read through the graph (``aget_state``), never from the
raw checkpoint: deep agents keep ``messages`` in a delta channel, so a single
saved checkpoint holds only the latest changes and the full history exists
only once LangGraph replays them.

Two guards keep it from ever overwriting real work:

- the caller states the head it expects; a different head (a run committed on
  the branch, or it moved on) is a conflict, checked before summarizing AND
  again right before writing, since the summary takes seconds;
- undo only restores the state from before the compaction while the
  compaction is still the head.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any, Optional

from langchain_core.messages import AIMessage, AnyMessage
from langchain_core.runnables.config import var_child_runnable_config
from langgraph.errors import InvalidUpdateError

from core.logging import get_logger
from core.settings import settings
from harness.agui.usage_callback import UsageMetricsCallback
from harness.checkpointer.fork import STATE_WRITER_NODE
from harness.middlewares import (
    EVENT_KEY,
    ConfigurableSummarizationMiddleware,
    summary_cutoff,
    tokens_freed,
    visible_messages,
)
from harness.middlewares.usage_metrics import context_window, model_name

logger = get_logger(__name__)

# LangChain's summarizer answers some failures WITH a stand-in text instead of
# raising — a failed call, an empty input, or an input that trimmed down to
# nothing. Writing one of those would replace the history with that sentence.
_NOT_A_SUMMARY = (
    "Error generating summary",
    "Previous conversation was too long to summarize.",
    "No previous conversation history.",
)


class CompactionConflict(Exception):
    """The branch's head is not the one the caller compacted (or undoes) against."""


class CompactionFailed(Exception):
    """The summary could not be written; the thread is left untouched."""


@dataclass(frozen=True)
class CompactionResult:
    """What a manual compaction did. ``compacted`` is False when nothing was old
    enough to summarize (the whole conversation fits in the part that is kept)."""

    compacted: bool
    checkpoint_id: Optional[str] = None
    tokens_before: int = 0
    tokens_after: int = 0
    freed: int = 0
    window: Optional[int] = None
    summarized_messages: int = 0
    kept_messages: int = 0
    summary: str = ""
    model: Optional[str] = None
    usage: dict[str, int] = field(default_factory=dict)


def _head_id(checkpoint_tuple: Any) -> Optional[str]:
    if checkpoint_tuple is None:
        return None
    return (checkpoint_tuple.config.get("configurable") or {}).get("checkpoint_id")


async def read_state(graph: Any, cfg: dict[str, Any]) -> tuple[Optional[str], list[AnyMessage], Any]:
    """The checkpoint id, full message history and compaction at ``cfg``.

    Through ``aget_state``, which replays delta channels into the full history
    (a raw checkpoint of a deep agent carries only the latest message delta).
    The compaction is a plain channel; it is read from the raw checkpoint when
    the snapshot does not surface it.
    """
    snapshot = await graph.aget_state(cfg)
    if snapshot is None:
        return None, [], None
    values = snapshot.values or {}
    event = values.get(EVENT_KEY)
    if event is None:
        saved = await graph.checkpointer.aget_tuple(cfg)
        event = (saved.checkpoint.get("channel_values") or {}).get(EVENT_KEY) if saved is not None else None
    head = (snapshot.config.get("configurable") or {}).get("checkpoint_id") if snapshot.config else None
    return head, list(values.get("messages") or []), event


def _context_before(effective: list[AnyMessage], counter: Any) -> int:
    """The prompt the next call would carry before compacting.

    The last reply's provider-reported ``total_tokens`` (its prompt plus its
    own output, which the next call reads back) — the same reading deepagents
    triggers on. Falls back to the approximate counter when the reply carries
    no usage.
    """
    last_ai = next((m for m in reversed(effective) if isinstance(m, AIMessage)), None)
    total = (getattr(last_ai, "usage_metadata", None) or {}).get("total_tokens")
    if isinstance(total, int) and total > 0:
        return total
    try:
        return int(counter(effective))
    except (TypeError, ValueError):
        return 0


def _below_floor(effective: list[AnyMessage], window: Optional[int]) -> bool:
    """Whether the context is still under the manual-compaction floor (5%).

    Read as the composer's ring reads it: the last reply's provider-reported
    prompt over the model's window. Unknown window or usage → no floor.
    """
    floor = settings.summarization.manual_min_fraction
    last_ai = next((m for m in reversed(effective) if isinstance(m, AIMessage)), None)
    prompt = (getattr(last_ai, "usage_metadata", None) or {}).get("input_tokens")
    if not window or not isinstance(prompt, int) or floor <= 0:
        return False
    return prompt / window <= floor


def _sum_usage(calls: list[tuple[dict[str, Any], str, dict[str, Any]]]) -> tuple[dict[str, int], Optional[str]]:
    """Fold the summary call(s) the usage callback saw into one usage record."""
    usage = {"input_tokens": 0, "cached_input_tokens": 0, "output_tokens": 0, "reasoning_tokens": 0, "latency_ms": 0, "calls": 0}
    model: Optional[str] = None
    for call_usage, _call_id, metrics in calls:
        usage["calls"] += 1
        usage["input_tokens"] += int(call_usage.get("input_tokens") or 0)
        usage["output_tokens"] += int(call_usage.get("output_tokens") or 0)
        usage["cached_input_tokens"] += int((call_usage.get("input_token_details") or {}).get("cache_read") or 0)
        usage["reasoning_tokens"] += int((call_usage.get("output_token_details") or {}).get("reasoning") or 0)
        usage["latency_ms"] += int(metrics.get("latency_ms") or 0)
        model = metrics.get("model") or model
    return usage, model


async def _write_event(graph: Any, cfg: dict[str, Any], event: Any) -> str:
    """Write the compaction key as the next checkpoint; return its id.

    LangGraph attributes the write to the node that last wrote the thread, which
    leaves nothing pending after a finished turn. Should it ever be ambiguous,
    the model node — the one that writes the key in a real run — is used.
    """
    try:
        written = await graph.aupdate_state(cfg, {EVENT_KEY: event})
    except InvalidUpdateError:
        written = await graph.aupdate_state(cfg, {EVENT_KEY: event}, as_node=STATE_WRITER_NODE)
    return str(written["configurable"]["checkpoint_id"])


async def compact_thread(
    *,
    graph: Any,
    summarizer: ConfigurableSummarizationMiddleware,
    thread_id: str,
    expected_checkpoint_id: str,
) -> CompactionResult:
    """Summarize everything before the branch's latest exchange now, keeping that exchange whole.

    Raises :class:`CompactionConflict` when the head is not
    ``expected_checkpoint_id`` (before or after the summary is written) and
    :class:`CompactionFailed` when the summary call fails. Neither leaves a
    trace on the thread.
    """
    cfg: dict[str, Any] = {"configurable": {"thread_id": thread_id}}
    head, messages, previous = await read_state(graph, cfg)
    if head != expected_checkpoint_id:
        raise CompactionConflict()

    effective = summarizer._apply_event_to_messages(messages, previous)
    window = context_window(summarizer.model)
    if _below_floor(effective, window):
        return CompactionResult(compacted=False)
    # The same cut as an automatic compaction: everything before the latest
    # question (the previous summary included) folds into the new summary.
    cutoff = summary_cutoff(effective)
    if cutoff <= 0:
        return CompactionResult(compacted=False)
    to_summarize, _kept = summarizer._partition_messages(effective, cutoff)

    usage_callback = UsageMetricsCallback()
    # Outside a graph run there is no runnable config. deepagents names the
    # offloaded history file after the config's thread, and LangChain merges a
    # context-var config's callbacks into the summary call — that is how the
    # call's tokens are measured.
    token = var_child_runnable_config.set(
        {"configurable": {"thread_id": thread_id}, "callbacks": [usage_callback]}
    )
    try:
        # Our workspace factory takes no part of the runtime for the history
        # route (a plain directory), so no ToolRuntime is needed to resolve it.
        backend = summarizer._backend(None) if callable(summarizer._backend) else summarizer._backend
        # The same two steps deepagents' own summarizer runs (pinned 0.6.10):
        # offload the full history and write the summary, concurrently.
        file_path, summary = await asyncio.gather(
            summarizer._aoffload_to_backend(backend, to_summarize),
            summarizer._acreate_summary(to_summarize),
        )
    finally:
        var_child_runnable_config.reset(token)
    if not summary or summary.strip().startswith(_NOT_A_SUMMARY):
        logger.warning("manual_compaction_summary_failed", "The compaction summary call failed", thread_id=thread_id)
        raise CompactionFailed()

    summary_message = summarizer._build_new_messages_with_path(summary, file_path)[0]
    event = {
        "cutoff_index": summarizer._compute_state_cutoff(previous, cutoff),
        "summary_message": summary_message,
        "file_path": file_path,
    }
    if _head_id(await graph.checkpointer.aget_tuple(cfg)) != expected_checkpoint_id:
        raise CompactionConflict()
    checkpoint_id = await _write_event(graph, cfg, event)

    before = _context_before(effective, summarizer.token_counter)
    freed = min(tokens_freed(summarizer.token_counter, to_summarize, summary_message), before)
    usage, used_model = _sum_usage(usage_callback.drain())
    return CompactionResult(
        compacted=True,
        checkpoint_id=checkpoint_id,
        tokens_before=before,
        tokens_after=before - freed,
        freed=freed,
        window=window,
        summarized_messages=visible_messages(effective, 0, cutoff),
        kept_messages=visible_messages(effective, cutoff, len(effective)),
        summary=summary,
        model=used_model or model_name(summarizer.model),
        usage=usage,
    )


async def undo_compaction(*, graph: Any, thread_id: str, expected_checkpoint_id: str) -> str:
    """Restore the compaction state from before ``expected_checkpoint_id``.

    Writes the parent checkpoint's compaction (``None`` when there was none) as
    a new head and returns its id. Raises :class:`CompactionConflict` unless the
    compaction is still the branch's head — once a turn ran on top of it, the
    summary is part of what the agent answered from and cannot be taken back.
    """
    cfg: dict[str, Any] = {"configurable": {"thread_id": thread_id}}
    head = await graph.checkpointer.aget_tuple(cfg)
    if _head_id(head) != expected_checkpoint_id or head.parent_config is None:
        raise CompactionConflict()
    _parent_id, _messages, previous = await read_state(graph, head.parent_config)
    return await _write_event(graph, cfg, previous)
