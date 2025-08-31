import json
import asyncio
import httpx
from uuid import uuid4

from orthodox_agents.orthodox_agent_v1.states import OrthodoxV1_State
from typing import Literal
from orthodox_agents.orthodox_agent_v1.config import ENDPOINT
from orthodox_agents.orthodox_agent_v1.agents import (
    analysis_agent,
    simple_gen_agent,
    reflection_agent,
    query_reflective_agent,
    query_no_reflective_agent,
    complex_gen_agent,
    summarizer_agent
)

from langchain_core.runnables import RunnableConfig
from langgraph.types import StreamWriter
from langchain_core.messages.ai import AIMessageChunk

from orthodox_agents.orthodox_agent_v1.prompts.templates import (
    nonreligious_gen_template,
    religious_gen_template
)
from orthodox_agents.orthodox_agent_v1.prompts.agui import AGUIEmitter

async def analysis(state: OrthodoxV1_State, config: RunnableConfig, writer: StreamWriter) -> OrthodoxV1_State:
    """Parse the user question and classify it.

    This node is IO-bound (LLM call) so we expose it as async and call the
    asynchronous `.ainvoke` method provided by the LangChain agent wrappers.
    """
    user_msg = state['user_input']
    # Ensure we have a message id for AG-UI stream correlation
    message_id = state.message_id or str(uuid4())
    ui = AGUIEmitter(writer, message_id)
    analysis_results = await analysis_agent.ainvoke(user_msg, config)
    
    analysis_str = (
        f"***Classification***: This question is **{analysis_results.is_religious}**.  \n"
        f"***Topic***: The question is focusing on {', '.join(analysis_results.key_topics)}.  \n"
        f"***Context requirements***: {analysis_results.context_requirements}.  \n"
        f"***Overall complexity***: {analysis_results.query_complexity}.  \n"
        f"***Reasoning***: {analysis_results.reasoning}"
    )
    ui.thought(analysis_str)
    return {'analysis_results': analysis_results, 'analysis_str': analysis_str, 'message_id': message_id}


def check_if_religious(state: OrthodoxV1_State) -> Literal["query_gen", "simple_generation"]:
    """Fast synchronous branching helper (no IO)."""
    return 'query_gen' if state['analysis_results'].is_religious == "Religious" else 'simple_generation'


async def simple_generation(state: OrthodoxV1_State, config: RunnableConfig, writer: StreamWriter) -> OrthodoxV1_State:
    payload = {"analysis_results": state["analysis_str"]}
    prompt = nonreligious_gen_template.invoke(payload)
    response = ''
    ui = AGUIEmitter(writer, state["message_id"])
    async for mode, chunk in simple_gen_agent.astream(prompt, stream_mode=["messages", "updates"]):
        if mode == 'messages':
            message_chunk, _ = chunk
            if getattr(message_chunk, "content", None) and isinstance(message_chunk, AIMessageChunk):
                ui.text_delta(message_chunk.content)
                response += message_chunk.content

        elif mode == 'updates':
            # chunk is a dict, containing updates per node
            if "agent" in chunk:
                agent_msg = chunk['agent']['messages'][0]
                if getattr(agent_msg, "tool_calls", None):
                    for tool_call in agent_msg.tool_calls:
                        ui.tool_call(tool_call.get('name', 'tool'), tool_call.get('args'))
            elif "tools" in chunk:
                tool_msg = chunk['tools']['messages'][0]
                ui.tool_result(getattr(tool_msg, 'name', 'tool'), getattr(tool_msg, 'content', ''))
    ui.text_done(response)
    return {"response": response}


async def query_gen(state: OrthodoxV1_State, config: RunnableConfig, writer: StreamWriter) -> OrthodoxV1_State:
    analysis_str = state['analysis_str']
    reflection = state["reflection_str"]
    ui = AGUIEmitter(writer, state["message_id"])
    
    if reflection:
        payload = {
            "analysis_results": analysis_str,
            "reflection": reflection
        }
        response = await query_reflective_agent.ainvoke(payload, config)
    else:
        payload = {
            "analysis_results": analysis_str
        }
        response = await query_no_reflective_agent.ainvoke(payload, config)
    
    # Emit a reasoning header via the writer
    lines = ["I will perform a research in the database for the following fields:"]
    for idx, q in enumerate(response.queries, start=1):
        lines.append(f"{idx}. {q}")
    header_content = "\n".join(lines)
    
    ui.thought(header_content)
    return {"vector_queries": response.queries}


async def retrieval(state: OrthodoxV1_State, writer: StreamWriter):
    retrieved_docs = []
    ui = AGUIEmitter(writer, state["message_id"])

    async def fetch_single(query: str):
        nonlocal retrieved_docs
        async with httpx.AsyncClient() as client:
            r = await client.post(ENDPOINT, json={"query": query, "k": 10}, timeout=30)
            r.raise_for_status()
            retrieved_docs.extend(r.json()["documents"])

    ui.tool_call("vector_db.search", {"queries": state["vector_queries"], "k": 10})
    await asyncio.gather(*(fetch_single(q) for q in state["vector_queries"]))
    ui.tool_result("vector_db.search", f"documents={len(retrieved_docs)}")
    return {"retrieved_content": json.dumps(retrieved_docs, ensure_ascii=False, indent=2)}


async def summarization(state: OrthodoxV1_State, config: RunnableConfig, writer: StreamWriter) -> OrthodoxV1_State:
    retrieved_docs = state['retrieved_content']
    analysis_str = state['analysis_str']
    ui = AGUIEmitter(writer, state["message_id"])
    
    payload = {
        "retrieved_docs": retrieved_docs,
        "analysis_results": analysis_str,
    }
    
    summarization = await summarizer_agent.ainvoke(payload, config)
    ui.thought(summarization.content)
    return {"summarization": summarization}


async def complex_generation(state: OrthodoxV1_State, config: RunnableConfig, writer: StreamWriter) -> OrthodoxV1_State:
    payload = {
        "summarization": state["summarization"],
        "analysis_results": state["analysis_str"],
    }
    prompt = religious_gen_template.invoke(payload)
    
    # invoke the generation agent
    response = ''
    ui = AGUIEmitter(writer, state["message_id"])
    async for update in complex_gen_agent.astream(prompt, stream_mode=["updates"]):
        tag, payload = update
        
        if "agent" in payload:
            message = payload['agent']['messages'][0]
            
            if getattr(message, "tool_calls", None):
                for tool in message.tool_calls:
                    ui.tool_call(tool.get('name', 'tool'), tool.get('args'))
            elif getattr(message, "content", None):
                response = message.content
                ui.text_delta(response)
        elif "tools" in payload:
            tool_msg = update['tools']['messages'][0]
            ui.tool_result(getattr(tool_msg, 'name', 'tool'), getattr(tool_msg, 'content', ''))
    
    ui.text_done(response)
    return {"response": response}


async def reflection(state: OrthodoxV1_State, config: RunnableConfig, writer: StreamWriter) -> OrthodoxV1_State:
    analysis_str = state["analysis_str"]
    gen_resp = state["response"]
    
    payload = {
        "analysis_results": analysis_str,
        "generated_response": gen_resp,
    }
    
    reflection = await reflection_agent.ainvoke(payload, config)
    reflection_str = (
        f"Additional retrieval needed: **{'Yes' if reflection.requires_additional_retrieval else 'No'}**.  \n"
        f"Reflection: {reflection.reflection}.  \n"
        f"Recommended next steps: {reflection.recommended_next_steps}"
        if reflection.requires_additional_retrieval
        else "No additional retrieval is required."
    )
    ui = AGUIEmitter(writer, state["message_id"])
    ui.thought(reflection_str)
    return {
        "reflection": reflection,
        "reflection_str": reflection_str,
        "cycle_numbers": state.cycle_numbers + (1 if reflection.requires_additional_retrieval else 0),
    }


def check_reflection(state: OrthodoxV1_State, writer: StreamWriter) -> Literal["query_gen", "end"]:
    if state['reflection'].requires_additional_retrieval and state['cycle_numbers'] < 2:
        return 'query_gen'
    else:
        ui = AGUIEmitter(writer, state["message_id"])
        ui.text_done(state['response'])
        return 'end'


