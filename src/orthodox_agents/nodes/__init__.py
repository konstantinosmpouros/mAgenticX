from pathlib import Path
import os
import sys

PACKAGE_ROOT = Path(os.path.abspath(os.path.dirname(__file__))).parent
sys.path.append(str(PACKAGE_ROOT))

import json
import asyncio
import httpx

from states import Orthodox_State
from typing import Literal
from agents import (
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

from prompts.templates.orthodox_templates import (
    nonreligious_gen_template,
    religious_gen_template
)

async def analysis(state: Orthodox_State, config: RunnableConfig, writer: StreamWriter) -> Orthodox_State:
    """Parse the user question and classify it.

    This node is IO-bound (LLM call) so we expose it as async and call the
    asynchronous `.ainvoke` method provided by the LangChain agent wrappers.
    """
    user_msg = state['user_input']
    analysis_results = await analysis_agent.ainvoke(user_msg, config)
    
    analysis_str = (
        f"This question is **{analysis_results.is_religious}** and focuses on **{', '.join(analysis_results.key_topics)}**.  \n"
        f"Context requirements: {analysis_results.context_requirements}.  \n"
        f"Overall complexity: **{analysis_results.query_complexity}**.  \n"
        f"Reasoning: {analysis_results.reasoning}"
    )
    writer({
        "type": "reasoning_bullet",
        "content": analysis_str
    })
    return {'analysis_results': analysis_results, 'analysis_str': analysis_str}


def check_if_religious(state: Orthodox_State) -> Literal["query_gen", "simple_generation"]:
    """Fast synchronous branching helper (no IO)."""
    return 'query_gen' if state['analysis_results'].is_religious == "Religious" else 'simple_generation'


async def simple_generation(state: Orthodox_State, config: RunnableConfig, writer: StreamWriter) -> Orthodox_State:
    payload = {"analysis_results": state["analysis_str"]}
    prompt = nonreligious_gen_template.invoke(payload)
    response = ''
    async for mode, chunk in simple_gen_agent.astream(prompt, stream_mode=["messages", "updates"]):
        if mode == 'messages':
            message_chunk, _ = chunk
            if getattr(message_chunk, "content", None) and isinstance(message_chunk, AIMessageChunk):
                writer({
                    "type": "response",
                    "content": message_chunk.content
                })
                response += message_chunk.content

        elif mode == 'updates':
            # chunk is a dict, containing updates per node
            if "agent" in chunk:
                agent_msg = chunk['agent']['messages'][0]
                if getattr(agent_msg, "tool_calls", None):
                    for tool_call in agent_msg.tool_calls:
                        writer({
                            "type": "tool_call",
                            "content": f"Using the {tool_call['name']} tool"
                        })
            elif "tools" in chunk:
                tool_msg = chunk['tools']['messages'][0]
                writer({
                    "type": "tool_response",
                    "content": f"The tool call responded the following: {tool_msg.content}"
                })
    return {"response": response}


async def query_gen(state: Orthodox_State, config: RunnableConfig, writer: StreamWriter) -> Orthodox_State:
    analysis_str = state['analysis_str']
    reflection = state["reflection_str"]
    
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
        lines.append(f"- {q}")
    header_content = "\n".join(lines)
    
    writer({
        "type": "reasoning_bullet",
        "content": header_content
    })
    return {"vector_queries": response.queries}


async def retrieval(state: Orthodox_State, writer):
    RAG_HOST = os.getenv("RAG_HOST", "rag_service")
    RAG_PORT = os.getenv("RAG_PORT", "8001")
    ENDPOINT = f"http://{RAG_HOST}:{RAG_PORT}/retrieve"
    
    retrieved_docs = []

    async def fetch_single(query: str):
        async with httpx.AsyncClient() as client:
            r = await client.post(ENDPOINT, json={"query": query, "k": 10}, timeout=30)
            r.raise_for_status()
            for doc in r.json()["documents"]:
                retrieved_docs.append({
                    "Content":  doc["text"].replace("\n", " "),
                    "Metadata": doc["metadata"],
                })

    await asyncio.gather(*(fetch_single(q) for q in state["vector_queries"]))

    writer({"type": "reasoning_rag", "content": "Retrieved content done"})
    return {"retrieved_content": json.dumps(retrieved_docs, ensure_ascii=False, indent=2)}


async def summarization(state: Orthodox_State, config: RunnableConfig, writer: StreamWriter) -> Orthodox_State:
    retrieved_docs = state['retrieved_content']
    analysis_str = state['analysis_str']
    
    payload = {
        "retrieved_docs": retrieved_docs,
        "analysis_results": analysis_str,
    }
    
    summarization = ''
    async for token in summarizer_agent.astream(payload, config):
        writer({
            "type": "reasoning_chunk",
            "content": token.content
        })
        summarization += token.content
    return {"summarization": summarization}


async def complex_generation(state: Orthodox_State, config: RunnableConfig, writer: StreamWriter) -> Orthodox_State:
    payload = {
        "summarization": state["summarization"],
        "analysis_results": state["analysis_str"],
    }
    prompt = religious_gen_template.invoke(payload)
    
    # invoke the generation agent
    response = ''
    async for mode, chunk in complex_gen_agent.astream(prompt, stream_mode=["messages", "updates"]):
        if mode == 'messages':
            message_chunk, _ = chunk
            if getattr(message_chunk, "content", None) and isinstance(message_chunk, AIMessageChunk):
                writer({
                    "type": "response",
                    "content": message_chunk.content
                })
                response += message_chunk.content

        elif mode == 'updates':
            # chunk is a dict, containing updates per node
            if "agent" in chunk:
                agent_msg = chunk['agent']['messages'][0]
                if getattr(agent_msg, "tool_calls", None):
                    for tool_call in agent_msg.tool_calls:
                        writer({
                            "type": "tool_call",
                            "content": f"Using the {tool_call['name']} tool"
                        })
            elif "tools" in chunk:
                tool_msg = chunk['tools']['messages'][0]
                writer({
                    "type": "tool_response",
                    "content": f"The tool call responded the following: {tool_msg.content}"
                })
    return {"response": response}


async def reflection(state: Orthodox_State, config: RunnableConfig, writer: StreamWriter) -> Orthodox_State:
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
    writer({
        "type": "reasoning_bullet",
        "content": reflection_str
    })
    return {"reflection": reflection, 'reflection_str': reflection_str}


def check_reflection(state: Orthodox_State, writer: StreamWriter) -> Literal["query_gen", "end"]:
    if state['reflection'].requires_additional_retrieval:
        return 'query_gen'
    else:
        writer({
            'type': 'response',
            'content': state['response']
        })


