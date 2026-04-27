# Path setup
from pathlib import Path
import os
import sys

PACKAGE_ROOT = Path(os.path.abspath(os.path.dirname(__file__)))
sys.path.append(str(PACKAGE_ROOT))


import asyncio
import io
from typing import List

from fastapi import Depends, FastAPI, UploadFile, File, HTTPException, status
from contextlib import asynccontextmanager
from fastapi.responses import StreamingResponse

from openai import OpenAI

from core.configs import configs
from langchain_mcp_adapters.tools import load_mcp_tools

from observability import (
    RequestLoggingMiddleware,
    configure_logging,
    get_logger,
    get_context,
    register_exception_handlers,
    set_context,
    shutdown_logging,
)
from schemas import (
    Request,
    TitleRequest,
    ConversationTitle,
    SuggestionsRequest,
    ConversationSuggestions,
    TranscriptionResponse,
    AgentManifest,
    ToolManifest,
)
from utils import (
    generate_title,
    generate_suggestions,
    list_mcp_tools,
    MCPToolsClientError,
    get_cached_tool_manifests,
    mcp_session_context,
)
from utils.agents import AGENT_REGISTRY
from core.proxy import require_internal_caller


configure_logging()
logger = get_logger(__name__)
_OPENAI_CLIENT = OpenAI(api_key=configs.api_keys.openai) if configs.api_keys.openai else OpenAI()


def _make_loop_exception_handler(old_handler=None):
    def handler(loop, context):
        ex = context.get("exception")
        # Silently ignore common disconnect/cancel noise
        if isinstance(ex, (asyncio.CancelledError, BrokenPipeError, ConnectionResetError)):
            return
        # Suppress LangGraph uvloop callback noise on cancellation
        handle = context.get("handle") or context.get("task")
        msg = context.get("message", "")
        text = f"{msg} {handle!r}"
        if isinstance(ex, TypeError) and "NoneType" in str(ex) and "langgraph" in text:
            return
        logger.error(
            "event_loop_exception",
            "Unhandled event loop exception",
            exc_info=bool(ex),
            exception_type=type(ex).__name__ if ex is not None else None,
            loop_message=msg or None,
        )
        if old_handler is not None:
            try:
                old_handler(loop, context)
                return
            except Exception:
                pass
        loop.default_exception_handler(context)
    return handler

@asynccontextmanager
async def _lifespan(app: FastAPI):
    loop = asyncio.get_event_loop()
    old = loop.get_exception_handler()
    loop.set_exception_handler(_make_loop_exception_handler(old))
    try:
        logger.info("service_startup", "Agents service startup initiated")
        yield
    finally:
        loop.set_exception_handler(old)
        logger.info("service_shutdown", "Agents service shutdown completed")
        shutdown_logging()


app = FastAPI(lifespan=_lifespan, title="Agents Service")
register_exception_handlers(app)
app.add_middleware(RequestLoggingMiddleware)


# ------------------------------------------------------------------
# Dictation Endpoint
# ------------------------------------------------------------------
@app.post("/dictate/transcribe", response_model=TranscriptionResponse, status_code=status.HTTP_200_OK, dependencies=[Depends(require_internal_caller)])
async def transcribe_audio(file: UploadFile = File(...)) -> TranscriptionResponse:
    """
    Transcribe an uploaded audio file using OpenAI's Speech-to-Text capability.
    """
    stt_model = configs.runtime_models.dictation
    logger.info("dictation_request_received", "Dictation request received")
    
    if not file.filename:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Audio file upload is required.",
        )
    
    try:
        audio_bytes = await file.read()
    except Exception as exc:
        logger.warning("dictation_read_failed", "Failed to read dictation upload", error=str(exc), failure_reason="upload_read_failed")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Failed to read the uploaded audio file.",
        ) from exc
    
    if not audio_bytes:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="The uploaded audio file is empty.",
        )

    content_type = (file.content_type or "application/octet-stream").strip().lower()
    logger.info("dictation_upload_read", "Dictation upload read successfully", content_type=content_type, upload_bytes=len(audio_bytes))
    
    audio_stream = io.BytesIO(audio_bytes)
    audio_stream.name = file.filename
    
    try:
        logger.info("dictation_provider_started", "Dictation provider request started", provider="openai", model=stt_model)
        transcription = _OPENAI_CLIENT.audio.transcriptions.create(
            model=stt_model,
            file=audio_stream,
        )
    except Exception as exc:
        logger.warning(
            "dictation_provider_failed",
            "OpenAI transcription request failed",
            provider="openai",
            model=stt_model,
            error=str(exc),
            failure_reason="provider_request_failed",
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Transcription provider request failed.",
        ) from exc
    
    text = getattr(transcription, "text", None)
    if text is None and isinstance(transcription, dict):
        text = transcription.get("text")
    
    if text is None:
        logger.error(
            "dictation_provider_invalid_payload",
            "Transcription provider response did not include text",
            provider="openai",
            model=stt_model,
            failure_reason="missing_text",
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="OpenAI transcription response did not include text.",
        )
    logger.info("dictation_transcribed", "Dictation transcribed successfully", provider="openai", model=stt_model, transcript_length=len(text))
    return TranscriptionResponse(text=text)



# ------------------------------------------------------------------
# Available Agent Endpoint
# ------------------------------------------------------------------
@app.get("/agents", response_model=List[AgentManifest], status_code=status.HTTP_200_OK, dependencies=[Depends(require_internal_caller)])
async def get_available_agents() -> List[AgentManifest]:
    """Return the discovered LangGraph agent manifests for downstream services."""
    manifests = [definition.manifest for definition in AGENT_REGISTRY.values()]
    manifests.sort(key=lambda item: item.get("name", ""))
    logger.info("agents_manifest_listed", "Served available agents", count=len(manifests))
    return [AgentManifest.model_validate(item) for item in manifests]



# ------------------------------------------------------------------
# Available Tool Endpoint
# ------------------------------------------------------------------
@app.get("/tools", response_model=List[ToolManifest], status_code=status.HTTP_200_OK, dependencies=[Depends(require_internal_caller)])
async def get_available_tools() -> List[ToolManifest]:
    """Return the live tool catalog exposed by the MCP server."""
    cached_manifests = get_cached_tool_manifests()
    if cached_manifests:
        logger.info("tools_cache_hit", "Served tools from cache", count=len(cached_manifests))
        return cached_manifests

    try:
        await list_mcp_tools()
    except MCPToolsClientError as exc:
        logger.warning("tools_refresh_failed", "Failed to refresh MCP tool manifests", error=str(exc), failure_reason="gateway_unavailable")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Tool catalog is temporarily unavailable.",
        ) from exc
    
    # list_mcp_tools primes the cache; return whatever was stored.
    manifests = get_cached_tool_manifests()
    logger.info("tools_cache_filled", "Refreshed tool catalog", count=len(manifests))
    return manifests



# ------------------------------------------------------------------
# Title Generation Endpoint
# ------------------------------------------------------------------
@app.post("/titles/generate", response_model=ConversationTitle, status_code=status.HTTP_200_OK, dependencies=[Depends(require_internal_caller)])
async def generate_conversation_title(req: TitleRequest) -> ConversationTitle:
    """Generate a short, descriptive title for a new conversation."""
    logger.info("title_request_received", "Conversation title request received", prompt_messages=len(req.user_input))
    return await generate_title(req)


# ------------------------------------------------------------------
# Suggestion Generation Endpoint
# ------------------------------------------------------------------
@app.post("/suggestions/generate", response_model=ConversationSuggestions, status_code=status.HTTP_200_OK, dependencies=[Depends(require_internal_caller)])
async def generate_conversation_suggestions(req: SuggestionsRequest) -> ConversationSuggestions:
    """Generate personalized starter suggestions for a new conversation."""
    logger.info("suggestion_request_received", "Conversation suggestion request received", prompt_messages=len(req.user_input))
    return await generate_suggestions(req)



# ------------------------------------------------------------------
# Agent Interaction Endpoint
# ------------------------------------------------------------------
@app.post("/agents/{agent_slug}/stream", status_code=status.HTTP_200_OK, dependencies=[Depends(require_internal_caller)])
async def stream_agent(agent_slug: str, req: Request):
    """Stream responses from the requested agent template."""
    context_data = req.config.get("context", {}) if isinstance(req.config, dict) else {}
    run_config = req.config.get("run_config", {}) if isinstance(req.config, dict) else {}
    configurable = run_config.get("configurable", {}) if isinstance(run_config, dict) else {}
    agent_logger = logger.bind(agent_slug=agent_slug)
    set_context(
        agent_slug=agent_slug,
        user_id=context_data.get("user_id"),
        conversation_id=context_data.get("conversation_id"),
        thread_id=configurable.get("thread_id"),
    )
    agent_logger.info(
        "agent_stream_request_received",
        "Agent stream request received",
        input_messages=len(req.messages),
        configured_tools=len(req.config.get("tools", []) if isinstance(req.config, dict) else []),
    )
    try:
        # Check if the agent is disabled
        definition = AGENT_REGISTRY.get(agent_slug, None)
        if definition is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Unknown agent '{agent_slug}'.",
            )
        # Initialise the agent
        agent_logger.info("agent_initialization_started", "Agent initialization started")
        agent = definition.cls(config=req.config)
    except HTTPException:
        raise
    except Exception as exc:
        agent_logger.warning("agent_initialization_failed", "Failed to initialise the requested agent", error=str(exc), failure_reason="agent_init_failed")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Failed to initialise the requested agent.",
        ) from exc
    agent_logger.info("agent_initialization_completed", "Agent initialization completed", agent_type=type(agent).__name__)
    request_context = get_context()
    
    # Stream agent responses
    async def event_stream():
        try:
            agent_logger.info("agent_stream_started", "Agent stream execution started", context=request_context)
            async with mcp_session_context() as session:
                agent_logger.info("mcp_session_connected", "MCP session connected for agent stream", context=request_context)
                live_tools = await load_mcp_tools(session)
                agent_logger.info("mcp_tools_loaded", "Loaded live MCP tools for agent stream", context=request_context, live_tool_count=len(live_tools))
                agent.attach_tools(live_tools)
                agent_logger.info("agent_tools_attached", "Agent tools attached for stream", context=request_context, attached_tool_count=len(getattr(agent, "tools_names", [])))
                async for chunk in agent.astream(payload={"messages": req.messages}):
                    yield chunk
            agent_logger.info("agent_stream_completed", "Agent stream execution completed", context=request_context)
        except asyncio.CancelledError:
            agent_logger.info("agent_stream_cancelled", "Agent stream execution cancelled", context=request_context)
            return
        except Exception as exc:
            agent_logger.error("agent_stream_failed", "Agent stream execution failed", context=request_context, error=str(exc))
            yield agent._encode_run_error(exc)
    
    return StreamingResponse(event_stream(), media_type="text/event-stream")
