import json
from dataclasses import dataclass
from typing import Any, Literal
from uuid import uuid4

import httpx
from pydantic import BaseModel

from core.settings import settings
from core.tls import get_httpx_client_cert, get_httpx_verify
from observability import get_context
from core.proxy import internal_service_headers
from langgraph_agents.retail_agent_v1.agents import RetailAgents
from langgraph_agents.retail_agent_v1.prompt_templates import (
    schema_help_template,
    answer_gen_template,
)
from runtime.agui import AGUIEmitter
from langchain_core.messages.ai import AIMessageChunk
from langchain_core.runnables import RunnableConfig
from langgraph.config import get_stream_writer

TABLE = settings.workflows.retail.table_name
SCHEMA_ENDPOINT = settings.rag.excel_schema_url(TABLE)
QUERY_ENDPOINT = settings.rag.excel_query_url(TABLE)
SCHEMA_TIMEOUT_SECONDS = settings.workflows.retail.schema_timeout_seconds
QUERY_CONNECT_TIMEOUT_SECONDS = settings.workflows.retail.query_connect_timeout_seconds
QUERY_TIMEOUT_SECONDS = settings.workflows.retail.query_timeout_seconds

class RetailV1_State(BaseModel):
    """Data model representing the state of a retail agent process in version 1."""
    
    message_id: str | None = None
    messages: Any
    db_schema_json: Any = None
    table_name: str = TABLE
    
    analysis_results: Any = None
    analysis_str: str | None = None
    
    error_message: str | None = None
    sql_query: str | None = None
    sql_results: Any = None
    
    response: str | None = None
    
    sql_cycle: int = 0
    
    def __getitem__(self, key: str) -> Any:
        return getattr(self, key)


@dataclass
class RetailNodes:
    analysis: Any
    check_intent: Any
    simple_generation: Any
    query_gen: Any
    query_execution: Any
    complex_generation: Any
    check_sql_results: Any


def build_retail_nodes(*, agents: RetailAgents, agui: AGUIEmitter) -> RetailNodes:
    """Create runtime-bound node callables that close over agents and AG-UI."""


    async def analysis(state: RetailV1_State, config: RunnableConfig):
        writer = get_stream_writer()
        message_id = state["message_id"] or str(uuid4())
        agui.thinking_start(writer)
        agui.thought("Analyzing user input to determine intent and reasoning…", writer)

        user_msg = state["messages"]
        analysis_results = await agents.analysis_agent.ainvoke(user_msg, config)

        analysis_str = (
            f"***Intent: {analysis_results.intent}.  \n"
            f"Reasoning: {analysis_results.reasoning}.  \n"
            f"User Language: {analysis_results.user_language if analysis_results.user_language else 'English'}.  \n"
            f"SQL Description: {analysis_results.sql_description if analysis_results.sql_description else 'N/A'}***"
        )

        tcid = str(uuid4())
        agui.tool_call_start(
            tcid,
            name="schema_backend.fetch",
            writer=writer,
        )
        try:
            request_id = get_context().get("request_id")
            headers = internal_service_headers(request_id)
            async with httpx.AsyncClient(timeout=SCHEMA_TIMEOUT_SECONDS, verify=get_httpx_verify(), cert=get_httpx_client_cert()) as client:
                response = await client.get(SCHEMA_ENDPOINT, headers=headers)
                response.raise_for_status()
                db_schema_json = response.json()
                agui.tool_call_result(tcid, "Retrieved database schema.", writer)
        except Exception:
            agui.tool_call_result(tcid, "Failed to retrieve db schema.", writer)
            raise
        finally:
            agui.tool_call_end(tcid, writer)

        return {
            "analysis_results": analysis_results,
            "analysis_str": analysis_str,
            "db_schema_json": db_schema_json,
            "message_id": message_id,
        }


    async def check_intent(state: RetailV1_State, config: RunnableConfig) -> Literal["query_gen", "simple_generation"]:
        """Decide whether to generate SQL or reply directly."""
        return "query_gen" if state["analysis_results"].intent == "data" else "simple_generation"


    async def simple_generation(state: RetailV1_State, config: RunnableConfig):
        writer = get_stream_writer()
        payload = {
            "analysis_str": state["analysis_str"],
            "db_schema_json": state["db_schema_json"],
            "user_input_json": json.dumps(state["messages"], ensure_ascii=False),
        }
        prompt = await schema_help_template.ainvoke(payload)
        response = ""
        last_tool_call_id: str | None = None

        agui.thinking_end(writer)
        agui.response_start(state["message_id"], writer)

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


    async def query_gen(state: RetailV1_State, config: RunnableConfig):
        writer = get_stream_writer()
        agui.thought("Generating SQL query based on analysis results…", writer)

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
            sql_output = await agents.sql_error_gen_agent.ainvoke(payload, config)
        else:
            payload = {
                "table_name": table_name,
                "db_schema_json": db_schema_json,
                "analysis_str": analysis_str,
            }
            sql_output = await agents.sql_gen_agent.ainvoke(payload, config)

        return {"sql_query": sql_output.sql_query, "sql_cycle": state["sql_cycle"] + 1}


    async def query_execution(state: RetailV1_State):
        writer = get_stream_writer()
        agui.thought("Executing SQL query…", writer)

        sql_query = state["sql_query"]

        tcid = str(uuid4())
        agui.tool_call_start(
            tcid,
            name="sql_backend.query",
            writer=writer,
        )

        try:
            request_id = get_context().get("request_id")
            headers = internal_service_headers(request_id)
            async with httpx.AsyncClient(timeout=QUERY_CONNECT_TIMEOUT_SECONDS, verify=get_httpx_verify(), cert=get_httpx_client_cert()) as client:
                response = await client.post(
                    QUERY_ENDPOINT,
                    json={"sql": sql_query},
                    headers=headers,
                    timeout=QUERY_TIMEOUT_SECONDS,
                )
                response.raise_for_status()
                payload = response.json()
        except httpx.HTTPStatusError as exc:
            try:
                detail = exc.response.json().get("detail")
            except Exception:
                detail = exc.response.text or str(exc)
            return {
                "sql_results": None,
                "error_message": f"HTTP {exc.response.status_code}: {detail}",
            }
        except httpx.RequestError as exc:
            return {
                "sql_results": None,
                "error_message": f"Request failed: {exc}",
            }
        except Exception as exc:
            return {
                "sql_results": None,
                "error_message": str(exc),
            }
        finally:
            agui.tool_call_end(tcid, writer)

        return {
            "sql_results": payload,
            "error_message": None,
        }


    async def check_sql_results(state: RetailV1_State) -> Literal["complex_generation", "query_gen"]:
        writer = get_stream_writer()
        if state["error_message"] is not None and state["sql_cycle"] < 2:
            agui.thought("❌ Error executing SQL query. Will retry with error-aware generator…", writer)
            return "query_gen"
        agui.thought("✅ SQL executed successfully. Moving to final answer generation…", writer)
        return "complex_generation"


    async def complex_generation(state: RetailV1_State, config: RunnableConfig):
        writer = get_stream_writer()
        agui.thinking_end(writer)
        agui.response_start(state["message_id"], writer)

        payload = {
            "analysis_str": state["analysis_str"],
            "user_input_json": json.dumps(state["messages"], ensure_ascii=False),
            "sql_results": state["sql_results"],
        }
        prompt = await answer_gen_template.ainvoke(payload)

        response = ""
        last_tool_call_id: str | None = None
        async for mode, chunk in agents.answer_agent.astream(prompt, stream_mode=["messages", "updates"]):
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


    return RetailNodes(
        analysis=analysis,
        check_intent=check_intent,
        simple_generation=simple_generation,
        query_gen=query_gen,
        query_execution=query_execution,
        complex_generation=complex_generation,
        check_sql_results=check_sql_results,
    )
