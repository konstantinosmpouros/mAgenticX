import asyncio
import json
from dataclasses import dataclass
from typing import Any, Dict, List, Literal
from uuid import uuid4

import httpx
from pydantic import BaseModel, Field

from config import HR_ENDPOINT as ENDPOINT
from langgraph_agents.hr_policies_agent_v1.agents import HRAgents
from langgraph_agents.hr_policies_agent_v1.prompt_templates import (
    non_hr_gen_template,
    hr_gen_template,
)
from blueprints.agui import AGUIEmitter
from langchain_core.messages.ai import AIMessageChunk
from langchain_core.runnables import RunnableConfig
from langgraph.config import get_stream_writer

class HRPoliciesV1_State(BaseModel):
    user_input: Any
    
    message_id: str | None = None
    
    analysis_results: Any = None
    analysis_str: str | None = None
    
    vector_queries: List[str] | None = None
    retrieved_content: List[List[Dict[str, Any]]] = Field(default_factory=list)
    ranking_flags: List[List[bool]] = Field(default_factory=list)
    
    reflection: Any = None
    reflection_str: str | None = None
    cycle_numbers: int = 0
    formatted_docs_str: str | None = None
    
    summarization: str | None = None
    response: str | None = None
    
    def __getitem__(self, key: str) -> Any:
        return getattr(self, key)


@dataclass
class HRNodes:
    analysis: Any
    check_if_hr: Any
    simple_generation: Any
    query_gen: Any
    retrieval: Any
    doc_ranking: Any
    reflection: Any
    check_reflection: Any
    summarization: Any
    complex_generation: Any


def build_hr_nodes(*, agents: HRAgents, agui: AGUIEmitter) -> HRNodes:
    """Bind HR nodes to the configured agents and AG-UI emitter."""

    async def analysis(state: HRPoliciesV1_State, config: RunnableConfig):
        writer = get_stream_writer()
        message_id = state.message_id or str(uuid4())
        agui.thinking_start(writer)
        agui.thought("Analyzing the user input...", writer)

        user_msg = state["user_input"]
        analysis_results = await agents.analysis_agent.ainvoke(user_msg, config)

        analysis_str = (
            f"***Classification***: This question is **{analysis_results.query_domain}**.  \n"
            f"***Topic(s)***: {', '.join(analysis_results.key_topics)}.  \n"
            f"***Context requirements***: {analysis_results.context_requirements}.  \n"
            f"***Overall complexity***: {analysis_results.query_complexity}.  \n"
            f"***Language***: {analysis_results.user_language}"
        )

        agui.thought(analysis_str, writer)
        return {
            "analysis_results": analysis_results,
            "analysis_str": analysis_str,
            "message_id": message_id,
        }

    def check_if_hr(state: HRPoliciesV1_State) -> Literal["query_gen", "simple_generation"]:
        return "query_gen" if state["analysis_results"].query_domain == "HR-Policy" else "simple_generation"

    async def simple_generation(state: HRPoliciesV1_State, config: RunnableConfig):
        writer = get_stream_writer()
        agui.thinking_end(writer)
        agui.response_start(state["message_id"], writer)

        payload = {
            "analysis_results": state["analysis_str"],
            "user_input_json": json.dumps(state["user_input"], ensure_ascii=False),
        }
        prompt = non_hr_gen_template.invoke(payload)

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
                                state["message_id"],
                                tool_call.get("name"),
                                writer,
                            )
                elif "tools" in chunk:
                    tool_msg = chunk["tools"]["messages"][0]
                    call_id = getattr(tool_msg, "tool_call_id", None) or last_tool_call_id
                    if call_id:
                        agui.tool_call_result(
                            call_id,
                            state["message_id"],
                            tool_msg.content,
                            writer,
                        )
                        
        agui.response_end(state["message_id"], writer)
        return {"response": response}

    async def query_gen(state: HRPoliciesV1_State, config: RunnableConfig):
        writer = get_stream_writer()
        agui.thought(writer, "Generating queries for the HR policies database...")
        
        analysis_str = state["analysis_str"]
        reflection_str = state["reflection_str"]
        
        if reflection_str:
            payload = {"analysis_results": analysis_str, "reflection": reflection_str}
            response = await agents.query_reflective_agent.ainvoke(payload, config)
        else:
            payload = {"analysis_results": analysis_str}
            response = await agents.query_no_reflective_agent.ainvoke(payload, config)
        
        lines = ["I perform research in the database for the following fields:"]
        for idx, q in enumerate(response.queries, start=1):
            lines.append(f"{idx}. {q}")
        agui.thought("\n".join(lines), writer)
        return {"vector_queries": response.queries}

    async def retrieval(state: HRPoliciesV1_State):
        writer = get_stream_writer()
        agui.thought("Retrieving content from the HR policies database...", writer)
        tcid = str(uuid4())
        queries = state["vector_queries"] or []
        retrieved_docs: List[Dict[str, Any]] = []
        
        async def fetch_single(query: str):
            async with httpx.AsyncClient() as client:
                resp = await client.post(ENDPOINT, json={"query": query, "k": 2}, timeout=30)
                resp.raise_for_status()
                retrieved_docs.extend(resp.json()["documents"])
        
        agui.tool_call_start(tcid, state["message_id"], "vector_db.search", writer)
        if queries:
            await asyncio.gather(*(fetch_single(q) for q in queries))
        agui.tool_call_result(
            tcid,
            state["message_id"],
            f"Gathered in total {len(retrieved_docs)} relevant documents.",
            writer,
        )
        agui.thought(f"Retrieved {len(retrieved_docs)} documents from the database.", writer)
        
        state_docs = list(state.retrieved_content)
        state_docs.append(retrieved_docs)
        return {"retrieved_content": state_docs}

    async def doc_ranking(state: HRPoliciesV1_State, config: RunnableConfig):
        writer = get_stream_writer()
        agui.thought("Ranking the retrieved documents based on relevance...", writer)
        
        if not state["retrieved_content"]:
            return {}
        
        latest_docs = state["retrieved_content"][-1]
        formatted_docs = []
        for idx, doc in enumerate(latest_docs, start=1):
            metadata = json.dumps(doc.get("metadata", {}), ensure_ascii=False)
            content = doc.get("content", "").strip()
            formatted_docs.append(f"Document {idx}\n Metadata: {metadata}\n Content: {content}\n")
        
        formatted_docs_str = "\n\n".join(formatted_docs)
        
        payload = {
            "formatted_docs": formatted_docs_str,
            "analysis_str": state["analysis_str"],
        }
        ranking_flags = await agents.doc_ranking_agent.ainvoke(payload, config)
        
        state_flags = list(state.ranking_flags)
        state_flags.append(ranking_flags.relevance_flags)
        return {"ranking_flags": state_flags}

    async def reflection(state: HRPoliciesV1_State, config: RunnableConfig):
        writer = get_stream_writer()
        agui.thought("Reasoning if we need more data to answer...", writer)
        
        all_docs_cycles = state["retrieved_content"]
        all_flags_cycles = state["ranking_flags"]
        analysis_str = state["analysis_str"]
        
        filtered_docs = []
        for docs, flags in zip(all_docs_cycles, all_flags_cycles):
            for doc, flag in zip(docs, flags):
                if flag:
                    filtered_docs.append(doc)
        
        formatted_docs_str = "\n\n".join(
            f"Document {i+1}\n Metadata: {doc.get('metadata')} \nContent: {doc.get('content', '').strip()}"
            for i, doc in enumerate(filtered_docs)
        )
        
        payload = {
            "analysis_results": analysis_str,
            "retrieved_docs": formatted_docs_str,
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
            
        return {
            "reflection": reflection,
            "reflection_str": reflection_str,
            "formatted_docs_str": formatted_docs_str,
            "cycle_numbers": state.cycle_numbers + (1 if reflection.requires_additional_retrieval else 0),
        }

    def check_reflection(state: HRPoliciesV1_State) -> Literal["query_gen", "summarizer"]:
        reflection = state["reflection"]
        if reflection and reflection.requires_additional_retrieval and state["cycle_numbers"] < 1:
            return "query_gen"
        return "summarizer"

    async def summarization(state: HRPoliciesV1_State, config: RunnableConfig):
        writer = get_stream_writer()
        agui.thought(writer, "Summarizing the retrieved documents...")
        
        payload = {
            "retrieved_docs": state["formatted_docs_str"],
            "analysis_results": state["analysis_str"],
        }
        
        summary = await agents.summarizer_agent.ainvoke(payload, config)
        agui.thought(writer, "Preparing the response...")
        return {"summarization": summary.content if hasattr(summary, "content") else summary}

    async def complex_generation(state: HRPoliciesV1_State, config: RunnableConfig):
        writer = get_stream_writer()
        agui.thinking_end(writer)
        agui.response_start(writer, state["message_id"])
        
        payload = {
            "summarization": state["summarization"],
            "analysis_results": state["analysis_str"],
            "user_input_json": json.dumps(state["user_input"], ensure_ascii=False),
        }
        prompt = hr_gen_template.invoke(payload)
        
        response = ""
        last_tool_call_id: str | None = None
        async for mode, chunk in agents.complex_gen_agent.astream(prompt, stream_mode=["messages", "updates"]):
            if mode == "messages":
                message_chunk, _ = chunk
                if getattr(message_chunk, "content", None) and isinstance(message_chunk, AIMessageChunk):
                    agui.response_chunk(writer, state["message_id"], message_chunk.content)
                    response += message_chunk.content
            elif mode == "updates":
                if "agent" in chunk:
                    agent_msg = chunk["agent"]["messages"][0]
                    if getattr(agent_msg, "tool_calls", None):
                        for tool_call in agent_msg.tool_calls:
                            last_tool_call_id = tool_call["id"]
                            agui.tool_call_start(
                                writer,
                                tool_call["id"],
                                state["message_id"],
                                tool_call.get("name"),
                            )
                elif "tools" in chunk:
                    tool_msg = chunk["tools"]["messages"][0]
                    call_id = getattr(tool_msg, "tool_call_id", None) or last_tool_call_id
                    if call_id:
                        agui.tool_call_result(
                            writer,
                            call_id,
                            state["message_id"],
                            tool_msg.content,
                        )
        
        agui.response_end(writer, state["message_id"])
        return {"response": response}

    return HRNodes(
        analysis=analysis,
        check_if_hr=check_if_hr,
        simple_generation=simple_generation,
        query_gen=query_gen,
        retrieval=retrieval,
        doc_ranking=doc_ranking,
        reflection=reflection,
        check_reflection=check_reflection,
        summarization=summarization,
        complex_generation=complex_generation,
    )
