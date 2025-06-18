import os

import json
import asyncio
import httpx

from retail_agents.states import RetailV1_State
from typing import Literal
from retail_agents.agents.retail_agent_v1 import (
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

from retail_agents.prompts.templates.retail_agent_v1 import (
    non_hr_gen_template,
    hr_gen_template
)

async def analysis(state: RetailV1_State, config: RunnableConfig, writer: StreamWriter) -> RetailV1_State:
    """Parse the user question and classify it.

    This node is IO-bound (LLM call) so we expose it as async and call the
    asynchronous `.ainvoke` method provided by the LangChain agent wrappers.
    """
    user_msg = state['user_input']
    analysis_results = await analysis_agent.ainvoke(user_msg, config)
    
    analysis_str = (
    f"***Classification***: This question is **{analysis_results.query_domain}**.  \n"
    f"***Topic(s)***: {', '.join(analysis_results.key_topics)}.  \n"
    f"***Context requirements***: {analysis_results.context_requirements}.  \n"
    f"***Overall complexity***: {analysis_results.query_complexity}.  \n"
    f"***Reasoning***: {analysis_results.reasoning}"
)
    writer({
        "type": "reasoning",
        "content": analysis_str,
        "node": "analysis"
    })
    return {'analysis_results': analysis_results, 'analysis_str': analysis_str}


def check_if_hr(state: RetailV1_State) -> Literal["query_gen", "simple_generation"]:
    """Fast synchronous branching helper (no IO)."""
    return "query_gen" if state["analysis_results"].query_domain == "HR-Policy" else "simple_generation"


async def simple_generation(state: RetailV1_State, config: RunnableConfig, writer: StreamWriter) -> RetailV1_State:
    payload = {"analysis_results": state["analysis_str"]}
    prompt = non_hr_gen_template.invoke(payload)
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
                            "type": "reasoning",
                            "content": f"Using the {tool_call['name']} tool",
                            "node": "simple_gen"
                        })
            elif "tools" in chunk:
                tool_msg = chunk['tools']['messages'][0]
                writer({
                    "type": "reasoning",
                    "content": f"The tool call responded the following: {tool_msg.content}",
                    "node": "simple_gen"
                })
    return {"response": response}


async def query_gen(state: RetailV1_State, config: RunnableConfig, writer: StreamWriter) -> RetailV1_State:
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
    lines = ["I perform research in the database for the following fields:"]
    for idx, q in enumerate(response.queries, start=1):
        lines.append(f"{idx}. {q}")
    header_content = "\n".join(lines)
    
    writer({
        "type": "reasoning",
        "content": header_content,
        "node": "query_gen"
    })
    return {"vector_queries": response.queries}


async def retrieval(state: RetailV1_State, writer):
    RAG_HOST = os.getenv("RAG_HOST", "rag_service")
    RAG_PORT = os.getenv("RAG_PORT", "8001")
    
    COLLECTION_NAME = "hr_policies"
    ENDPOINT = f"http://{RAG_HOST}:{RAG_PORT}/retrieve/{COLLECTION_NAME}"
    
    retrieved_docs = []
    
    async def fetch_single(query: str):
        nonlocal retrieved_docs
        async with httpx.AsyncClient() as client:
            r = await client.post(ENDPOINT, json={"query": query, "k": 10}, timeout=30)
            r.raise_for_status()
            retrieved_docs.extend(r.json()["documents"])
    
    await asyncio.gather(*(fetch_single(q) for q in state["vector_queries"]))
    
    writer({
        "type": "reasoning",
        "content": "Retrieved content done",
        "node": "retrieval"
    })
    return {"retrieved_content": json.dumps(retrieved_docs, ensure_ascii=False, indent=2)}


async def summarization(state: RetailV1_State, config: RunnableConfig, writer: StreamWriter) -> RetailV1_State:
    retrieved_docs = state['retrieved_content']
    analysis_str = state['analysis_str']
    
    payload = {
        "retrieved_docs": retrieved_docs,
        "analysis_results": analysis_str,
    }
    
    summarization = await summarizer_agent.ainvoke(payload, config)
    writer({
        "type": "reasoning",
        "content": summarization.content,
        "node": "summarization"
    })
    return {"summarization": summarization}


async def complex_generation(state: RetailV1_State, config: RunnableConfig, writer: StreamWriter) -> RetailV1_State:
    payload = {
        "summarization": state["summarization"],
        "analysis_results": state["analysis_str"],
    }
    prompt = hr_gen_template.invoke(payload)
    
    # invoke the generation agent
    response = ''
    async for update in complex_gen_agent.astream(prompt, stream_mode=["updates"]):
        tag, payload = update
        
        if "agent" in payload:
            message = payload['agent']['messages'][0]
            
            if getattr(message, "tool_calls", None):
                for tool in message.tool_calls:
                    content = "Executing tool: " + tool['name']
                    writer({
                        "type": "reasoning",
                        "content": content,
                        "node": "complex_gen"
                    })
            elif getattr(message, "content", None):
                response = message.content
                writer({
                    "type": "reasoning",
                    "content": response,
                    "node": "complex_gen"
                })
        elif "tools" in payload:
            tool_msg = update['tools']['messages'][0]
            writer({
                "type": "reasoning",
                "content": f"The tool call responded the following: {tool_msg.content}",
                "node": "complex_gen"
            })
    
    return {"response": response}


async def reflection(state: RetailV1_State, config: RunnableConfig, writer: StreamWriter) -> RetailV1_State:
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
        "type": "reasoning",
        "content": reflection_str,
        "node": "reflection"
    })
    return {
        "reflection": reflection,
        "reflection_str": reflection_str,
        "cycle_numbers": state.cycle_numbers + (1 if reflection.requires_additional_retrieval else 0),
    }


def check_reflection(state: RetailV1_State, writer: StreamWriter) -> Literal["query_gen", "end"]:
    if state['reflection'].requires_additional_retrieval and state['cycle_numbers'] < 2:
        return 'query_gen'
    else:
        writer({
            'type': 'response',
            'content': state['response']
        })
        return 'end'


