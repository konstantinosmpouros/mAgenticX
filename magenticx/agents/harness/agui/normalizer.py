"""LangGraph stream chunks -> AG-UI events.

A deep agent streams ``["messages", "updates", "tasks"]`` with ``subgraphs=True``:

* ``messages`` - token chunks: the reply text and the reasoning summary.
* ``updates``  - settled node outputs: tool calls and results, the plan,
  interrupts, token usage, sub-agent start markers.
* ``tasks``    - which `task` call each sub-agent namespace runs (no events of
  its own beyond the sub-agent's start marker).

A sub-agent's events are wrapped in a ``SUBAGENT_EVENT`` envelope keyed by the
`task` call that started it, so the UI folds them into that sub-agent's card.
"""

import json
import mimetypes
import re
import time
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from pydantic import ValidationError

from core.logging import get_logger
from harness.agui.emitter import AGUIEmitter, Event, encode
from harness.middlewares.sources import SOURCES_KEY
from harness.middlewares.summarization import COMPACTION_KEY
from harness.middlewares.tool_metrics import TOOL_METRICS_KEY
from harness.middlewares.usage_metrics import METRICS_KEY as USAGE_METRICS_KEY
from harness.tools.charts import normalize_chart_payload

logger = get_logger(__name__)

_MODES = {"messages", "updates", "tasks"}

TASK_TOOL_NAME = "task"
START_ASYNC_TASK_TOOL_NAME = "start_async_task"
UPDATE_ASYNC_TASK_TOOL_NAME = "update_async_task"
_SUBAGENT_START_NODE = "PatchToolCallsMiddleware.before_agent"

# ``Launched async subagent. task_id: <id>`` (deepagents 0.7.34); an update to
# a waiting task ends its sentence right after the id.
_LAUNCHED_TASK_ID_RE = re.compile(r"task_id:\s*([A-Za-z0-9_-]+)")

# A task notification deepagents pulls into a running agent's state
# (``add_notification_metadata``): ``lc_source`` + ``lc_data``, or the
# deprecated ``deepagents_notification`` key.
_NOTIFICATION_SOURCE = "async_subagent"
_NOTIFICATION_DATA_KEY = "lc_data"
_NOTIFICATION_LEGACY_KEY = "deepagents_notification"
# Notification status -> settled status the UI shows (``waiting`` is not settled).
_SETTLED_INLINE_STATUS = {"success": "success", "error": "error", "timeout": "error", "cancelled": "cancelled"}


# --------------------------------------------------------------------------
# What one run remembers across its streams
# --------------------------------------------------------------------------
@dataclass
class _RunMemory:
    """Kept per run id across its streams (a /resume builds a fresh normalizer).

    Single worker, same lifecycle as the checkpointer cache.
    """

    bindings: dict[tuple, str] = field(default_factory=dict)  # sub-agent namespace -> `task` call id
    started_at: dict[str, int] = field(default_factory=dict)  # `task` call id -> epoch ms
    completed: set[str] = field(default_factory=set)  # SUBAGENT_COMPLETED sent (a resume replays results)
    launched: set[str] = field(default_factory=set)  # TASK_LAUNCHED sent (same reason)


_RUNS: dict[str, _RunMemory] = {}


def release_namespace_bindings(thread_id: str) -> None:
    """Forget a finished (or fresh) run."""
    _RUNS.pop(thread_id, None)


# --------------------------------------------------------------------------
# Reading LangChain messages
# --------------------------------------------------------------------------
def message_kind(msg: Any) -> str:
    """``tool``, ``ai`` or ``other``, by duck typing (chunks and dicts too)."""
    mtype = getattr(msg, "type", None)
    role = getattr(msg, "role", None)
    cls = type(msg).__name__
    if getattr(msg, "tool_call_id", None) is not None or "tool" in (role, mtype) or cls == "ToolMessage":
        return "tool"
    if role == "assistant" or mtype in ("ai", "assistant") or "AIMessage" in cls:
        return "ai"
    return "other"


def _blocks(msg: Any) -> list[dict[str, Any]]:
    """The message's content as LangChain standard blocks (any provider), else its raw list.

    ``content_blocks`` translates by ``response_metadata["model_provider"]``,
    which every integration sets; a provider's translator can raise on a
    malformed block.
    """
    try:
        blocks = msg.content_blocks
    except Exception:
        blocks = getattr(msg, "content", None)
    return [b for b in blocks if isinstance(b, dict)] if isinstance(blocks, list) else []


def message_text(msg: Any) -> str:
    """The reply text of a message (never its reasoning or tool input)."""
    content = getattr(msg, "content", "")
    if isinstance(content, str):
        return content
    return "".join(
        b["text"] for b in _blocks(msg) if b.get("type") == "text" and isinstance(b.get("text"), str)
    )


def tool_calls(msg: Any) -> list[dict[str, Any]]:
    """The message's tool calls as ``{id, name, args}`` (every integration fills ``tool_calls``)."""
    return [
        {"id": tc.get("id"), "name": tc.get("name"), "args": tc.get("args")}
        for tc in getattr(msg, "tool_calls", None) or []
        if isinstance(tc, dict) and tc.get("id") and tc.get("name")
    ]


def reasoning_parts(msg: Any) -> list[tuple[str, str]]:
    """The reasoning text of an AI message (chunk), as ``(part key, text)`` in order.

    Standard ``reasoning`` blocks (OpenAI summaries, Anthropic and Bedrock
    thinking, Gemini thoughts, DeepSeek/xAI/Groq ``reasoning_content``), and
    the raw shapes when the message names no provider. The key tells one part
    from the next: the block's index, else its position.
    """
    parts: list[tuple[str, str]] = []
    for pos, block in enumerate(_blocks(msg)):
        if block.get("type") == "non_standard" and isinstance(block.get("value"), dict):
            block = block["value"]
        index = block.get("index")
        key = str(index) if index is not None else f"#{pos}"
        kind = block.get("type")
        if kind == "reasoning" and isinstance(block.get("summary"), list):  # raw OpenAI Responses
            for part in block["summary"]:
                if isinstance(part, dict) and isinstance(part.get("text"), str) and part["text"]:
                    parts.append((f"{key}:{part.get('index', '')}", part["text"]))
        elif kind == "reasoning" and isinstance(block.get("reasoning"), str) and block["reasoning"]:
            parts.append((key, block["reasoning"]))
        elif kind == "thinking" and isinstance(block.get("thinking"), str) and block["thinking"]:
            parts.append((key, block["thinking"]))
    if not parts:  # the openai translator skips this OpenAI-compatible field
        extra = getattr(msg, "additional_kwargs", None) or {}
        if isinstance(extra.get("reasoning_content"), str) and extra["reasoning_content"]:
            parts.append(("#rc", extra["reasoning_content"]))
    return parts


def _merge_parts(parts: list[tuple[str, str]]) -> list[tuple[str, str]]:
    """Join consecutive pieces of the same part."""
    merged: list[tuple[str, str]] = []
    for key, text in parts:
        if merged and merged[-1][0] == key:
            merged[-1] = (key, merged[-1][1] + text)
        else:
            merged.append((key, text))
    return merged


def _messages_of(value: Any) -> list[Any]:
    """A node update's ``messages``: a list, an ``Overwrite(value=[...])`` or one message."""
    if value is None:
        return []
    inner = getattr(value, "value", None)
    if isinstance(inner, list):
        return inner
    return value if isinstance(value, list) else [value]


def _namespace_id(namespace: tuple | None) -> str | None:
    """``("tools:abc", ...)`` -> ``"abc"``: the id LangGraph gave a sub-agent's first segment."""
    for part in namespace or ():
        if isinstance(part, str) and part:
            return part.partition(":")[2] or part
    return None


def _namespace_path(namespace: tuple | None) -> list[str] | None:
    path = [str(part) for part in namespace or () if str(part)]
    return path or None


def _now_ms() -> int:
    return int(time.time() * 1000)


@dataclass
class _Reply:
    """One actor's reply text in the current model call."""

    started: bool = False  # TEXT_MESSAGE_START sent
    streamed: bool = False  # chunks came over "messages": the final message must not repeat them


@dataclass
class _Call:
    """A tool call with where it came from."""

    id: str
    name: str
    args: dict[str, Any] | None
    namespace: tuple | None
    label: str | None
    meta: dict[str, Any]


@dataclass
class _Thought:
    """One actor's reasoning-summary part, held until it is complete."""

    part: str | None = None
    text: str = ""
    streamed: bool = False  # this model call's parts came over "messages"
    open: bool = False  # THINKING_START sent, THINKING_END not yet


class AGUIStreamNormalizer:
    """Turns one stream of a deep agent run into AG-UI SSE frames.

    Every tool call gets the full start/args/result/end lifecycle except:

    ====================  ===================================================
    ``write_todos``       PLAN_SNAPSHOT (deduplicated)
    ``present_artifact``  PRESENT_ARTIFACT card (orchestrator only)
    ``render_chart``      RENDER_CHART inline chart (orchestrator only)
    ``ask_user``          nothing: its interrupt is the HITL event
    ``task``              TASK_SUBAGENT, then SUBAGENT_COMPLETED on its result
    ``start_async_task``  TASK_LAUNCHED on its result (a failed launch: an
    ``update_async_task`` errored tool card)
    ====================  ===================================================

    An interrupt is sent as HITL_INTERRUPT alone. A task notification pulled
    into the run becomes TASK_SETTLED_INLINE, never user text.
    """

    def __init__(self, thread_id: str) -> None:
        self.emitter = AGUIEmitter()
        self.thread_id = thread_id  # the run id: every AG-UI message_id
        self._run = _RUNS.setdefault(thread_id, _RunMemory()) if thread_id else _RunMemory()

        self._replies: dict[str | None, _Reply] = {}  # per actor label (None: orchestrator)
        self._thoughts: dict[tuple, _Thought] = {}  # per raw namespace (() : orchestrator)
        self._last_plan: str | None = None

        # Tool calls.
        self._open_tools: set[str] = set()  # start/args sent, result awaited
        self._started_tools: set[str] = set()
        self._finished_tools: set[str] = set()
        self._silent_tools: set[str] = set()  # their ToolMessage is never a tool card

        # Sub-agents (`task`).
        self._announced_tasks: set[str] = set()  # TASK_SUBAGENT sent
        self._pending_tasks: dict[str, tuple | None] = {}  # unbound `task` call -> caller namespace (None: orchestrator)
        self._task_namespaces: dict[tuple, str] = {}  # from the "tasks" stream: exact namespace -> call
        self._known_tasks: set[str] = set()  # `task` calls seen on the "tasks" stream
        self._started_namespaces: set[tuple] = set()  # BEFORE_AGENT sent

        # Tools with an event of their own instead of a tool card.
        self._special_tools = {
            "write_todos": self._plan_call,
            "present_artifact": self._present_artifact_call,
            "ask_user": self._ask_user_call,
            "render_chart": self._render_chart_call,
            TASK_TOOL_NAME: self._task_call,
            START_ASYNC_TASK_TOOL_NAME: self._async_task_call,
            UPDATE_ASYNC_TASK_TOOL_NAME: self._async_task_call,
        }

        # Background tasks.
        self._async_calls: dict[str, dict[str, Any]] = {}  # start/update call -> what its result needs
        self._settled_inline: set[tuple[str, str, str]] = set()  # (task, run, status) sent

        # Automatic compaction: open from the summary call to the reply after it.
        self._compaction_open = False
        self._compactions = 0
        self._compaction_usage_ids: set[str] = set()

    # ------------------------------------------------------------------ API
    def handle_chunk(self, chunk: Any) -> list[bytes]:
        """One raw stream chunk -> 0..N AG-UI SSE frames."""
        namespace, mode, payload, metadata = self._unwrap(chunk)
        if mode == "tasks":
            events = self._on_tasks(payload, namespace)
        elif mode == "messages":
            events = self._wrap(self._on_message(payload, metadata, namespace), namespace)
        elif mode == "updates":
            events = self._wrap(self._on_updates(payload, metadata, namespace), namespace)
        else:
            events = []
        return [encode(event) for event in events]

    def seed_pending_tasks(self, messages: Any) -> None:
        """Before a /resume stream: re-learn the calls still awaiting a result.

        The calls were announced on the previous stream, so a sub-agent started
        by an approved `task` would find nothing to bind to, and a background
        task's launch would lose what it asked for.
        """
        answered = {
            str(msg.tool_call_id) for msg in _messages_of(messages)
            if message_kind(msg) == "tool" and getattr(msg, "tool_call_id", None)
        }
        bound = set(self._run.bindings.values())
        for msg in _messages_of(messages):
            if message_kind(msg) != "ai":
                continue
            for tc in tool_calls(msg):
                call_id, name = str(tc["id"]), tc["name"]
                args = tc["args"] if isinstance(tc["args"], dict) else {}
                if call_id in answered:
                    continue
                if name in (START_ASYNC_TASK_TOOL_NAME, UPDATE_ASYNC_TASK_TOOL_NAME):
                    self._async_calls.setdefault(call_id, self._async_call(name, args))
                    self._silent_tools.add(call_id)
                elif name == TASK_TOOL_NAME:
                    self._announced_tasks.add(call_id)
                    self._silent_tools.add(call_id)
                    if call_id not in bound:
                        self._pending_tasks.setdefault(call_id, None)

    # ------------------------------------------------------------- envelope
    @staticmethod
    def _unwrap(chunk: Any) -> tuple[tuple | None, str | None, Any, dict[str, Any] | None]:
        """``(namespace?, mode, payload[, metadata])``; a "messages" payload is ``(msg, metadata)``."""
        if isinstance(chunk, dict):
            return None, "updates", chunk, None
        if not isinstance(chunk, (tuple, list)):
            return None, None, chunk, None
        for idx, item in enumerate(chunk):
            if isinstance(item, str) and item in _MODES:
                before = chunk[idx - 1] if idx else None
                namespace = tuple(before) if isinstance(before, (tuple, list)) and before else None
                payload = chunk[idx + 1] if idx + 1 < len(chunk) else chunk
                after = chunk[idx + 2] if idx + 2 < len(chunk) else None
                metadata = after if isinstance(after, dict) else None
                if item == "messages" and isinstance(payload, tuple) and len(payload) == 2 and metadata is None:
                    payload, meta = payload
                    metadata = meta if isinstance(meta, dict) else None
                return namespace, item, payload, metadata
        return None, None, chunk, None

    # ----------------------------------------------------------- tasks mode
    def _on_tasks(self, payload: Any, namespace: tuple | None) -> list[Event]:
        """A ``tools`` node task starting a `task` call: bind its sub-agent's namespace.

        The sub-agent streams under ``namespace + ("tools:<node task id>",)``, so
        this is the one exact link from a call to its sub-agent, at any depth.
        Its BEFORE_AGENT marker (with the task it was given) goes out now.
        """
        if not isinstance(payload, dict) or payload.get("name") != "tools" or "input" not in payload:
            return []
        node_task_id = payload.get("id")
        if not node_task_id:
            return []
        out: list[Event] = []
        inputs = payload["input"] if isinstance(payload["input"], list) else [payload["input"]]
        for item in inputs:
            wrapped = item.get("tool_call") if isinstance(item, dict) else getattr(item, "tool_call", None)
            call = wrapped if isinstance(wrapped, dict) else item
            if not isinstance(call, dict) or call.get("name") != TASK_TOOL_NAME or not call.get("id"):
                continue
            child = (*(namespace or ()), f"tools:{node_task_id}")
            self._task_namespaces[child] = str(call["id"])
            self._known_tasks.add(str(call["id"]))
            bound = self._bind(child)
            if bound is None or child in self._started_namespaces:
                continue
            self._started_namespaces.add(child)
            args = call.get("args") if isinstance(call.get("args"), dict) else {}
            marker = self.emitter.before_agent_event(
                message=str(args.get("description") or ""), metadata={"namespace": bound}, namespace=bound,
            )
            out.extend(self._wrap([marker], child))
        return out

    # -------------------------------------------------------- messages mode
    def _on_message(self, msg: Any, metadata: dict[str, Any] | None, namespace: tuple | None) -> list[Event]:
        """A token chunk: reasoning (held per part) and reply text; or a tool result."""
        if isinstance(metadata, dict) and metadata.get("lc_source") == "summarization":
            # A compaction's internal summary call: never the reply.
            return self._on_summary_call(msg, namespace)
        out: list[Event] = []
        label = self._label(namespace)
        kind = message_kind(msg)
        if kind == "tool":
            self._on_tool_result(out, msg, label)
        elif kind == "ai":
            for part_key, text in reasoning_parts(msg):
                self._buffer_thought(out, namespace, label, part_key, text)
            delta = message_text(msg)
            if delta:
                self._flush_thought(out, namespace, label)  # the reply starts: the reasoning is complete
                reply = self._open_reply(out, namespace, label)
                self._add(out, self.emitter.response_chunk(message_id=self.thread_id, delta=delta, namespace=label))
                reply.streamed = True
        return out

    # --------------------------------------------------------- updates mode
    def _on_updates(self, payload: Any, metadata: dict[str, Any] | None, namespace: tuple | None) -> list[Event]:
        out: list[Event] = []
        if not isinstance(payload, dict):
            return out
        label = self._label(namespace)
        meta = {**(metadata or {}), "namespace": label}

        if "__interrupt__" in payload:  # the interrupt alone
            raw = payload["__interrupt__"]
            interrupt = raw[0] if isinstance(raw, (tuple, list)) and raw else raw
            value = None if interrupt is None else {
                "id": getattr(interrupt, "id", None), "value": getattr(interrupt, "value", interrupt),
            }
            self._add(out, self.emitter.hitl_interrupt(
                thread_id=self.thread_id, interrupt=value, metadata=meta, namespace=label,
            ))
            return out

        for node, update in payload.items():
            if node == _SUBAGENT_START_NODE:
                self._on_subagent_start(out, namespace, meta)
                continue
            if not isinstance(update, dict):
                continue
            if isinstance(update.get("todos"), list):
                self._plan(out, update["todos"], meta, label)
            for msg in _messages_of(update.get("messages")):
                kind = message_kind(msg)
                if kind == "tool":
                    self._on_tool_result(out, msg, label)
                elif kind == "ai":
                    self._on_model_reply(out, msg, node, namespace, label, meta)
                else:
                    self._on_task_notification(out, msg, node, update, label)
        return out

    def _on_subagent_start(self, out: list[Event], namespace: tuple | None, meta: dict[str, Any]) -> None:
        """deepagents' start marker of a sub-agent (null body): bind it to the next pending `task`."""
        if namespace is None or namespace in self._started_namespaces:
            return  # orchestrator, or announced from the "tasks" stream
        bound = self._bind(namespace)
        if bound is not None:
            self._started_namespaces.add(namespace)
            self._add(out, self.emitter.before_agent_event(
                message="", metadata={**meta, "namespace": bound}, namespace=bound,
            ))

    def _on_model_reply(
        self, out: list[Event], msg: Any, node: Any, namespace: tuple | None, label: str | None, meta: dict[str, Any],
    ) -> None:
        """A settled model call: reasoning, then text, usage and tool calls.

        A middleware node (``Name.hook``) re-emits a message the model node
        already sent (HITL after_model on a resume, compaction): only its tool
        calls can be new.
        """
        reemitted = isinstance(node, str) and "." in node
        if not reemitted:
            self._settle_thoughts(out, msg, namespace, label)
            text = message_text(msg)
            if text:
                reply = self._open_reply(out, namespace, label)
                if not reply.streamed:  # updates-only stream: the text comes from here
                    self._add(out, self.emitter.response_content(
                        message_id=self.thread_id, delta=text, namespace=label,
                    ))
                self._add(out, self.emitter.response_end(message_id=self.thread_id, namespace=label))
            self._replies.pop(label, None)  # the model call is over: its text message too
            self._usage(out, msg, namespace, label)
        for tc in tool_calls(msg):
            self._on_tool_call(out, tc, namespace, label, meta)

    # ----------------------------------------------------------- reply text
    def _open_reply(self, out: list[Event], namespace: tuple | None, label: str | None) -> _Reply:
        """TEXT_MESSAGE_START once per model call (ending the thinking before it)."""
        reply = self._replies.setdefault(label, _Reply())
        if not reply.started:
            self._close_thinking(out, namespace, label)
            self._add(out, self.emitter.response_start(message_id=self.thread_id, namespace=label))
            reply.started = True
        return reply

    # -------------------------------------------------------------- thoughts
    def _thought(self, namespace: tuple | None) -> _Thought:
        return self._thoughts.setdefault(tuple(namespace or ()), _Thought())

    def _buffer_thought(self, out: list[Event], namespace: tuple | None, label: str | None, key: str, text: str) -> None:
        """A streamed piece of a summary part; a new part sends the one before."""
        thought = self._thought(namespace)
        if thought.part is not None and thought.part != key:
            self._flush_thought(out, namespace, label)
        thought.part, thought.streamed = key, True
        thought.text += text

    def _flush_thought(self, out: list[Event], namespace: tuple | None, label: str | None) -> None:
        """Send the part held so far as one thought (the UI shows each thought as a step)."""
        thought = self._thought(namespace)
        text, thought.part, thought.text = thought.text.strip(), None, ""
        if text:
            self._send_thought(out, namespace, label, text)

    def _send_thought(self, out: list[Event], namespace: tuple | None, label: str | None, text: str) -> None:
        """One thought: THINKING_START once per thinking phase, then the thought as a
        start/content/end text message (the UI shows each as a step)."""
        thought = self._thought(namespace)
        if not thought.open:
            thought.open = True
            self._add(out, self.emitter.thinking_start(namespace=label))
        out.extend(self.emitter.thought(text, namespace=label))

    def _close_thinking(self, out: list[Event], namespace: tuple | None, label: str | None) -> None:
        """The reply starts: the thinking phase before it ends."""
        thought = self._thought(namespace)
        if thought.open:
            thought.open = False
            self._add(out, self.emitter.thinking_end(namespace=label))

    def _settle_thoughts(self, out: list[Event], msg: Any, namespace: tuple | None, label: str | None) -> None:
        """The model call settled: the part still held, or (updates-only) every part of it."""
        thought = self._thought(namespace)
        if thought.streamed:
            self._flush_thought(out, namespace, label)
        else:
            for _key, text in _merge_parts(reasoning_parts(msg)):
                if text.strip():
                    self._send_thought(out, namespace, label, text.strip())
        thought.streamed = False

    # ------------------------------------------------------------ tool calls
    def _on_tool_call(
        self, out: list[Event], tc: dict[str, Any], namespace: tuple | None, label: str | None, meta: dict[str, Any],
    ) -> None:
        """A tool call: a tool card, or the special tool's own event (its result is then no card)."""
        call = _Call(tc["id"], tc["name"], tc["args"] if isinstance(tc["args"], dict) else None, namespace, label, meta)
        special = self._special_tools.get(call.name)
        if special is not None:
            special(out, call)
            self._silent_tools.add(call.id)
        elif call.id not in self._started_tools:
            self._tool_card_open(out, call.id, call.name, tc["args"], label)
            self._open_tools.add(call.id)

    def _plan_call(self, out: list[Event], call: _Call) -> None:
        if call.args is not None and isinstance(call.args.get("todos"), list):
            self._plan(out, call.args["todos"], call.meta, call.label)

    def _present_artifact_call(self, out: list[Event], call: _Call) -> None:
        """A file handed to the user (orchestrator only: a sub-agent's file is scratch)."""
        if call.namespace is not None or call.args is None:
            return
        path, title = str(call.args.get("path", "")).strip(), str(call.args.get("title", "")).strip()
        if not (path and title):
            return
        filename = path.rstrip("/").rsplit("/", 1)[-1]
        self._add(out, self.emitter.present_artifact(
            artifact_id=call.id, path=path, filename=filename, title=title,
            summary=str(call.args.get("summary") or "").strip() or None,
            mime=mimetypes.guess_type(filename)[0], namespace=call.label,
        ))

    def _ask_user_call(self, out: list[Event], call: _Call) -> None:
        """Nothing: its interrupt (the questions) is the event, its result comes on /resume."""

    def _render_chart_call(self, out: list[Event], call: _Call) -> None:
        """A chart the orchestrator drew (a sub-agent's chart is scratch), normalized
        here (bounded, coerced, only the plotted fields): a renderable chart or nothing."""
        if call.namespace is not None or call.args is None:
            return
        payload = normalize_chart_payload(call.args)
        if payload is not None:
            self._add(out, self.emitter.render_chart(chart_id=call.id, namespace=call.label, **payload))

    def _task_call(self, out: list[Event], call: _Call) -> None:
        """TASK_SUBAGENT, and the call waits for the sub-agent namespace it starts."""
        if call.id in self._announced_tasks or call.args is None:
            return
        self._announced_tasks.add(call.id)
        self._pending_tasks[call.id] = call.namespace or None
        self._add(out, self.emitter.task_subagent(
            task_id=call.id, subagent_type=str(call.args.get("subagent_type", "")),
            description=str(call.args.get("description", "")), namespace=call.label,
        ))

    def _async_task_call(self, out: list[Event], call: _Call) -> None:
        """A background task start/update: its result becomes the event."""
        self._async_calls.setdefault(call.id, self._async_call(call.name, call.args or {}))

    def _tool_card_open(self, out: list[Event], call_id: str, name: str, args: Any, label: str | None) -> None:
        self._add(out, self.emitter.tool_call_start(tool_call_id=call_id, name=name, namespace=label))
        self._add(out, self.emitter.tool_call_args(tool_call_id=call_id, name=name, args=args, namespace=label))
        self._started_tools.add(call_id)

    def _tool_card_close(self, out: list[Event], call_id: str, msg: Any, label: str | None, *, error: bool) -> None:
        """The result and end of a tool card, then its TOOL_USAGE and SOURCES.

        A result that carries valid sources (plan 42) is not sent as text: the
        card shows its pages from the SOURCES event, and the page contents — the
        model's reading, not the user's — never leave the agents service. A
        malformed stamp sends the result as before, so the card is never empty.
        """
        sources = None if error else self._sources_event(msg, call_id, label)
        self._add(out, self.emitter.tool_call_result(
            tool_call_id=call_id, thread_id=self.thread_id,
            output="" if sources is not None else getattr(msg, "content", ""),
            namespace=label, error=error,
        ))
        self._add(out, self.emitter.tool_call_end(tool_call_id=call_id, namespace=label))
        self._tool_usage(out, msg, call_id, label)
        if sources is not None:
            self._add(out, sources)
        self._open_tools.discard(call_id)
        self._finished_tools.add(call_id)

    def _tool_usage(self, out: list[Event], msg: Any, call_id: str, label: str | None) -> None:
        """TOOL_USAGE from the stamp ``ToolMetricsMiddleware`` put on the result, when
        there is one. Telemetry never breaks the stream: a malformed stamp is logged and dropped."""
        stamp = (getattr(msg, "response_metadata", None) or {}).get(TOOL_METRICS_KEY)
        if not isinstance(stamp, dict):
            return
        try:
            self._add(out, self.emitter.tool_usage(
                tool_call_id=call_id, tool_name=stamp.get("tool_name") or getattr(msg, "name", None) or "tool",
                duration_ms=stamp.get("duration_ms"), status=stamp.get("status"),
                output_chars=stamp.get("output_chars"), namespace=label,
            ))
        except ValidationError:
            logger.warning("tool_usage_skipped", "Malformed tool metrics on a tool result", tool_call_id=call_id)

    def _sources_event(self, msg: Any, call_id: str, label: str | None) -> Event | None:
        """The SOURCES event for the stamp ``SourcesMiddleware`` put on the result,
        or None. Citations never break the stream: a malformed stamp is logged
        (counts only, never a URL) and dropped."""
        stamp = (getattr(msg, "response_metadata", None) or {}).get(SOURCES_KEY)
        if not stamp:
            return None
        if not isinstance(stamp, list):
            logger.warning("sources_event_skipped", "Malformed sources stamp on a tool result", tool_call_id=call_id)
            return None
        try:
            return self.emitter.sources(tool_call_id=call_id, sources=stamp, namespace=label)
        except ValidationError:
            logger.warning("sources_event_skipped", "Malformed sources stamp on a tool result",
                           tool_call_id=call_id, sources=len(stamp))
            return None

    def _on_tool_result(self, out: list[Event], msg: Any, label: str | None) -> None:
        call_id = getattr(msg, "tool_call_id", None)
        if not call_id:
            return
        error = getattr(msg, "status", None) == "error"
        name = getattr(msg, "name", None)
        if self._is_task_result(call_id, name, label):
            self._on_subagent_returned(out, str(call_id), error, label)
        elif call_id in self._async_calls or name in (START_ASYNC_TASK_TOOL_NAME, UPDATE_ASYNC_TASK_TOOL_NAME):
            self._on_async_task_result(out, msg, str(call_id), name, label)
        elif call_id in self._silent_tools:
            self._silent_tools.discard(call_id)
        elif call_id in self._open_tools and call_id not in self._finished_tools:
            self._tool_card_close(out, call_id, msg, label, error=error)

    # -------------------------------------------------------------- sub-agents
    def _is_task_result(self, call_id: str, name: str | None, label: str | None) -> bool:
        """By id when this stream or the "tasks" stream saw the call; by name for the
        orchestrator's own `task` otherwise (a /resume normalizer never saw it)."""
        if call_id in self._announced_tasks or call_id in self._known_tasks:
            return True
        return (
            name == TASK_TOOL_NAME and label is None
            and call_id not in self._silent_tools and call_id not in self._open_tools
        )

    def _on_subagent_returned(self, out: list[Event], call_id: str, error: bool, label: str | None) -> None:
        """SUBAGENT_COMPLETED, once per run, with the sub-agent's namespace when bound."""
        self._silent_tools.discard(call_id)
        self._pending_tasks.pop(call_id, None)  # rejected: never binds
        if call_id in self._run.completed:
            return
        self._run.completed.add(call_id)
        bound = next((ns for ns, task in self._run.bindings.items() if task == call_id), None)
        self._add(out, self.emitter.subagent_completed(
            task_id=call_id, status="error" if error else "completed",
            subagent_namespace=_namespace_path(bound), started_at=self._run.started_at.get(call_id),
            ended_at=_now_ms(), namespace=label,
        ))

    def _bind(self, namespace: tuple | None) -> str | None:
        """The `task` call a sub-agent namespace runs, bound once per run.

        Exact from the "tasks" stream; otherwise the oldest unbound call made
        one level above (a nested sub-agent never takes a sibling's call),
        else the oldest unbound call. Only the "tasks" stream tells parallel
        siblings apart.
        """
        if namespace is None:
            return None
        if namespace in self._run.bindings:
            return self._run.bindings[namespace]
        call_id = self._task_namespaces.get(namespace)
        if call_id is None:
            reserved = set(self._task_namespaces.values())
            pending = [c for c in self._pending_tasks if c not in reserved]
            caller = tuple(namespace[:-1]) or None
            call_id = next((c for c in pending if self._pending_tasks[c] == caller), None) or next(iter(pending), None)
            if call_id is None:
                return None
        self._run.bindings[namespace] = call_id
        self._pending_tasks.pop(call_id, None)
        self._run.started_at.setdefault(call_id, _now_ms())
        return call_id

    def _label(self, namespace: tuple | None) -> str | None:
        """The actor an event belongs to: None (orchestrator), else its `task` call id
        (or the namespace's own id when no call bound)."""
        if namespace is None:
            return None
        return self._bind(namespace) or _namespace_id(namespace)

    def _wrap(self, events: list[Event], namespace: tuple | None) -> list[Event]:
        """A sub-agent's events, each inside a SUBAGENT_EVENT envelope keyed by its `task` call."""
        task_id = self._run.bindings.get(namespace) if namespace else None
        task_id = task_id or _namespace_id(namespace)
        if task_id is None:
            return events
        path = _namespace_path(namespace)
        return [
            self.emitter.subagent_event(
                task_id=task_id, subagent_namespace=path or [task_id], event=event, namespace=path[0] if path else None,
            )
            for event in events
        ]

    # --------------------------------------------------------- background tasks
    @staticmethod
    def _async_call(name: str, args: Mapping[str, Any]) -> dict[str, Any]:
        """What a start/update call's result event needs from its arguments."""
        if name == UPDATE_ASYNC_TASK_TOOL_NAME:
            return {"name": "", "description": str(args.get("message") or ""), "args": dict(args), "action": "update"}
        return {
            "name": str(args.get("subagent_type") or ""), "description": str(args.get("description") or ""),
            "args": dict(args), "action": "start",
        }

    def _on_async_task_result(self, out: list[Event], msg: Any, call_id: str, name: str | None, label: str | None) -> None:
        """TASK_LAUNCHED once per run; a launch without a task id is an errored tool card."""
        action = "update" if name == UPDATE_ASYNC_TASK_TOOL_NAME else "start"
        call = self._async_calls.pop(call_id, None)
        action = call["action"] if call else action
        call = call or self._async_call(START_ASYNC_TASK_TOOL_NAME, {})
        self._silent_tools.discard(call_id)
        if call_id in self._run.launched:
            return
        self._run.launched.add(call_id)
        error = getattr(msg, "status", None) == "error"
        match = None if error else _LAUNCHED_TASK_ID_RE.search(message_text(msg))
        if match:
            self._add(out, self.emitter.task_launched(
                task_id=match.group(1), name=call["name"], description=call["description"],
                action=action, namespace=label,
            ))
            return
        tool = UPDATE_ASYNC_TASK_TOOL_NAME if action == "update" else START_ASYNC_TASK_TOOL_NAME
        self._tool_card_open(out, call_id, tool, call["args"], label)
        self._tool_card_close(out, call_id, msg, label, error=True)

    def _on_task_notification(self, out: list[Event], msg: Any, node: Any, update: Mapping[str, Any], label: str | None) -> None:
        """TASK_SETTLED_INLINE for a settled task's outcome pulled into the run.

        ``before_agent`` also re-labels the run's own input (a superseded
        wake-up): only an outcome the same update records at the event's run counts.
        """
        kwargs = msg.get("additional_kwargs") if isinstance(msg, Mapping) else getattr(msg, "additional_kwargs", None)
        if not isinstance(kwargs, Mapping):
            return
        event = kwargs.get(_NOTIFICATION_DATA_KEY) if kwargs.get("lc_source") == _NOTIFICATION_SOURCE else None
        if not isinstance(event, Mapping):
            event = kwargs.get(_NOTIFICATION_LEGACY_KEY)
        if not isinstance(event, Mapping):
            return
        status = _SETTLED_INLINE_STATUS.get(str(event.get("status") or ""))
        task_id, run_id = str(event.get("task_id") or ""), str(event.get("run_id") or "")
        if status is None or not task_id:
            return
        if isinstance(node, str) and node.endswith(".before_agent"):
            records = update.get("async_tasks")
            record = records.get(task_id) if isinstance(records, Mapping) else None
            if not isinstance(record, Mapping) or str(record.get("run_id") or "") != run_id:
                return
        if (task_id, run_id, status) in self._settled_inline:
            return
        self._settled_inline.add((task_id, run_id, status))
        self._add(out, self.emitter.task_settled_inline(
            task_id=task_id, name=str(event.get("agent_name") or ""), status=status, namespace=label,
        ))

    # ------------------------------------------------- plan, usage, compaction
    def _plan(self, out: list[Event], todos: list[Any], meta: dict[str, Any], label: str | None) -> None:
        fingerprint = json.dumps(todos, ensure_ascii=False, sort_keys=True)
        if fingerprint != self._last_plan:
            self._last_plan = fingerprint
            self._add(out, self.emitter.plan_snapshot(todos, metadata=meta, namespace=label))

    def _usage(self, out: list[Event], msg: Any, namespace: tuple | None, label: str | None) -> None:
        """TOKEN_USAGE per settled model call, with the metrics stamped on it; and a
        compaction's result, from the reply that followed it."""
        usage = getattr(msg, "usage_metadata", None)
        response_metadata = getattr(msg, "response_metadata", None) or {}
        compaction = response_metadata.get(COMPACTION_KEY)
        if isinstance(compaction, dict) and namespace is None:
            self._add(out, self._compaction_done(compaction, usage, response_metadata))
        if not (isinstance(usage, dict) and usage):
            return
        # Stamped on the reply by UsageMetricsMiddleware (a deep agent's custom
        # channel is not streamed, so the metrics ride the message).
        metrics = response_metadata.get(USAGE_METRICS_KEY)
        self._add(out, self.emitter.token_usage(
            usage, message_id=getattr(msg, "id", None), metrics=metrics if isinstance(metrics, dict) else None,
            namespace=label,
        ))

    def _on_summary_call(self, msg: Any, namespace: tuple | None) -> list[Event]:
        """A compaction's summary call: that it started (orchestrator only) and its cost (once)."""
        out: list[Event] = []
        if namespace is None and not self._compaction_open:
            self._compaction_open = True
            self._compactions += 1
            self._add(out, self.emitter.context_compaction("started"))
        usage = getattr(msg, "usage_metadata", None)
        if isinstance(usage, dict) and usage:
            call_id = getattr(msg, "id", None) or f"compaction-{self.thread_id}-{self._compactions}"
            if call_id not in self._compaction_usage_ids:
                self._compaction_usage_ids.add(call_id)
                self._add(out, self.emitter.token_usage(
                    usage, message_id=call_id, purpose="compaction", namespace=self._label(namespace),
                ))
        return out

    def _compaction_done(self, stamp: dict[str, Any], usage: Any, response_metadata: dict[str, Any]) -> Event:
        """The reply's prompt is the context after; the summarizer's estimate of what it freed gives before."""
        self._compaction_open = False
        after = usage.get("input_tokens") if isinstance(usage, dict) else None
        after = after if isinstance(after, int) else None
        freed = stamp.get("freed") if isinstance(stamp.get("freed"), int) else None
        metrics = response_metadata.get(USAGE_METRICS_KEY)
        window = metrics.get("context_window") if isinstance(metrics, dict) else None
        return self.emitter.context_compaction("done", details={
            "tokens_after": after,
            "freed": freed,
            "tokens_before": after + freed if after is not None and freed is not None else None,
            "window": window if isinstance(window, int) else None,
            "summarized_messages": stamp.get("summarized_messages"),
            "kept_messages": stamp.get("kept_messages"),
        })

    @staticmethod
    def _add(out: list[Event], event: Event) -> None:
        out.append(event)

