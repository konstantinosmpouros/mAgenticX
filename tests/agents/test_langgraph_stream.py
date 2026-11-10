"""LangGraph agents stream through the same emitter and normalizer as deep agents.

Pinned:

* a ``custom``-mode node that writes emitter events to its stream writer, as is
  or through ``send``, reaches the client as SSE frames, in order — a dict (or a
  thought's three) is never mistaken for an ``updates`` payload and dropped;
* a ``["messages", "updates"]`` LangGraph agent with a model inside its node is
  normalized into exactly one text message for that model call.
"""
from __future__ import annotations

import asyncio
import json
from typing import Any, ClassVar, TypedDict

from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage
from langgraph.config import get_stream_writer
from langgraph.graph import END, START

from harness.abstractions.langgraph_agent import LangGraphAgent
from harness.agui.emitter import send

RUN_ID = "lg-run"

THINKING_AND_REPLY = [
    "THINKING_START",
    "THINKING_TEXT_MESSAGE_START", "THINKING_TEXT_MESSAGE_CONTENT", "THINKING_TEXT_MESSAGE_END",
    "THINKING_END",
    "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END",
]


class _State(TypedDict, total=False):
    messages: list
    done: bool


class _GraphAgent(LangGraphAgent):
    """One node, ``answer``; each subclass says how it streams."""

    def __init__(self) -> None:
        super().__init__(config={
            "context": {"user_id": "user-1", "conversation_id": "conv-1", "run_id": RUN_ID},
            "run_config": {"configurable": {"thread_id": "lg-thread"}},
        })
        self.state = _State

    def _durable_checkpointer(self) -> None:
        return None

    def register_agents(self) -> Any:
        return object()

    def register_graph_nodes(self, graph: Any) -> Any:
        graph.add_node("answer", self.nodes)
        return graph

    def register_graph_edges(self, graph: Any) -> Any:
        graph.add_edge(START, "answer")
        graph.add_edge("answer", END)
        return graph


class _RawWriterAgent(_GraphAgent):
    """``custom``: the node writes the emitter's events unencoded."""

    name = "raw-writer-langgraph-test"

    def register_nodes(self) -> Any:
        def answer(state: _State) -> dict:
            write, agui = get_stream_writer(), self.agui_emitter
            write(agui.thinking_start())
            write(agui.thought("**Plan**\n\nAnswer briefly."))
            write(agui.thinking_end())
            write(agui.response_start(RUN_ID))
            write(agui.response_content(RUN_ID, "Hello."))
            write(agui.response_end(RUN_ID))
            return {"done": True}

        return answer


class _SendAgent(_GraphAgent):
    """``custom``: the node writes through ``send``, as the shipped LangGraph agents do."""

    name = "send-langgraph-test"

    def register_nodes(self) -> Any:
        def answer(state: _State) -> dict:
            writer, agui = get_stream_writer(), self.agui_emitter
            send(writer, agui.thinking_start())
            send(writer, agui.thought("**Plan**\n\nAnswer briefly."))
            send(writer, agui.thinking_end())
            send(writer, [agui.response_start(RUN_ID), agui.response_content(RUN_ID, "Hello."), agui.response_end(RUN_ID)])
            return {"done": True}

        return answer


class _ModelAgent(_GraphAgent):
    """``messages``/``updates``: a model call inside the node, normalized."""

    name = "model-langgraph-test"
    stream_mode: ClassVar[list[str]] = ["messages", "updates"]

    def register_nodes(self) -> Any:
        model = GenericFakeChatModel(messages=iter([AIMessage(content="Hello there.")]))

        def answer(state: _State) -> dict:
            return {"messages": [model.invoke("Hi")]}

        return answer


def _stream(agent: _GraphAgent) -> list[dict]:
    async def run() -> list[bytes]:
        return [frame async for frame in agent.astream({"messages": []})]

    frames = asyncio.run(run())
    assert all(isinstance(frame, bytes) and frame.startswith(b"data: ") for frame in frames)
    return [json.loads(frame.decode()[5:]) for frame in frames]


def _types(events: list[dict]) -> list[str]:
    return [e["name"] if e["type"] == "CUSTOM" else e["type"] for e in events]


def test_a_node_writing_unencoded_emitter_events_streams_them():
    events = _stream(_RawWriterAgent())
    assert _types(events) == THINKING_AND_REPLY
    assert events[2]["delta"] == "**Plan**\n\nAnswer briefly."


def test_a_node_writing_through_send_streams_the_same_events():
    events = _stream(_SendAgent())
    assert _types(events) == THINKING_AND_REPLY
    assert events[6]["delta"] == "Hello."


def test_a_model_inside_a_node_is_normalized_into_one_text_message():
    types = _types(_stream(_ModelAgent()))
    assert types.count("TEXT_MESSAGE_START") == 1 and types.count("TEXT_MESSAGE_END") == 1
    assert types.index("TEXT_MESSAGE_START") < types.index("TEXT_MESSAGE_END")
