import json
import asyncio
import httpx
from uuid import uuid4

from typing import Literal, List, Any, Dict, Union
from pydantic import BaseModel
from langchain.schema import BaseMessage
from langchain.prompts import ChatPromptTemplate

from config import HR_ENDPOINT as ENDPOINT
from agents.langgraph_agents.hr_policies_agent_v1.agents import (
    analysis_agent,
    simple_gen_agent,
    reflection_agent,
    query_reflective_agent,
    query_no_reflective_agent,
    complex_gen_agent,
    summarizer_agent,
    doc_ranking_agent,
)

from agents.langgraph_agents.hr_policies_agent_v1.prompt_templates import (
    non_hr_gen_template,
    hr_gen_template
)

from langchain_core.runnables import RunnableConfig
from langgraph.types import StreamWriter
from langchain_core.messages.ai import AIMessageChunk

from agui import agui_emitter



class HRPoliciesV1_State(BaseModel):
    user_input: Any
    user_input_json: Any = None
    
    message_id: str | None = None
    
    analysis_results: Any = None
    analysis_str: str = None
    
    vector_queries: List[str] = None
    
    retrieved_content: List[List[Dict]] = [[]]
    
    ranking_flags: List[List[bool]] = [[]]
    
    reflection: Any = None
    reflection_str: str = None
    cycle_numbers: int = 0
    formatted_docs_str: str = None
    
    summarization: str = None
    
    response: str = None
    
    def __getitem__(self, key: str) -> Any:
        return getattr(self, key)


async def analysis(state: HRPoliciesV1_State, config: RunnableConfig, writer: StreamWriter) -> HRPoliciesV1_State:
    # AG-UI: ensure message id and start thinking
    message_id = state.message_id or str(uuid4())
    agui_emitter.thinking_start(writer)
    agui_emitter.thought(writer, "Analyzing the user input...")
    
    user_msg = state['user_input']
    analysis_results = await analysis_agent.ainvoke(user_msg, config)
    
    analysis_str = (
        f"***Classification***: This question is **{analysis_results.query_domain}**.  \n"
        f"***Topic(s)***: {', '.join(analysis_results.key_topics)}.  \n"
        f"***Context requirements***: {analysis_results.context_requirements}.  \n"
        f"***Overall complexity***: {analysis_results.query_complexity}.  \n"
        f"***Language***: {analysis_results.user_language}"
    )
    
    agui_emitter.thought(writer, analysis_str)
    return {
        'analysis_results': analysis_results,
        'analysis_str': analysis_str,
        "user_input_json": json.dumps(user_msg),
        "message_id": message_id
    }


def check_if_hr(state: HRPoliciesV1_State) -> Literal["query_gen", "simple_generation"]:
    """Fast synchronous branching helper (no IO)."""
    return "query_gen" if state["analysis_results"].query_domain == "HR-Policy" else "simple_generation"


async def simple_generation(state: HRPoliciesV1_State, config: RunnableConfig, writer: StreamWriter) -> HRPoliciesV1_State:
    # AG-UI: finalize thinking and begin assistant message streaming
    agui_emitter.thinking_end(writer)
    agui_emitter.response_start(writer, state["message_id"])
    
    payload = {
        "analysis_results": state["analysis_str"],
        "user_input_json": state["user_input_json"]
    }
    prompt = non_hr_gen_template.invoke(payload)
    
    response = ''
    async for mode, chunk in simple_gen_agent.astream(prompt, stream_mode=["messages", "updates"]):
        if mode == 'messages':
            message_chunk, _ = chunk
            if getattr(message_chunk, "content", None) and isinstance(message_chunk, AIMessageChunk):
                agui_emitter.response_chunk(writer, state["message_id"], message_chunk.content)
                response += message_chunk.content

        elif mode == 'updates':
            # chunk is a dict, containing updates per node
            if "agent" in chunk:
                agent_msg = chunk['agent']['messages'][0]
                if getattr(agent_msg, "tool_calls", None):
                    for tool_call in agent_msg.tool_calls:
                        agui_emitter.tool_call_start(
                            writer,
                            tool_call["id"],
                            state["message_id"],
                            tool_call.get('name'),
                            tool_call.get('args'),
                        )
            elif "tools" in chunk:
                tool_msg = chunk['tools']['messages'][0]
                agui_emitter.tool_call_result(
                    writer,
                    tool_call["id"],
                    state["message_id"],
                    tool_msg.content,
                )
    agui_emitter.response_end(writer, state["message_id"])
    return {"response": response}


async def query_gen(state: HRPoliciesV1_State, config: RunnableConfig, writer: StreamWriter) -> HRPoliciesV1_State:
    agui_emitter.thought(writer, "Generating queries for the HR policies database...")
    
    analysis_str = state['analysis_str']
    reflection_str = state["reflection_str"]
    
    if reflection_str:
        payload = {
            "analysis_results": analysis_str,
            "reflection": reflection_str
        }
        response = await query_reflective_agent.ainvoke(payload, config)
    else:
        payload = {
            "analysis_results": analysis_str
        }
        response = await query_no_reflective_agent.ainvoke(payload, config)
    
    # Emit a reasoning header via the writer
    lines = ["I perform research in the database for the following fields:"]
    for idx, q in enumerate(response.queries, start=1):
        lines.append(f"{idx}. {q}")
    header_content = "\n".join(lines)
    agui_emitter.thought(writer, header_content)
    return {"vector_queries": response.queries}


async def retrieval(state: HRPoliciesV1_State, writer: StreamWriter):
    agui_emitter.thought(writer, "Retrieving content from the HR policies database...")
    tcid = str(uuid4())
    retrieved_docs = []
    
    async def fetch_single(query: str):
        nonlocal retrieved_docs
        async with httpx.AsyncClient() as client:
            r = await client.post(ENDPOINT, json={"query": query, "k": 2}, timeout=30)
            r.raise_for_status()
            retrieved_docs.extend(r.json()["documents"])
    
    agui_emitter.tool_call_start(writer, tcid, state["message_id"], "vector_db.search", {"queries": state["vector_queries"], "k": 2})
    await asyncio.gather(*(fetch_single(q) for q in state["vector_queries"]))
    
    agui_emitter.tool_call_result(writer, tcid, state["message_id"], f"Gathered in total {len(retrieved_docs)} relevant documents.")
    agui_emitter.thought(writer, f"Retrieved {len(retrieved_docs)} documents from the database.")
    
    state_docs = state['retrieved_content']
    state_docs.extend([retrieved_docs])
    return {"retrieved_content": state_docs}


async def doc_ranking(state: HRPoliciesV1_State, config: RunnableConfig, writer: StreamWriter) -> HRPoliciesV1_State:
    agui_emitter.thought(writer, "Ranking the retrieved documents based on relevance...")
    
    retrieved_docs = state['retrieved_content']
    analysis_str = state['analysis_str']
    
    formatted_docs = []
    for idx, doc in enumerate(retrieved_docs[-1], start=1):
        metadata = json.dumps(doc.get("metadata", {}), ensure_ascii=False)
        content = doc.get("content", "").strip()
        formatted_docs.append(f"Document {idx}\n Metadata: {metadata}\n Content: {content}\n")
    
    formatted_docs_str = "\n\n".join(formatted_docs)
    
    payload = {
        "formatted_docs": formatted_docs_str,
        "analysis_str": analysis_str,
    }
    
    ranking_flags = await doc_ranking_agent.ainvoke(payload, config)
    
    state_flags = state['ranking_flags']
    state_flags.extend([ranking_flags.relevance_flags])
    return {"ranking_flags": state_flags}


async def reflection(state: HRPoliciesV1_State, config: RunnableConfig, writer: StreamWriter) -> HRPoliciesV1_State:
    agui_emitter.thought(writer, "Reasoning if we need more data to answer...")
    
    all_docs_cycles = state['retrieved_content']
    all_flags_cycles = state['ranking_flags']
    analysis_str = state['analysis_str']
    
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
    
    reflection = await reflection_agent.ainvoke(payload, config)
    reflection_str = (
        f"Additional retrieval needed: **Yes**.  \n"
        f"Reflection: {reflection.reflection}.  \n"
        f"Recommended next steps: {reflection.recommended_next_steps}"
        if reflection.requires_additional_retrieval
        else "No additional retrieval is required."
    )
    
    return {
        "reflection": reflection,
        "reflection_str": reflection_str,
        "formatted_docs_str": formatted_docs_str,
        "cycle_numbers": state.cycle_numbers + (1 if reflection.requires_additional_retrieval else 0),
    }


def check_reflection(state: HRPoliciesV1_State, writer: StreamWriter) -> Literal["query_gen", "summarizer"]:
    if state['reflection'].requires_additional_retrieval and state['cycle_numbers'] < 1:
        return 'query_gen'
    else:
        return 'summarizer'


async def summarization(state: HRPoliciesV1_State, config: RunnableConfig, writer: StreamWriter) -> HRPoliciesV1_State:
    agui_emitter.thought(writer, "Summarizing the retrieved documents...")
    
    formatted_docs_str = state['formatted_docs_str']
    analysis_str = state['analysis_str']
    
    payload = {
        "retrieved_docs": formatted_docs_str,
        "analysis_results": analysis_str,
    }
    
    summarization = await summarizer_agent.ainvoke(payload, config)
    
    agui_emitter.thought(writer, "Preparing the response...")
    return {"summarization": summarization.content}


async def complex_generation(state: HRPoliciesV1_State, config: RunnableConfig, writer: StreamWriter) -> HRPoliciesV1_State:
    # AG-UI: finalize thinking and begin assistant message streaming
    agui_emitter.thinking_end(writer)
    agui_emitter.response_start(writer, state["message_id"])
    
    payload = {
        "summarization": state["summarization"],
        "analysis_results": state["analysis_str"],
        "user_input_json": state["user_input_json"],
    }
    prompt = hr_gen_template.invoke(payload)
    
    # invoke the generation agent
    response = ''
    async for mode, chunk in complex_gen_agent.astream(prompt, stream_mode=["messages", "updates"]):
        if mode == 'messages':
            message_chunk, _ = chunk
            if getattr(message_chunk, "content", None) and isinstance(message_chunk, AIMessageChunk):
                agui_emitter.response_chunk(writer, state["message_id"], message_chunk.content)
                response += message_chunk.content

        elif mode == 'updates':
            # chunk is a dict, containing updates per node
            if "agent" in chunk:
                agent_msg = chunk['agent']['messages'][0]
                if getattr(agent_msg, "tool_calls", None):
                    for tool_call in agent_msg.tool_calls:
                        agui_emitter.tool_call_start(
                            writer,
                            tool_call["id"],
                            state["message_id"],
                            tool_call.get('name'),
                            tool_call.get('args'),
                        )
            elif "tools" in chunk:
                tool_msg = chunk['tools']['messages'][0]
                agui_emitter.tool_call_result(
                    writer,
                    tool_call["id"],
                    state["message_id"],
                    tool_msg.content,
                )
    agui_emitter.response_end(writer, state["message_id"])
    return {"response": response}






