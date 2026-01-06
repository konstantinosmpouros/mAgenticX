# agui_stream_normalizer.py
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Tuple, Union
from uuid import uuid4


@dataclass
class _ToolCallState:
    name: str = ""
    args_buffer: str = ""
    started: bool = False
    ended: bool = False


class AGUIStreamNormalizer:
    """
    Normalizes LangGraph agent streamed chunks (ONLY stream_mode: "messages" or "updates")
    into AG-UI SSE bytes using the provided AGUIEmitter.

    - "custom" is assumed handled upstream (already SSE bytes/str).
    - HITL interrupt is assumed handled upstream.
    """

    def __init__(self, *, emitter: Any, stream_mode: str) -> None:
        if stream_mode not in ("messages", "updates"):
            raise ValueError(f"AGUIStreamNormalizer supports only 'messages' or 'updates' (got: {stream_mode})")

        self.emitter = emitter
        self.stream_mode = stream_mode

        # One assistant message per run (good enough for agent runs with tools + final answer).
        self.parent_message_id: str = str(uuid4())
        self._response_started: bool = False
        self._response_ended: bool = False

        # tool_call_id -> state
        self._tool_calls: Dict[str, _ToolCallState] = {}

    # --------------------------- public API ---------------------------

    def handle_chunk(self, chunk: Any) -> List[bytes]:
        """
        Convert a raw chunk to 0..N AG-UI SSE events (bytes).
        """
        out: List[bytes] = []

        # Defensive: sometimes you may see wrappers even in single-mode (e.g., subgraphs=True)
        ns, mode, payload = self._unwrap_envelope(chunk)
        active_mode = mode or self.stream_mode

        if active_mode == "messages":
            out.extend(self._handle_messages_payload(payload))
        elif active_mode == "updates":
            out.extend(self._handle_updates_payload(payload))
        else:
            # Should not happen given constructor + upstream constraints; keep safe fallback.
            out.extend(self._emit_custom_raw({"unhandled_mode": active_mode, "payload": self._safe_json(payload)}))

        return out

    def finalize(self) -> List[bytes]:
        """
        Close any open tool calls and assistant message at end-of-stream.
        Call once after the async-for finishes normally.
        """
        out: List[bytes] = []

        # Close any tool calls that never got an explicit "end" (best-effort)
        for tool_call_id, st in list(self._tool_calls.items()):
            if st.started and not st.ended:
                out.append(self.emitter.tool_call_end(tool_call_id))

        if self._response_started and not self._response_ended:
            out.append(self.emitter.response_end(self.parent_message_id))
            self._response_ended = True

        return out

    # ------------------------ envelope unwrapping ------------------------

    def _unwrap_envelope(self, chunk: Any) -> Tuple[Optional[tuple], Optional[str], Any]:
        """
        Supports two wrappers:
          - (namespace_tuple, data) for subgraphs=True
          - (mode_str, data) for multi-mode streaming
        Returns: (namespace, mode, payload)
        """
        namespace: Optional[tuple] = None
        mode: Optional[str] = None
        payload: Any = chunk

        # subgraphs wrapper: (namespace, data)
        if isinstance(payload, tuple) and len(payload) == 2 and isinstance(payload[0], tuple):
            namespace, payload = payload

        # multi-mode wrapper: (mode, data)
        if isinstance(payload, tuple) and len(payload) == 2 and isinstance(payload[0], str):
            if payload[0] in ("messages", "updates", "custom", "values", "debug"):
                mode, payload = payload

        return namespace, mode, payload

    # --------------------------- messages mode ---------------------------

    def _handle_messages_payload(self, payload: Any) -> List[bytes]:
        """
        LangGraph "messages" mode yields: (message_chunk, metadata)
        Docs: (message_chunk, metadata) 2-tuple. We treat metadata as optional.
        """
        out: List[bytes] = []

        msg_obj = payload
        metadata: Dict[str, Any] = {}

        # payload is typically (message_chunk, metadata)
        if isinstance(payload, tuple) and len(payload) == 2 and isinstance(payload[1], dict):
            msg_obj, metadata = payload[0], payload[1]

        # 1) Tool call deltas / tool calls in the message chunk
        tool_calls = self._extract_tool_calls(msg_obj)
        if tool_calls:
            self._ensure_response_started(out)
            out.extend(self._emit_tool_calls_from_ai(tool_calls))

        # 2) Text delta (token streaming)
        delta = self._extract_text_delta(msg_obj)
        if delta:
            self._ensure_response_started(out)
            out.append(self.emitter.response_chunk(self.parent_message_id, delta))

        # 3) Tool results may also appear as tool messages in messages-mode streams (best-effort)
        if self._infer_role(msg_obj) == "tool":
            self._ensure_response_started(out)
            out.extend(self._emit_tool_result_from_tool_message(msg_obj))

        return out

    # --------------------------- updates mode ----------------------------

    def _handle_updates_payload(self, payload: Any) -> List[bytes]:
        """
        LangGraph "updates" mode yields: dict mapping node -> update.
        Each update commonly contains "messages": [AIMessage/ToolMessage/...]
        """
        out: List[bytes] = []
        if not isinstance(payload, dict):
            # Unexpected; fall back to raw custom event
            return self._emit_custom_raw({"unexpected_updates_payload": self._safe_json(payload)})

        for _node, update in payload.items():
            # Most common: update is dict that may include "messages"
            if isinstance(update, dict) and "messages" in update:
                msgs = update.get("messages") or []
                if isinstance(msgs, list):
                    for m in msgs:
                        out.extend(self._handle_update_message_obj(m))
                else:
                    # Sometimes a single message-like object
                    out.extend(self._handle_update_message_obj(msgs))
            else:
                # Some graphs put message-like objects directly in update
                # Try to parse as message/tool; otherwise ignore or emit custom (your choice).
                if self._looks_message_like(update):
                    out.extend(self._handle_update_message_obj(update))
                # else: ignore (keeps UI clean). If you want observability, emit custom:
                # else:
                #     out.extend(self._emit_custom_raw({"update": self._safe_json(update)}))

        return out

    def _handle_update_message_obj(self, msg_obj: Any) -> List[bytes]:
        out: List[bytes] = []
        role = self._infer_role(msg_obj)

        # AI message: may contain tool_calls and/or final content
        if role == "ai":
            tool_calls = self._extract_tool_calls(msg_obj)
            if tool_calls:
                self._ensure_response_started(out)
                out.extend(self._emit_tool_calls_from_ai(tool_calls))

            text = self._extract_full_text(msg_obj)
            if text:
                self._ensure_response_started(out)
                # updates mode is not token streaming; send as content delta(s)
                out.append(self.emitter.response_content(self.parent_message_id, text))

        # Tool message: result for a tool_call_id
        elif role == "tool":
            self._ensure_response_started(out)
            out.extend(self._emit_tool_result_from_tool_message(msg_obj))

        # Other roles (human/system) are usually not streamed back to UI
        return out

    # -------------------------- tool emissions ---------------------------

    def _emit_tool_calls_from_ai(self, tool_calls: List[Dict[str, Any]]) -> List[bytes]:
        out: List[bytes] = []
        for idx, tc in enumerate(tool_calls):
            tc_id = (tc.get("id") or tc.get("tool_call_id") or f"toolcall_{idx}")
            name = tc.get("name") or tc.get("tool") or tc.get("tool_call_name") or ""
            args = tc.get("args")
            # OpenAI-style: {"function": {"name": ..., "arguments": ...}}
            if not name and isinstance(tc.get("function"), dict):
                name = tc["function"].get("name", "") or name
                args = tc["function"].get("arguments", args)

            st = self._tool_calls.setdefault(tc_id, _ToolCallState())
            if name:
                st.name = name

            if not st.started:
                out.append(self.emitter.tool_call_start(tc_id, self.parent_message_id, st.name or name or "tool"))
                st.started = True

            if args is not None:
                emitted_args: Union[dict, str]
                if isinstance(args, dict):
                    emitted_args = args
                    st.args_buffer = json.dumps(args, ensure_ascii=False)
                elif isinstance(args, str):
                    # streamed fragments (messages mode) or full json string
                    st.args_buffer += args
                    emitted_args = st.args_buffer
                else:
                    emitted_args = self._safe_json(args)

                out.append(self.emitter.tool_call_args(tc_id, st.name or name or "tool", emitted_args))

        return out

    def _emit_tool_result_from_tool_message(self, msg_obj: Any) -> List[bytes]:
        out: List[bytes] = []
        tool_call_id = self._extract_tool_call_id(msg_obj)
        if not tool_call_id:
            # best-effort fallback: if exactly one open tool call exists, attach to it
            open_ids = [k for k, v in self._tool_calls.items() if v.started and not v.ended]
            tool_call_id = open_ids[-1] if open_ids else "toolcall_unknown"

        content = self._extract_full_text(msg_obj) or self._extract_text_delta(msg_obj) or ""
        out.append(self.emitter.tool_call_result(tool_call_id, self.parent_message_id, content))

        st = self._tool_calls.setdefault(tool_call_id, _ToolCallState())
        if st.started and not st.ended:
            out.append(self.emitter.tool_call_end(tool_call_id))
            st.ended = True
        elif not st.started:
            # If result arrives without start (rare), emit a synthetic start/end
            out.insert(0, self.emitter.tool_call_start(tool_call_id, self.parent_message_id, st.name or "tool"))
            out.append(self.emitter.tool_call_end(tool_call_id))
            st.started = True
            st.ended = True

        return out

    # -------------------------- response lifecycle -----------------------

    def _ensure_response_started(self, out: List[bytes]) -> None:
        if not self._response_started:
            out.append(self.emitter.response_start(self.parent_message_id))
            self._response_started = True

    # ------------------------------ extraction ---------------------------

    def _looks_message_like(self, obj: Any) -> bool:
        if obj is None:
            return False
        if isinstance(obj, dict):
            return any(k in obj for k in ("content", "tool_calls", "additional_kwargs", "role", "type"))
        return any(hasattr(obj, a) for a in ("content", "tool_calls", "additional_kwargs", "type", "role"))

    def _infer_role(self, msg_obj: Any) -> str:
        # LangChain messages often have .type == "ai"|"human"|"tool"|...
        t = getattr(msg_obj, "type", None)
        if isinstance(t, str):
            if t in ("ai", "assistant"):
                return "ai"
            if t in ("tool",):
                return "tool"
            if t in ("human", "user"):
                return "human"

        # Some have .role
        r = getattr(msg_obj, "role", None)
        if isinstance(r, str):
            if r in ("assistant", "ai"):
                return "ai"
            if r == "tool":
                return "tool"
            if r in ("user", "human"):
                return "human"

        # Dict fallback
        if isinstance(msg_obj, dict):
            r2 = msg_obj.get("role") or msg_obj.get("type")
            if r2 in ("assistant", "ai"):
                return "ai"
            if r2 == "tool":
                return "tool"
            if r2 in ("user", "human"):
                return "human"

        # Heuristic by class name
        name = msg_obj.__class__.__name__.lower()
        if "toolmessage" in name:
            return "tool"
        if "aimessage" in name:
            return "ai"
        if "humanmessage" in name:
            return "human"

        return "unknown"

    def _extract_tool_call_id(self, msg_obj: Any) -> Optional[str]:
        # ToolMessage often has .tool_call_id
        v = getattr(msg_obj, "tool_call_id", None)
        if isinstance(v, str) and v:
            return v

        # Sometimes in additional_kwargs
        ak = getattr(msg_obj, "additional_kwargs", None)
        if isinstance(ak, dict):
            v2 = ak.get("tool_call_id") or ak.get("tool_call_ids")
            if isinstance(v2, str) and v2:
                return v2
            if isinstance(v2, list) and v2:
                return v2[0]

        if isinstance(msg_obj, dict):
            v3 = msg_obj.get("tool_call_id") or msg_obj.get("tool_call_ids")
            if isinstance(v3, str) and v3:
                return v3
            if isinstance(v3, list) and v3:
                return v3[0]

        return None

    def _extract_tool_calls(self, msg_obj: Any) -> List[Dict[str, Any]]:
        """
        Returns a normalized list of tool call dicts with keys: id, name, args (dict|str|None)
        Supports:
          - .tool_calls (AIMessage)
          - .tool_call_chunks (AIMessageChunk)
          - additional_kwargs["tool_calls"] (OpenAI-style)
        """
        # 1) tool_call_chunks (streaming deltas)
        tcc = getattr(msg_obj, "tool_call_chunks", None)
        if isinstance(tcc, list) and tcc:
            out: List[Dict[str, Any]] = []
            for x in tcc:
                if isinstance(x, dict):
                    out.append({
                        "id": x.get("id") or x.get("tool_call_id"),
                        "name": x.get("name") or (x.get("function") or {}).get("name"),
                        "args": x.get("args") or (x.get("function") or {}).get("arguments"),
                    })
                else:
                    # object-like chunk
                    out.append({
                        "id": getattr(x, "id", None) or getattr(x, "tool_call_id", None),
                        "name": getattr(x, "name", None),
                        "args": getattr(x, "args", None),
                    })
            return out

        # 2) tool_calls (final tool call objects/dicts)
        tc = getattr(msg_obj, "tool_calls", None)
        if isinstance(tc, list) and tc:
            out: List[Dict[str, Any]] = []
            for x in tc:
                if isinstance(x, dict):
                    out.append({
                        "id": x.get("id") or x.get("tool_call_id"),
                        "name": x.get("name") or (x.get("function") or {}).get("name"),
                        "args": x.get("args") or (x.get("function") or {}).get("arguments"),
                        "function": x.get("function"),
                    })
                else:
                    # object-like
                    out.append({
                        "id": getattr(x, "id", None) or getattr(x, "tool_call_id", None),
                        "name": getattr(x, "name", None),
                        "args": getattr(x, "args", None),
                    })
            return out

        # 3) additional_kwargs["tool_calls"] (OpenAI-style)
        ak = getattr(msg_obj, "additional_kwargs", None)
        if isinstance(ak, dict) and isinstance(ak.get("tool_calls"), list) and ak["tool_calls"]:
            out: List[Dict[str, Any]] = []
            for x in ak["tool_calls"]:
                if isinstance(x, dict):
                    out.append(x)
            return out

        # 4) dict fallback
        if isinstance(msg_obj, dict):
            if isinstance(msg_obj.get("tool_calls"), list) and msg_obj["tool_calls"]:
                return [x for x in msg_obj["tool_calls"] if isinstance(x, dict)]
            if isinstance((msg_obj.get("additional_kwargs") or {}).get("tool_calls"), list):
                return [x for x in msg_obj["additional_kwargs"]["tool_calls"] if isinstance(x, dict)]

        return []

    def _extract_text_delta(self, msg_obj: Any) -> str:
        """
        For messages-mode token streaming: AIMessageChunk.content is usually the delta.
        """
        c = getattr(msg_obj, "content", None)
        if isinstance(c, str):
            return c
        if isinstance(c, list):
            return self._join_text_parts(c)

        if isinstance(msg_obj, dict):
            c2 = msg_obj.get("content")
            if isinstance(c2, str):
                return c2
            if isinstance(c2, list):
                return self._join_text_parts(c2)

        return ""

    def _extract_full_text(self, msg_obj: Any) -> str:
        """
        For updates-mode full messages or tool results: try to get full text representation.
        """
        # Prefer .content
        c = getattr(msg_obj, "content", None)
        if isinstance(c, str):
            return c
        if isinstance(c, list):
            return self._join_text_parts(c)

        # Some messages carry payload in .artifact / .additional_kwargs
        ak = getattr(msg_obj, "additional_kwargs", None)
        if isinstance(ak, dict):
            maybe = ak.get("content")
            if isinstance(maybe, str):
                return maybe

        if isinstance(msg_obj, dict):
            c2 = msg_obj.get("content")
            if isinstance(c2, str):
                return c2
            if isinstance(c2, list):
                return self._join_text_parts(c2)

        return ""

    def _join_text_parts(self, parts: List[Any]) -> str:
        """
        OpenAI-style content parts: [{"type":"text","text":"..."}], or raw strings.
        """
        out: List[str] = []
        for p in parts:
            if isinstance(p, str):
                out.append(p)
            elif isinstance(p, dict):
                if p.get("type") == "text" and isinstance(p.get("text"), str):
                    out.append(p["text"])
                elif isinstance(p.get("text"), str):
                    out.append(p["text"])
                elif isinstance(p.get("content"), str):
                    out.append(p["content"])
        return "".join(out)

    # ------------------------------ fallback -----------------------------

    def _emit_custom_raw(self, value: Any) -> List[bytes]:
        # If you prefer to drop raw payloads instead of emitting, return [] here.
        return [self.emitter._emit(  # uses your emitter's encoder path
            # Minimal CustomEvent-like dict fallback (works if your encoder can handle it).
            # If your encoder REQUIRES CustomEvent class, replace this with emitter.plan_snapshot / emitter.hitl_interrupt
            # or introduce a dedicated emitter.custom(name, value).
            type("Tmp", (), {"type": "custom", "name": "raw_chunk", "value": value, "timestamp": None})()
        )]

    def _safe_json(self, obj: Any) -> Any:
        try:
            json.dumps(obj, ensure_ascii=False)
            return obj
        except Exception:
            return repr(obj)
