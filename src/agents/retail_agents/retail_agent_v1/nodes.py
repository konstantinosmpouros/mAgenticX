import httpx
from uuid import uuid4
import json
from typing import Literal, Any
from pydantic import BaseModel

from config import SCHEMA_ENDPOINT, QUERY_ENDPOINT, TABLE
from retail_agents.retail_agent_v1.agents import (
    analysis_agent,
    simple_gen_agent,
    sql_gen_agent,
    sql_error_gen_agent,
    answer_agent,
)

from retail_agents.retail_agent_v1.prompt_templates import (
    schema_help_template,
    answer_gen_template
)
from agui import agui_emitter

from langchain_core.runnables import RunnableConfig
from langgraph.types import StreamWriter
from langchain_core.messages.ai import AIMessageChunk
from langchain_core.prompts.chat import ChatPromptTemplate
from langchain_core.messages import BaseMessage



class RetailV1_State(BaseModel):
    """
    Data model representing the state of a retail agent process in version 1.
    """
    message_id: str = None
    user_input: Any
    user_input_json: str = None
    db_schema_json: str = None
    table_name: str = TABLE
    
    analysis_results: Any = None
    analysis_str: str = None
    
    error_message: str = None
    sql_query: str = None
    sql_results: Any = None
    
    response: str = None
    
    sql_cycle: int = 0
    
    def __getitem__(self, key: str) -> Any:
        return getattr(self, key)



async def analysis(state: RetailV1_State, config: RunnableConfig, writer: StreamWriter) -> RetailV1_State:
    """
    Analyze user input to extract intent, reasoning, and SQL description,
    then fetch and store the database schema.
    """
    message_id = state["message_id"] or str(uuid4())
    agui_emitter.thinking_start(writer)
    agui_emitter.thought(writer, "Analyzing user input to determine intent and reasoning…")
    
    # Invoke analysis agent
    user_msg = state['user_input']
    analysis_results = await analysis_agent.ainvoke(user_msg, config)
    
    # Build a human-readable analysis summary
    analysis_str = (
        f"***Intent: {analysis_results.intent}.  \n"
        f"Reasoning: {analysis_results.reasoning}.  \n"
        f"User Language: {analysis_results.user_language if analysis_results.user_language else 'English'}.  \n"
        f"SQL Description: {analysis_results.sql_description if analysis_results.sql_description else 'N/A'}***"
    )
    
    # Retrieve database schema from remote endpoint
    tcid = str(uuid4())
    agui_emitter.tool_call_start(
        writer,
        tcid,
        message_id,
        name="schema_backend.fetch",
        args={"endpoint": SCHEMA_ENDPOINT}
    )
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.get(SCHEMA_ENDPOINT)
            r.raise_for_status()
            db_schema_json = r.json()
            agui_emitter.tool_call_result(writer, tcid, message_id, "Retrieved database schema.")
    except Exception as exc:
        agui_emitter.tool_call_result(writer, tcid, message_id, "Failed to retrieve db schema.")
        raise
    finally:
        agui_emitter.tool_call_end(writer, tcid)
    
    return {
        'analysis_results': analysis_results,
        'analysis_str': analysis_str,
        'db_schema_json': db_schema_json,
        'user_input_json': json.dumps(user_msg),
        'message_id': message_id,
    }



async def check_intent(state: RetailV1_State, config: RunnableConfig) -> Literal["query_gen", "simple_generation"]:
    """
    Decide whether to generate an SQL query or a simple text response
    based on the extracted intent.
    """
    return "query_gen" if state["analysis_results"].intent == "data" else "simple_generation"



async def simple_generation(state: RetailV1_State, config: RunnableConfig, writer: StreamWriter) -> RetailV1_State:
    """
    Produce a straightforward response without querying the database,
    streaming chunks back to the client.
    """
    payload = {
        "analysis_str": state["analysis_str"],
        "db_schema_json": state["db_schema_json"],
        "user_input_json": state["user_input_json"],
    }
    prompt = await schema_help_template.ainvoke(payload)
    response = ''
    
    agui_emitter.thinking_end(writer)
    agui_emitter.response_start(writer, state["message_id"])
    
    # Stream agent messages and tool updates
    async for mode, chunk in simple_gen_agent.astream(prompt, stream_mode=["messages", "updates"]):
        if mode == 'messages':
            message_chunk, _ = chunk
            if getattr(message_chunk, "content", None) and isinstance(message_chunk, AIMessageChunk):
                agui_emitter.response_chunk(writer, state["message_id"], message_chunk.content)
                response += message_chunk.content
            
        elif mode == 'updates':
            # Report when tools are invoked or return data
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



async def query_gen(state: RetailV1_State, config: RunnableConfig, writer: StreamWriter) -> RetailV1_State:
    """
    Generate or refine an SQL query based on analysis results and
    any previous errors.
    """
    agui_emitter.thought(writer, "Generating SQL query based on analysis results…")
    
    error_message = state["error_message"]
    table_name = state["table_name"]
    db_schema_json = state["db_schema_json"]
    analysis_str = state["analysis_str"]
    sql_query = state["sql_query"]
    
    if error_message:
        # Include error context for retry
        payload = {
            "table_name": table_name,
            "db_schema_json": db_schema_json,
            "analysis_str": analysis_str,
            "error_message": error_message,
            "sql_query": sql_query,
        }
        
        sql_output = await sql_error_gen_agent.ainvoke(payload, config)
    else:
        # No previous error, generate new SQL query
        payload = {
            "table_name": table_name,
            "db_schema_json": db_schema_json,
            "analysis_str": analysis_str,
        }
        sql_output = await sql_gen_agent.ainvoke(payload, config)
    
    return {"sql_query": sql_output.sql_query, "sql_cycle": state["sql_cycle"] + 1}



async def query_execution(state: RetailV1_State, writer: StreamWriter) -> RetailV1_State:
    """
    Execute the generated SQL query against the backend service,
    capturing results or any errors.
    """
    agui_emitter.thought(writer, "Executing SQL query…")
    
    sql_query = state["sql_query"]
    
    tcid = str(uuid4())
    agui_emitter.tool_call_start(
        writer,
        tcid,
        state["message_id"],
        name="sql_backend.query",
        args={"sql": sql_query}
    )
    
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



async def check_sql_results(state: RetailV1_State, writer: StreamWriter) -> Literal["complex_generation", "query_gen"]:
    """
    Determine next step: retry query on error (up to 2 attempts),
    otherwise proceed to generate the final response.
    """
    if state["error_message"] is not None and state["sql_cycle"] < 2:
        agui_emitter.thought(writer, "❌ Error executing SQL query. Will retry with error-aware generator…")
        return 'query_gen'
    else:
        agui_emitter.thought(writer, "✅ SQL executed successfully. Moving to final answer generation…")
        return 'complex_generation'



async def complex_generation(state: RetailV1_State, config: RunnableConfig, writer: StreamWriter) -> RetailV1_State:
    """
    Generate the final user-facing response by combining analysis summary,
    original input, and SQL results.
    """
    agui_emitter.thinking_end(writer)
    agui_emitter.response_start(writer, state["message_id"])
    
    payload = {
        "analysis_str": state["analysis_str"],
        "user_input_json": state["user_input_json"],
        "sql_results": state["sql_results"],
    }
    prompt = await answer_gen_template.ainvoke(payload)
    
    # Stream the answer agent's output
    response = ''
    async for mode, chunk in answer_agent.astream(prompt, stream_mode=["messages", "updates"]):
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

