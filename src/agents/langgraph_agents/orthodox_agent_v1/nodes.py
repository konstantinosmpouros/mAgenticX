import asyncio
import json
from dataclasses import dataclass
from typing import Any, Dict, List, Literal
from uuid import uuid4

import httpx
from pydantic import BaseModel

from config import ORTHODOX_ENDPOINT as ENDPOINT
from langgraph_agents.orthodox_agent_v1.agents import OrthodoxAgents
from langgraph_agents.orthodox_agent_v1.prompt_templates import (
    nonreligious_gen_template,
    religious_gen_template,
)
from agui import AGUIEmitter
from langchain_core.messages.ai import AIMessageChunk
from langchain_core.runnables import RunnableConfig
from langgraph.config import get_stream_writer


class OrthodoxV1_State(BaseModel):
    user_input: Any
    
    message_id: str | None = None
    
    analysis_results: Any = None
    analysis_str: str | None = None
    
    vector_queries: List[str] | None = None
    retrieved_content: List[Dict[str, Any]] | str | None = None
    summarization: Any = None
    
    reflection: Any = None
    reflection_str: str | None = None
    
    response: str | None = None
    
    cycle_numbers: int = 0
    
    def __getitem__(self, key: str) -> Any:
        return getattr(self, key)


@dataclass
class OrthodoxNodes:
    analysis: Any
    check_if_religious: Any
    simple_generation: Any
    query_gen: Any
    retrieval: Any
    summarization: Any
    complex_generation: Any
    reflection: Any
    check_reflection: Any


def build_orthodox_nodes(*, agents: OrthodoxAgents, agui: AGUIEmitter) -> OrthodoxNodes:
    """Bind Orthodox workflow nodes to the provided agents and AG-UI emitter."""

    async def analysis(state: OrthodoxV1_State, config: RunnableConfig):
        writer = get_stream_writer()
        user_msg = state["user_input"]
        message_id = state.message_id or str(uuid4())
        
        agui.thinking_start(writer)
        analysis_results = await agents.analysis_agent.ainvoke(user_msg, config)
        
        analysis_str = (
            f"***Classification***: This question is **{analysis_results.is_religious}**.  \n"
            f"***Topic***: The question is focusing on {', '.join(analysis_results.key_topics)}.  \n"
            f"***Context requirements***: {analysis_results.context_requirements}.  \n"
            f"***Overall complexity***: {analysis_results.query_complexity}.  \n"
            f"***Reasoning***: {analysis_results.reasoning}"
        )
        agui.thought(analysis_str, writer)
        return {
            "analysis_results": analysis_results,
            "analysis_str": analysis_str,
            "message_id": message_id,
        }

    def check_if_religious(state: OrthodoxV1_State) -> Literal["query_gen", "simple_generation"]:
        return "query_gen" if state["analysis_results"].is_religious == "Religious" else "simple_generation"

    async def simple_generation(state: OrthodoxV1_State, config: RunnableConfig):
        writer = get_stream_writer()
        agui.thinking_end(writer)
        agui.response_start(state["message_id"], writer)
        
        payload = {"analysis_results": state["analysis_str"]}
        prompt = nonreligious_gen_template.invoke(payload)
        
        response = ""
        last_tool_call_id: str | None = None
        
        async for mode, chunk in agents.simple_gen_agent.astream(prompt, stream_mode=["messages", "updates"]):
            if mode == "messages":
                message_chunk, _ = chunk
                if getattr(message_chunk, "content", None) and isinstance(message_chunk, AIMessageChunk):
                    agui.response_chunk(state["message_id"], message_chunk.content, writer)
                    response += message_chunk.content
            elif mode == "updates":
                if "agent" in chunk:
                    agent_msg = chunk["agent"]["messages"][0]
                    if getattr(agent_msg, "tool_calls", None):
                        for tool_call in agent_msg.tool_calls:
                            last_tool_call_id = tool_call["id"]
                            agui.tool_call_start(
                                tool_call["id"],
                                tool_call.get("name"),
                                writer,
                            )
                elif "tools" in chunk:
                    tool_msg = chunk["tools"]["messages"][0]
                    call_id = getattr(tool_msg, "tool_call_id", None) or last_tool_call_id
                    if call_id:
                        agui.tool_call_result(
                            call_id,
                            tool_msg.content,
                            writer,
                        )
                        
        agui.response_end(state["message_id"], writer)
        return {"response": response}

    async def query_gen(state: OrthodoxV1_State, config: RunnableConfig):
        writer = get_stream_writer()
        analysis_str = state["analysis_str"]
        reflection = state["reflection"]
        
        if reflection and getattr(reflection, "requires_additional_retrieval", False):
            payload = {
                "analysis_results": analysis_str,
                "reflection": reflection,
            }
            response = await agents.query_reflective_agent.ainvoke(payload, config)
        else:
            payload = {"analysis_results": analysis_str}
            response = await agents.query_no_reflective_agent.ainvoke(payload, config)
        
        lines = ["I will perform a research in the database for the following fields:"]
        for idx, q in enumerate(response.queries, start=1):
            lines.append(f"{idx}. {q}")
        agui.thought("\n".join(lines), writer)
        return {"vector_queries": response.queries}

    async def retrieval(state: OrthodoxV1_State):
        writer = get_stream_writer()
        retrieved_docs: List[Dict[str, Any]] = []
        tcid = str(uuid4())
        
        async def fetch_single(query: str):
            async with httpx.AsyncClient() as client:
                resp = await client.post(ENDPOINT, json={"query": query, "k": 10}, timeout=30)
                resp.raise_for_status()
                retrieved_docs.extend(resp.json()["documents"])
                
        queries = state["vector_queries"] or []
        agui.tool_call_start(tcid, "vector_db.search", writer)
        if queries:
            await asyncio.gather(*(fetch_single(q) for q in queries))
        agui.tool_call_result(
            tcid,
            f"Gathered in total {len(retrieved_docs)} relevant documents.",
            writer,
        )
        
        return {"retrieved_content": json.dumps(retrieved_docs, ensure_ascii=False, indent=2)}

    async def summarization(state: OrthodoxV1_State, config: RunnableConfig):
        writer = get_stream_writer()
        payload = {
            "retrieved_docs": state["retrieved_content"],
            "analysis_results": state["analysis_str"],
        }
        summary = await agents.summarizer_agent.ainvoke(payload, config)
        agui.thought(summary.content, writer)
        return {"summarization": summary}

    async def complex_generation(state: OrthodoxV1_State, config: RunnableConfig):
        writer = get_stream_writer()
        payload = {
            "summarization": state["summarization"],
            "analysis_results": state["analysis_str"],
        }
        prompt = religious_gen_template.invoke(payload)
        
        response = ""
        async for update in agents.complex_gen_agent.astream(prompt, stream_mode=["updates"]):
            _, payload = update
            
            if "agent" in payload:
                message = payload["agent"]["messages"][0]
                if getattr(message, "tool_calls", None):
                    for tool in message.tool_calls:
                        agui.tool_call_start(
                            tool.get("id"),
                            tool.get("name"),
                            writer,
                        )
                elif getattr(message, "content", None):
                    response += message.content
            elif "tools" in payload:
                tool_msg = payload["tools"]["messages"][0]
                agui.tool_call_result(
                    tool_msg.get("id"),
                    tool_msg.get("content"),
                    writer,
                )
        
        return {"response": response}

    async def reflection(state: OrthodoxV1_State, config: RunnableConfig):
        writer = get_stream_writer()
        payload = {
            "analysis_results": state["analysis_str"],
            "generated_response": state["response"],
        }
        reflection = await agents.reflection_agent.ainvoke(payload, config)
        
        if reflection.requires_additional_retrieval:
            reflection_str = (
                f"Additional retrieval needed: **Yes**.  \n"
                f"Reflection: {reflection.reflection}.  \n"
                f"Recommended next steps: {reflection.recommended_next_steps}"
            )
        else:
            reflection_str = "No additional retrieval is required."
        
        agui.thought(reflection_str, writer)
        return {
            "reflection": reflection,
            "reflection_str": reflection_str,
            "cycle_numbers": state.cycle_numbers + (1 if reflection.requires_additional_retrieval else 0),
        }

    def check_reflection(state: OrthodoxV1_State) -> Literal["query_gen", "end"]:
        writer = get_stream_writer()
        requires_more = state["reflection"].requires_additional_retrieval
        if requires_more and state["cycle_numbers"] < 1:
            return "query_gen"
        
        agui.thinking_end(writer)
        agui.response_start(state["message_id"], writer)
        if state["response"]:
            agui.response_content(state["message_id"], state["response"], writer)
        agui.response_end(state["message_id"], writer)
        return "end"

    return OrthodoxNodes(
        analysis=analysis,
        check_if_religious=check_if_religious,
        simple_generation=simple_generation,
        query_gen=query_gen,
        retrieval=retrieval,
        summarization=summarization,
        complex_generation=complex_generation,
        reflection=reflection,
        check_reflection=check_reflection,
    )
