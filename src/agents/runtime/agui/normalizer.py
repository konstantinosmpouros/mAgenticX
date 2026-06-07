import json
from typing import Any, List, Optional, Tuple, Dict
from runtime.protocols.agui.emitter import AGUIEmitter


_ALLOWED_MODES = {"messages", "updates"}

class AGUIStreamNormalizer:
    """
    Combined streaming normalizer for LangGraph:
        - stream_mode MUST be ["messages", "updates"] on the agent.
        - "messages" => ONLY assistant text content (chunks)
        - "updates"  => tools/subagents/plan/interrupt (NO content)

    Policies:
        - __interrupt__ => only HITL event (priority)
        - write_todos   => only plan_snapshot (dedupe)
        - task tool     => only subagent event (dedupe)
        - other tools   => full lifecycle start/args/result/end
    """

    def __init__(self, thread_id: str) -> None:
        self.emitter = AGUIEmitter()
        self.thread_id = thread_id  # message_id == thread_id (your requirement)

        # --- streaming state (per actor: orchestrator/sub-agent) ---
        self._stream_state: Dict[str, Dict[str, bool]] = {}

        # --- tool correlation ---
        self._pending_tool_call_ids: set[str] = set()     # start/args emitted; waiting ToolMessage result
        self._started_tool_call_ids: set[str] = set()     # to dedupe start/args
        self._finished_tool_call_ids: set[str] = set()    # to dedupe result/end
        self._ignored_tool_call_ids: set[str] = set()     # write_todos + task: ignore ToolMessage

        # --- custom event dedupe ---
        self._emitted_subagent_task_ids: set[str] = set()
        self._last_plan_fingerprint: Optional[str] = None

        # --- sub-agent namespace mapping ---
        self._pending_tasks: Dict[str, Dict[str, str]] = {}
        self._namespace_task_labels: Dict[tuple, str] = {}




    # --------------------------- public API ---------------------------
    def handle_chunk(self, chunk: Any) -> List[bytes]:
        """Convert a raw chunk to 0..N AG-UI SSE events (bytes)."""
        namespace, mode, payload, metadata = self._unwrap_envelope(chunk)

        # Handle payload based on mode
        if mode == "messages":
            events = self._handle_messages_payload(payload, metadata, namespace)
            return self._wrap_subagent_events_if_needed(events, namespace)
        elif mode == "updates":
            events = self._handle_updates_payload(payload, metadata, namespace)
            return self._wrap_subagent_events_if_needed(events, namespace)
        else:
            return []



    # ------------------------ envelope unwrapping ------------------------
    def _unwrap_envelope(
        self, chunk: Any
    ) -> Tuple[Optional[tuple], Optional[str], Any, Optional[Dict[str, Any]]]:
        """
        For stream_mode=["messages","updates"] with subgraphs=True possible.

        General rule:
        - Find the first string in the chunk that matches an allowed mode.
        - The item just before it (if any) is namespace.
        - The item just after it is payload.
        - The next item (if any) is metadata.
        Legacy: if messages payload is a 2-tuple (msg, meta) and meta is a dict,
        treat meta as metadata when none was provided.
        Fallback: dict chunks => updates; everything else => unknown.
        """
        namespace: Optional[tuple] = None
        mode: Optional[str] = None
        payload: Any = chunk
        metadata: Optional[Dict[str, Any]] = None

        # --- Sequence parsing: scan for mode string and derive neighbors ---
        if isinstance(chunk, (tuple, list)):
            seq = list(chunk)
            for idx, item in enumerate(seq):
                if isinstance(item, str) and item in _ALLOWED_MODES:
                    mode = item

                    # Namespace: immediately before the mode (if present)
                    if idx - 1 >= 0:
                        ns_candidate = seq[idx - 1]
                        if isinstance(ns_candidate, tuple) and len(ns_candidate) > 0:
                            namespace = ns_candidate
                        elif isinstance(ns_candidate, list) and len(ns_candidate) > 0:
                            namespace = tuple(ns_candidate)

                    # Payload: immediately after the mode (if present)
                    if idx + 1 < len(seq):
                        payload = seq[idx + 1]

                    # Metadata: the element after payload (if present)
                    if idx + 2 < len(seq):
                        meta_candidate = seq[idx + 2]
                        if isinstance(meta_candidate, dict):
                            metadata = meta_candidate

                    # Legacy: messages payload can be (msg, meta)
                    if (
                        mode == "messages"
                        and isinstance(payload, tuple)
                        and len(payload) == 2
                        and metadata is None
                    ):
                        msg, meta = payload
                        payload = msg
                        metadata = meta if isinstance(meta, dict) else None

                    return namespace, mode, payload, metadata

        # --- Fallbacks ---
        if isinstance(chunk, dict):
            return None, "updates", chunk, None

        return None, None, chunk, None



    # --------------------------- messages mode ---------------------------
    def _handle_messages_payload(
        self,
        payload: Any,
        metadata: Optional[Dict[str, Any]] = None,
        namespace: Optional[tuple] = None,
    ) -> List[bytes]:
        """
        messages:
            - AI message => assistant text stream (start/chunk)
            - ToolMessage => tool results (result/end) ONLY if tool_call_id is pending and not ignored
        """
        out: List[bytes] = []
        ns_label = self._resolve_namespace_label(namespace)

        kind = self._msg_kind(payload)

        # 1) ToolMessage in messages => treat as result/end (but gate via ignored/pending)
        if kind == "tool":
            self._emit_tool_message_result(out, payload, ns_label)
            return out

        # 2) AI message => assistant text chunks only
        if kind == "ai":
            delta = self._extract_text_delta(payload)
            if not delta:
                return out

            # First content => thinking_end + response_start + first chunk
            self._end_thinking_if_needed(out, ns_label)
            state = self._get_state(ns_label)

            if not state["response_started"]:
                self._push(out, self.emitter.response_start(message_id=self.thread_id, namespace=ns_label))
                state["response_started"] = True
                state["response_ended"] = False

            self._push(out, self.emitter.response_chunk(message_id=self.thread_id, delta=delta, namespace=ns_label))
            state["saw_messages_chunk"] = True
            return out

        # 3) Other message kinds ignored
        return out



    # --------------------------- updates mode ----------------------------
    def _handle_updates_payload(
        self,
        payload: Any,
        metadata: Optional[Dict[str, Any]] = None,
        namespace: Optional[tuple] = None,
    ) -> List[bytes]:
        """
        updates:
            - __interrupt__ => HITL event only (and return)
            - write_todos => plan_snapshot only (and mark tool_call_id ignored)
            - task => subagent event only (and mark tool_call_id ignored)
            - other tools => tool_start + tool_args (and mark tool_call_id pending)
            - If AI message contains content => DO NOT emit content; emit TEXT_MESSAGE_END (once)
        """
        out: List[bytes] = []
        if not isinstance(payload, dict):
            return out

        ns_label = self._resolve_namespace_label(namespace, payload)

        # HITL priority: HITL only contract
        if "__interrupt__" in payload:
            raw = payload.get("__interrupt__")
            interrupt_obj = raw[0] if isinstance(raw, (tuple, list)) and raw else raw

            interrupt_payload: Any = interrupt_obj
            if interrupt_obj is not None:
                interrupt_payload = {
                    "id": getattr(interrupt_obj, "id", None),
                    "value": getattr(interrupt_obj, "value", interrupt_obj),
                }

            hitl_meta: Dict[str, Any] = {}
            if isinstance(metadata, dict):
                hitl_meta.update(metadata)
            hitl_meta["namespace"] = ns_label

            self._push(
                out,
                self.emitter.hitl_interrupt(
                    thread_id=self.thread_id,
                    interrupt=interrupt_payload,
                    metadata=hitl_meta,
                    namespace=ns_label,
                ),
            )
            return out

        # Optional metadata forwarding (future-proof)
        meta: Dict[str, Any] = {}
        if isinstance(metadata, dict):
            meta.update(metadata)
        meta["namespace"] = ns_label

        # Walk node updates
        for node_name, node_update in payload.items():
            if node_update is None or not isinstance(node_update, dict):
                continue

            # Emit a dedicated marker for sub-agent before_agent instructions.
            if node_name == "PatchToolCallsMiddleware.before_agent":
                if namespace is not None:
                    for msg in self._unwrap_messages_list(node_update.get("messages")):
                        delegated_message = getattr(msg, "content", None)
                        if isinstance(delegated_message, str) and delegated_message:
                            self._push(
                                out,
                                self.emitter.before_agent_event(
                                    message=delegated_message,
                                    metadata=meta,
                                    namespace=ns_label,
                                ),
                            )
                            break
                continue

            # Authoritative todos snapshot may be present as node_update["todos"]
            if "todos" in node_update and isinstance(node_update.get("todos"), list):
                fp = self._fingerprint(node_update["todos"])
                if fp != self._last_plan_fingerprint:
                    self._end_thinking_if_needed(out, ns_label)
                    self._push(out, self.emitter.plan_snapshot(node_update["todos"], metadata=meta, namespace=ns_label))
                    self._last_plan_fingerprint = fp

            # Process messages inside this update
            for msg in self._unwrap_messages_list(node_update.get("messages")):
                msg_kind = self._msg_kind(msg)

                # ToolMessage results may also arrive through updates-only streams.
                if msg_kind == "tool":
                    self._emit_tool_message_result(out, msg, ns_label)
                    continue

                if msg_kind != "ai":
                    continue

                # If updates stream contains final AI content:
                # - With messages-mode chunks already seen: only close response.
                # - With updates-only mode: synthesize start/content/end once.
                ai_content = self._extract_text_delta(msg)
                if ai_content:
                    self._end_thinking_if_needed(out, ns_label)
                    state = self._get_state(ns_label)

                    if not state["response_started"]:
                        self._push(out, self.emitter.response_start(message_id=self.thread_id, namespace=ns_label))
                        state["response_started"] = True
                        state["response_ended"] = False

                    if not state["saw_messages_chunk"]:
                        self._push(out, self.emitter.response_content(message_id=self.thread_id, delta=ai_content, namespace=ns_label))

                    if not state["response_ended"]:
                        self._push(out, self.emitter.response_end(message_id=self.thread_id, namespace=ns_label))
                        state["response_ended"] = True

                # Tool intents: emit start/args OR plan/subagent events
                for tc in self._iter_tool_calls(msg):
                    tc_id = tc["id"]
                    tc_name = tc["name"]
                    tc_args = tc.get("args")

                    if tc_name == "write_todos":
                        # plan snapshot only
                        todos = tc_args.get("todos") if isinstance(tc_args, dict) else None
                        if isinstance(todos, list):
                            fp = self._fingerprint(todos)
                            if fp != self._last_plan_fingerprint:
                                self._end_thinking_if_needed(out, ns_label)
                                self._push(out, self.emitter.plan_snapshot(todos, metadata=meta, namespace=ns_label))
                                self._last_plan_fingerprint = fp
                        self._ignored_tool_call_ids.add(tc_id)  # ignore ToolMessage if it appears later
                        continue

                    if tc_name == "task":
                        # subagent event only
                        if tc_id not in self._emitted_subagent_task_ids and isinstance(tc_args, dict):
                            subagent_type = str(tc_args.get("subagent_type", ""))
                            description = str(tc_args.get("description", ""))
                            self._end_thinking_if_needed(out, ns_label)
                            self._push(
                                out,
                                self.emitter.task_subagent(
                                    task_id=tc_id,
                                    subagent_type=subagent_type,
                                    description=description,
                                    namespace=ns_label,
                                ),
                            )
                            self._emitted_subagent_task_ids.add(tc_id)
                            self._pending_tasks[tc_id] = {
                                "description": description,
                                "subagent_type": subagent_type,
                            }
                        self._ignored_tool_call_ids.add(tc_id)  # ignore ToolMessage if it appears later
                        continue

                    # Normal tool => start + args, and wait for ToolMessage on messages stream
                    if tc_id in self._started_tool_call_ids:
                        continue

                    self._end_thinking_if_needed(out, ns_label)
                    self._push(out, self.emitter.tool_call_start(tool_call_id=tc_id, name=tc_name, namespace=ns_label))
                    self._push(out, self.emitter.tool_call_args(tool_call_id=tc_id, name=tc_name, args=tc_args, namespace=ns_label))

                    self._started_tool_call_ids.add(tc_id)
                    self._pending_tool_call_ids.add(tc_id)

        return out


    def _emit_tool_message_result(self, out: List[bytes], msg: Any, ns_label: Optional[str]) -> None:
        """Emit tool result/end for tool messages we previously opened."""
        tool_call_id = getattr(msg, "tool_call_id", None)
        tool_output = getattr(msg, "content", "")

        if not tool_call_id:
            return

        # Ignore results for write_todos/task tool calls (because we never emitted start/args)
        if tool_call_id in self._ignored_tool_call_ids:
            self._ignored_tool_call_ids.discard(tool_call_id)
            return

        # Only close tools we actually started from updates
        if tool_call_id in self._pending_tool_call_ids and tool_call_id not in self._finished_tool_call_ids:
            self._end_thinking_if_needed(out, ns_label)
            self._push(
                out,
                self.emitter.tool_call_result(
                    tool_call_id=tool_call_id,
                    thread_id=self.thread_id,
                    output=tool_output,
                    namespace=ns_label,
                ),
            )
            self._push(
                out,
                self.emitter.tool_call_end(tool_call_id=tool_call_id, namespace=ns_label),
            )

            self._pending_tool_call_ids.discard(tool_call_id)
            self._finished_tool_call_ids.add(tool_call_id)



    # ------------------------- utilities & helpers -------------------------
    def _push(self, events: List[bytes], maybe_event: Optional[bytes]) -> None:
        # Emitter methods return Optional[bytes]
        if maybe_event is not None:
            events.append(maybe_event)


    def _extract_text_delta(self, msg: Any) -> str:
        """
        Extract assistant text delta from a LangChain message chunk.
        Handles common shapes:
            - msg.content: str
            - msg.content: list[dict] with 'text' fields (e.g., rich content parts)
        """
        content = getattr(msg, "content", "")
        if isinstance(content, str):
            return content

        # Sometimes content can be a list of parts; we only keep textual pieces
        if isinstance(content, list):
            parts: List[str] = []
            for p in content:
                if isinstance(p, dict):
                    # common keys: {"type":"text","text":"..."} or {"text":"..."}
                    text = p.get("text")
                    if isinstance(text, str) and text:
                        parts.append(text)
            return "".join(parts)

        return ""


    def _end_thinking_if_needed(self, out: List[bytes], namespace: Optional[str]) -> None:
        # We do NOT call this for HITL (because you want HITL only).
        state = self._get_state(namespace)
        if state["thinking_started"]:
            self._push(out, self.emitter.thinking_end(namespace=namespace))
            state["thinking_started"] = False


    def _actor_key(self, namespace: Optional[str]) -> str:
        """Build a stable stream-state key per orchestrator/sub-agent."""
        return namespace if isinstance(namespace, str) and namespace else "__orchestrator__"


    def _get_state(self, namespace: Optional[str]) -> Dict[str, bool]:
        """Return mutable stream state for the given actor key."""
        key = self._actor_key(namespace)
        if key not in self._stream_state:
            self._stream_state[key] = {
                "response_started": False,
                "response_ended": False,
                "thinking_started": False,
                "saw_messages_chunk": False,
            }
        return self._stream_state[key]


    def _unwrap_messages_list(self, messages_obj: Any) -> List[Any]:
        """
        updates often store messages as:
            - list[Message]
            - Overwrite(value=[Message, ...])
            - single Message
        """
        if messages_obj is None:
            return []

        # Overwrite(value=[...]) case
        value = getattr(messages_obj, "value", None)
        if isinstance(value, list):
            return value

        if isinstance(messages_obj, list):
            return messages_obj

        # Single message object fallback
        return [messages_obj]


    def _iter_tool_calls(self, ai_msg: Any) -> List[Dict[str, Any]]:
        """
        Returns tool_calls as a list of dicts: {id,name,args}
        """
        tool_calls = getattr(ai_msg, "tool_calls", None)

        # Some wrappers put tool calls in additional_kwargs
        if not tool_calls:
            ak = getattr(ai_msg, "additional_kwargs", None)
            if isinstance(ak, dict):
                tool_calls = ak.get("tool_calls")

        if not tool_calls:
            return []

        normalized: List[Dict[str, Any]] = []
        for tc in tool_calls:
            if isinstance(tc, dict):
                normalized.append(
                    {"id": tc.get("id"), "name": tc.get("name"), "args": tc.get("args")}
                )
            else:
                normalized.append(
                    {
                        "id": getattr(tc, "id", None),
                        "name": getattr(tc, "name", None),
                        "args": getattr(tc, "args", None),
                    }
                )
        return [t for t in normalized if t.get("id") and t.get("name")]


    def _maybe_bind_namespace(self, namespace: Optional[tuple], payload: Any) -> Optional[str]:
        """
        Map a LangGraph subgraph namespace (tuple) to a task_id by matching the
        first HumanMessage content of PatchToolCallsMiddleware.before_agent to a
        pending task description.
        """
        if namespace is None or not isinstance(payload, dict):
            return None

        if namespace in self._namespace_task_labels:
            return self._namespace_task_labels[namespace]

        node = payload.get("PatchToolCallsMiddleware.before_agent")
        if not isinstance(node, dict):
            return None

        for msg in self._unwrap_messages_list(node.get("messages")):
            content = getattr(msg, "content", None)
            if not isinstance(content, str) or not content:
                continue

            for task_id, info in list(self._pending_tasks.items()):
                if content == info.get("description"):
                    task_str = str(task_id)
                    self._namespace_task_labels[namespace] = task_str
                    self._pending_tasks.pop(task_id, None)
                    return task_str

        return None


    def _resolve_namespace_label(self, namespace: Optional[tuple], payload: Any = None) -> Optional[str]:
        """
        Return the mapped task_id for a namespace (if any). When payload is provided,
        attempt to bind first (for sub-agent startup chunks).
        """
        if namespace is None:
            return None

        if payload is not None:
            self._maybe_bind_namespace(namespace, payload)

        # Prefer explicit mapping (task tool-call id), then deterministic namespace-derived id.
        return self._namespace_task_labels.get(namespace) or self._namespace_task_id(namespace)


    def _wrap_subagent_events_if_needed(self, events: List[bytes], namespace: Optional[tuple]) -> List[bytes]:
        """
        For sub-agent namespaces, wrap every normalized AG-UI event inside SUBAGENT_EVENT.
        Orchestrator events (namespace None/empty) pass through unchanged.
        """
        task_id = self._namespace_task_id(namespace)
        if task_id is None:
            return events

        namespace_path = self._namespace_path(namespace)
        namespace_token = self._namespace_token(namespace)
        wrapped: List[bytes] = []

        for event_bytes in events:
            inner_event = self._sse_to_payload(event_bytes)
            if inner_event is None:
                inner_event = self._raw_event_payload(event_bytes)

            wrapped_event = self.emitter.subagent_event(
                task_id=task_id,
                subagent_namespace=namespace_path or [task_id],
                event=inner_event,
                namespace=namespace_token,
            )
            if wrapped_event is not None:
                wrapped.append(wrapped_event)

        return wrapped


    def _namespace_task_id(self, namespace: Optional[tuple]) -> Optional[str]:
        """
        Deterministically derive task_id from namespace.
        Example: ('tools:abc-123',) -> 'abc-123'
        """
        if namespace is None:
            return None

        if isinstance(namespace, (list, tuple)) and len(namespace) == 0:
            return None

        parts = namespace if isinstance(namespace, (list, tuple)) else [namespace]
        for part in parts:
            if not isinstance(part, str) or not part:
                continue
            if ":" in part:
                _, _, tail = part.partition(":")
                return tail or part
            return part
        return None


    def _namespace_path(self, namespace: Optional[tuple]) -> Optional[List[str]]:
        """Return a serialized namespace path for diagnostics/UI correlation."""
        if namespace is None:
            return None

        if isinstance(namespace, (list, tuple)):
            path = [str(item) for item in namespace if str(item)]
            return path or None

        text = str(namespace)
        return [text] if text else None


    def _namespace_token(self, namespace: Optional[tuple]) -> Optional[str]:
        """
        Return the first namespace token for transport-level namespace field.
        Example: ('tools:abc', 'model:def') -> 'tools:abc'
        """
        path = self._namespace_path(namespace)
        if not path:
            return None
        return path[0]


    def _sse_to_payload(self, sse_event: Any) -> Optional[Dict[str, Any]]:
        """Decode the JSON payload from an SSE frame.

        Accepts both bytes (legacy ag_ui) and str (newer ag_ui) so we stay
        robust to library version drift.
        """
        try:
            if isinstance(sse_event, (bytes, bytearray)):
                text = sse_event.decode("utf-8")
            elif isinstance(sse_event, str):
                text = sse_event
            else:
                return None
        except UnicodeDecodeError:
            return None

        for line in text.splitlines():
            if line.startswith("data:"):
                raw = line[len("data:"):].lstrip()
                try:
                    payload = json.loads(raw)
                except json.JSONDecodeError:
                    return None
                if isinstance(payload, dict):
                    return payload
                return None

        return None


    def _raw_event_payload(self, sse_event: Any) -> Dict[str, Any]:
        """
        Fallback payload when an SSE frame cannot be decoded into JSON.
        Ensures sub-agent events are still wrapped deterministically.
        """
        try:
            if isinstance(sse_event, (bytes, bytearray)):
                text = sse_event.decode("utf-8")
            elif isinstance(sse_event, str):
                text = sse_event
            else:
                text = repr(sse_event)
        except UnicodeDecodeError:
            text = repr(sse_event)

        return {
            "type": "RAW_SSE_EVENT",
            "raw_sse": text,
        }


    def _fingerprint(self, obj: Any) -> str:
        # Stable JSON fingerprint for dedupe (todos lists, etc.)
        return json.dumps(obj, ensure_ascii=False, sort_keys=True)


    def _msg_kind(self, msg: Any) -> str:
        """
        Duck-typing classifier for LangChain messages/chunks.
        """
        cls = msg.__class__.__name__
        role = getattr(msg, "role", None)
        mtype = getattr(msg, "type", None)

        # ToolMessage is reliably detectable via tool_call_id
        if getattr(msg, "tool_call_id", None) is not None or role == "tool" or mtype == "tool" or cls == "ToolMessage":
            return "tool"

        if role == "assistant" or mtype in ("ai", "assistant") or "AIMessage" in cls:
            return "ai"

        return "other"
