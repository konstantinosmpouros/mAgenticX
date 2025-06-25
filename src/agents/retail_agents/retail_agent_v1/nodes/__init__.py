import json
import httpx

from retail_agents.retail_agent_v1.states import RetailV1_State
from typing import Literal
from retail_agents.retail_agent_v1.config import SCHEMA_ENDPOINT, QUERY_ENDPOINT
from retail_agents.retail_agent_v1.agents import (
    analysis_agent,
    simple_gen_agent,
    sql_gen_agent,
    sql_error_gen_agent,
    answer_agent,
)

from retail_agents.retail_agent_v1.prompts.templates import (
    schema_help_template,
    answer_gen_template
)

from langchain_core.runnables import RunnableConfig
from langgraph.types import StreamWriter
from langchain_core.messages.ai import AIMessageChunk


async def analysis(state: RetailV1_State, config: RunnableConfig, writer: StreamWriter) -> RetailV1_State:
    writer({
        "type": "reasoning",
        "content": "🧠 Analyzing user input to determine intent and reasoning...",
        "node": "analysis"
    })
    
    user_msg = state['user_input']
    analysis_results = await analysis_agent.ainvoke(user_msg, config)
    
    analysis_str = (
        f"***Intent: {analysis_results.intent}.  \n"
        f"Reasoning: {analysis_results.reasoning}.  \n"
        f"User Language: {analysis_results.user_language if analysis_results.user_language else 'English'}.  \n"
        f"SQL Description: {analysis_results.sql_description if analysis_results.sql_description else 'N/A'}***"
    )
    
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.get(SCHEMA_ENDPOINT)
        r.raise_for_status()
        db_schema_json = r.json()
    
    return {
        'analysis_results': analysis_results,
        'analysis_str': analysis_str,
        'db_schema_json': db_schema_json,
        "user_input_json": json.dumps(user_msg),
    }   



async def check_intent(state: RetailV1_State, config: RunnableConfig) -> Literal["query_gen", "simple_generation"]:
    return "query_gen" if state["analysis_results"].intent == "data" else "simple_generation"



async def simple_generation(state: RetailV1_State, config: RunnableConfig, writer: StreamWriter) -> RetailV1_State:
    payload = {
        "analysis_str": state["analysis_str"],
        "db_schema_json": state["db_schema_json"],
        "user_input_json": state["user_input_json"],
    }
    prompt = await schema_help_template.ainvoke(payload)
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
    writer({
        "type": "reasoning",
        "content": "📝 Generating SQL query based on analysis results...",
        "node": "sql_query_gen",
    })
    
    error_message = state["error_message"]
    table_name = state["table_name"]
    db_schema_json = state["db_schema_json"]
    analysis_str = state["analysis_str"]
    sql_query = state["sql_query"]
    
    if error_message:
        payload = {
            "table_name": table_name,
            "db_schema_json": db_schema_json,
            "analysis_str": analysis_str,
            "error_message": error_message,
            "sql_query": sql_query,
        }
        
        sql_output = await sql_error_gen_agent.ainvoke(payload, config)
    else:
        payload = {
            "table_name": table_name,
            "db_schema_json": db_schema_json,
            "analysis_str": analysis_str,
        }
        sql_output = await sql_gen_agent.ainvoke(payload, config)
    
    return {"sql_query": sql_output.sql_query, "sql_cycle": state["sql_cycle"] + 1}



async def query_execution(state: RetailV1_State, writer: StreamWriter, config: RunnableConfig) -> RetailV1_State:
    writer({
        "type": "reasoning",
        "content": "⚡ Executing SQL query...",
        "node": "sql_query_execution"
    })
    
    sql_query = state["sql_query"]
    
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(QUERY_ENDPOINT, json={"sql": sql_query}, timeout=30)
            r.raise_for_status()
            response = r.json()
    except httpx.HTTPStatusError as exc:
        # FastAPI usually wraps errors in {"detail": "..."}
        try:
            detail = exc.response.json().get("detail")
        except Exception:
            detail = exc.response.text or str(exc)

        return {
            "sql_results": None,
            "error_message": f"HTTP {exc.response.status_code}: {detail}",
        }

    except httpx.RequestError as exc:
        # Networking issues (timeout, DNS, connection refused, etc.)
        return {
            "sql_results": None,
            "error_message": f"Request failed: {exc}",
        }

    except Exception as exc:
        # Anything else
        return {
            "sql_results": None,
            "error_message": str(exc),
        }

    # Success
    return {
        "sql_results": response,
        "error_message": None,
    }



async def check_sql_results(state: RetailV1_State, writer: StreamWriter) -> Literal["complex_gen", "query_gen"]:
    if state["error_message"] is not None and state["sql_cycle"] < 2:
        writer({
            "type": "reasoning",
            "content": f"❌ Error executing SQL query",
            "node": "sql_query_execution"
        })
        return 'query_gen'
    else:
        writer({
            "type": "reasoning",
            "content": "✅ SQL query executed successfully, generating response...",
            "node": "complex_gen"
        })
        return 'complex_generation'



async def complex_generation(state: RetailV1_State, config: RunnableConfig, writer: StreamWriter) -> RetailV1_State:
    analysis_str = state["analysis_str"]
    user_input_json = state["user_input_json"]
    sql_results = state["sql_results"]
    
    payload = {
        "analysis_str": analysis_str,
        "user_input_json": user_input_json,
        "sql_results": sql_results,
    }
    
    prompt = await answer_gen_template.ainvoke(payload)
    
    # invoke the generation agent
    response = ''
    async for mode, chunk in answer_agent.astream(prompt, stream_mode=["messages", "updates"]):
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


