# Path setup
from pathlib import Path
import os
import sys

PACKAGE_ROOT = Path(os.path.abspath(os.path.dirname(__file__)))
sys.path.append(str(PACKAGE_ROOT))


import asyncio
import io
import json
from typing import Any, List, Optional

import httpx
from fastapi import Depends, FastAPI, UploadFile, File, HTTPException, status
from contextlib import asynccontextmanager
from fastapi.responses import StreamingResponse

from core.clients import get_openai_client
from core.settings import settings
from langchain_mcp_adapters.tools import load_mcp_tools
from langgraph.types import Command
from runtime.checkpointer import get_checkpointer, has_checkpointer_initialized, set_checkpointer
from runtime.checkpointer.fork import seed_thread_from_checkpoint
from runtime.filesystem import delete_conversation_files, seed_input_files

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
    AgentResumeRequest,
    TitleRequest,
    ConversationTitle,
    SuggestionsRequest,
    ConversationSuggestions,
    ReadAloudRequest,
    RealtimeSessionRequest,
    RealtimeSessionResponse,
    TranscriptionResponse,
    AgentManifest,
    ToolManifest,
    SkillManifest,
    SkillManifestEntry,
    CustomSkillCreate,
    UserSkillDetail,
    SeedInputFilesRequest,
    SeedInputFilesResponse,
    ReapConversationRequest,
)
from utils import (
    release_checkpoint_unless_paused,
    disable_user_agent_skill,
    enable_user_agent_skill,
    generate_title,
    generate_suggestions,
    generate_read_aloud_audio,
    list_mcp_tools,
    list_registry_skills,
    list_user_agent_skills,
    MCPToolsClientError,
    get_cached_tool_manifests,
    mcp_session_context,
)
from utils.agents import AGENT_REGISTRY
from runtime.skill_registry import (
    SkillNameConflict,
    add_custom_to_user,
    add_global_to_user,
    get_user_skill_detail,
    list_user_skills,
    reconcile_all_user_manifests,
    rebuild_global_manifest,
    remove_from_user,
    seed_global_registry,
)
from core.proxy import require_internal_caller
from core.error_handling import provider_error_handler


configure_logging()
logger = get_logger(__name__)


def _normalize_realtime_voice(voice: str | None) -> str:
    selected = (voice or settings.runtime_models.read_aloud_voice or "alloy").strip().lower()
    return selected if selected in settings.runtime_models.realtime_voices else "alloy"


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

async def _init_durable_checkpointer(app: FastAPI) -> None:
    """Open the persistent psycopg pool and wire the shared AsyncPostgresSaver.

    Heavy deps (psycopg, langgraph-checkpoint-postgres) are imported lazily here
    so importing ``main`` (e.g. in unit tests that never run the lifespan) does
    not require them. The pool is long-lived and shared across all requests;
    each request selects its thread via ``run_config.configurable.thread_id``.
    """
    from psycopg.rows import dict_row
    from psycopg_pool import AsyncConnectionPool
    from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

    cfg = settings.checkpointer

    # The langgraph lib reads this from the environment; mirror the setting so a
    # missing compose env can't silently disable the strict allow-list.
    if cfg.strict_msgpack:
        os.environ.setdefault("LANGGRAPH_STRICT_MSGPACK", "true")

    conn_kwargs = {
        "autocommit": True,           # required: setup() + CREATE INDEX CONCURRENTLY
        "row_factory": dict_row,      # required: reads must be dict rows
        "prepare_threshold": None,    # pgbouncer-safe; no server-side prepared stmts
    }
    pool = AsyncConnectionPool(
        conninfo=cfg.url.get_secret_value(),
        min_size=cfg.pool_min_size,
        max_size=cfg.pool_max_size,
        max_idle=cfg.pool_max_idle,
        timeout=cfg.pool_timeout,
        open=False,
        kwargs=conn_kwargs,
    )
    await pool.open()
    await pool.wait()
    app.state.checkpointer_pool = pool

    serde = None
    aes_key = cfg.aes_key.get_secret_value()
    if aes_key:
        from langgraph.checkpoint.serde.encrypted import EncryptedSerializer

        os.environ.setdefault("LANGGRAPH_AES_KEY", aes_key)
        serde = EncryptedSerializer.from_pycryptodome_aes()

    if cfg.setup_on_startup:
        # Serialize concurrent multi-replica setup() (the index migrations use
        # CREATE INDEX CONCURRENTLY, which can't run in a txn block and would
        # collide). Single-replica today, so this is belt-and-suspenders.
        async with pool.connection() as conn:
            await conn.execute("SELECT pg_advisory_lock(hashtext('langgraph_setup'))")
            try:
                await AsyncPostgresSaver(conn).setup()
            finally:
                await conn.execute("SELECT pg_advisory_unlock(hashtext('langgraph_setup'))")

    checkpointer = AsyncPostgresSaver(pool) if serde is None else AsyncPostgresSaver(pool, serde=serde)
    app.state.checkpointer = checkpointer
    set_checkpointer(checkpointer)
    logger.info(
        "checkpointer_initialized",
        "Durable AsyncPostgresSaver initialized",
        encrypted=serde is not None,
        setup_ran=cfg.setup_on_startup,
        pool_max_size=cfg.pool_max_size,
    )


@asynccontextmanager
async def _lifespan(app: FastAPI):
    loop = asyncio.get_event_loop()
    old = loop.get_exception_handler()
    loop.set_exception_handler(_make_loop_exception_handler(old))
    pool = None
    try:
        logger.info("service_startup", "Agents service startup initiated")
        # Bootstrap the global skills registry volume from the image seed,
        # index it into manifest.json, then heal per-user manifests against
        # filesystem state.
        seed_global_registry()
        rebuild_global_manifest()
        reconcile_all_user_manifests()
        # Durable checkpointer — fail fast and loud if agent_runtime is
        # unreachable; cross-turn resume depends on it.
        await _init_durable_checkpointer(app)
        pool = app.state.checkpointer_pool
        yield
    finally:
        if pool is not None:
            await pool.close()
        loop.set_exception_handler(old)
        logger.info("service_shutdown", "Agents service shutdown completed")
        shutdown_logging()


app = FastAPI(lifespan=_lifespan, title="Agents Service")
register_exception_handlers(app)
app.add_middleware(RequestLoggingMiddleware)


@app.get("/health", include_in_schema=False)
async def health():
    return {"status": "ok"}


# ------------------------------------------------------------------
# Dictation Endpoint
# ------------------------------------------------------------------
@app.post("/dictate/transcribe", response_model=TranscriptionResponse, status_code=status.HTTP_200_OK, dependencies=[Depends(require_internal_caller)])
async def transcribe_audio(file: UploadFile = File(...)) -> TranscriptionResponse:
    """
    Transcribe an uploaded audio file using OpenAI's Speech-to-Text capability.
    """
    stt_model = settings.runtime_models.dictation
    logger.info("dictation_request_received", "Dictation request received")
    
    if not file.filename:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Audio file upload is required.",
        )
    
    try:
        audio_bytes = await file.read()
    except Exception as exc:
        logger.warning(
            "dictation_read_failed",
            "Failed to read dictation upload",
            exc_info=True,
            failure_reason="upload_read_failed",
        )
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
        transcription = get_openai_client().audio.transcriptions.create(
            model=stt_model,
            file=audio_stream,
        )
    except Exception as exc:
        provider_error_handler.raise_provider_error(
            logger,
            exc,
            event="dictation_provider_failed",
            message="OpenAI transcription request failed",
            public_detail="Transcription is temporarily unavailable. Please try again.",
            provider="openai",
            operation="dictation",
            model=stt_model,
        )
    
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
            detail="Transcription returned an invalid response. Please try again.",
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
        logger.warning(
            "tools_refresh_failed",
            "Failed to refresh MCP tool manifests",
            exc_info=True,
            failure_reason="gateway_unavailable",
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Tool catalog is temporarily unavailable.",
        ) from exc
    
    # list_mcp_tools primes the cache; return whatever was stored.
    manifests = get_cached_tool_manifests()
    logger.info("tools_cache_filled", "Refreshed tool catalog", count=len(manifests))
    return manifests



# ------------------------------------------------------------------
# Global Skills Registry
# ------------------------------------------------------------------
@app.get(
    "/skills/global",
    response_model=List[SkillManifest],
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(require_internal_caller)],
)
async def get_global_skills(bypass_cache: bool = False) -> List[SkillManifest]:
    """Return the global skills catalog (admin-curated).

    With ``bypass_cache=true`` the agents service rescans the global volume
    + rewrites manifest.json before responding — used by the UI's refresh
    button when an admin has dropped a new skill into the volume.

    The bridge caches the result in Redis (24 h TTL); ``bypass_cache=true``
    also bypasses the bridge cache and refreshes it.
    """
    if bypass_cache:
        rebuild_global_manifest()
    skills = list_registry_skills()
    logger.info(
        "skills_global_listed",
        "Served global skills catalog",
        count=len(skills),
        bypass_cache=bypass_cache,
    )
    return skills


# ------------------------------------------------------------------
# Per-User Skill Pool (manifest-driven)
# ------------------------------------------------------------------
# Each user has a manifest.json under $SKILLS_REGISTRY_USERS_ROOT/<user_id>/
# listing the skills in their pool. Pool entries reference either global
# skills (no folder copy needed) or owned custom skills (folder lives in
# users/<user_id>/custom/<name>/). The per-(user, agent) PUT below resolves
# its source through this manifest — users can only assign skills they have
# in their pool.
@app.get(
    "/users/{user_id}/skills",
    response_model=List[SkillManifestEntry],
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(require_internal_caller)],
)
async def get_user_skill_pool(user_id: str) -> List[SkillManifestEntry]:
    """Return the user's manifest entries (no SKILL.md content, descriptions only)."""
    try:
        entries = list_user_skills(user_id)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    logger.info(
        "user_skill_pool_listed",
        "Served user skill pool",
        user_id=user_id,
        count=len(entries),
    )
    return entries


@app.get(
    "/users/{user_id}/skills/{skill_name}",
    response_model=UserSkillDetail,
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(require_internal_caller)],
)
async def get_user_skill_detail_endpoint(user_id: str, skill_name: str) -> UserSkillDetail:
    """Return one skill from the user's pool with its SKILL.md content."""
    try:
        return get_user_skill_detail(user_id, skill_name)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


@app.post(
    "/users/{user_id}/skills/global/{skill_name}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_internal_caller)],
)
async def add_global_skill_to_user(user_id: str, skill_name: str) -> None:
    """Append a reference to a global skill into the user's pool (manifest-only)."""
    try:
        add_global_to_user(user_id, skill_name)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc


@app.post(
    "/users/{user_id}/skills/custom",
    response_model=SkillManifestEntry,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_internal_caller)],
)
async def create_user_custom_skill(user_id: str, payload: CustomSkillCreate) -> SkillManifestEntry:
    """Create a user-owned custom skill (multi-file folder + manifest entry).

    409 on a name collision (with a global OR another pool entry); 422 on a
    structural validation failure (bad path, oversized file, disallowed type,
    invalid base64, or a missing SKILL.md).
    """
    try:
        return add_custom_to_user(user_id, payload)
    except SkillNameConflict as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc


@app.delete(
    "/users/{user_id}/skills/{skill_name}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_internal_caller)],
)
async def delete_user_skill(user_id: str, skill_name: str) -> None:
    """Remove a skill from the user's pool and cascade-remove from per-agent assignments."""
    try:
        remove_from_user(user_id, skill_name)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc



# ------------------------------------------------------------------
# Per-(user, agent) skill selection
# ------------------------------------------------------------------
# The on-disk directory layout under <filesystem_root>/<user_id>/<agent_slug>/
# IS the selection state — there is no DB row mirroring it. These three
# endpoints are the only writers after a (user, agent) pair's first run; the
# DeepAgent runtime reads the same directory via its CompositeBackend
# ``/agent/skills/`` route at build time.
@app.get(
    "/agents/{agent_slug}/users/{user_id}/skills",
    response_model=List[str],
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(require_internal_caller)],
)
async def get_user_agent_skills(agent_slug: str, user_id: str) -> List[str]:
    """Return the sorted list of skill names enabled for this (user, agent)."""
    try:
        skills = list_user_agent_skills(user_id=user_id, agent_slug=agent_slug)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    logger.info(
        "user_agent_skills_listed",
        "Served per-(user, agent) enabled skills",
        user_id=user_id,
        agent_slug=agent_slug,
        count=len(skills),
    )
    return skills


@app.put(
    "/agents/{agent_slug}/users/{user_id}/skills/{skill_name}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_internal_caller)],
)
async def enable_skill_for_user_agent(agent_slug: str, user_id: str, skill_name: str) -> None:
    """Enable ``skill_name`` for this (user, agent) by copying it from the registry."""
    try:
        enable_user_agent_skill(user_id=user_id, agent_slug=agent_slug, skill_name=skill_name)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


@app.delete(
    "/agents/{agent_slug}/users/{user_id}/skills/{skill_name}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_internal_caller)],
)
async def disable_skill_for_user_agent(agent_slug: str, user_id: str, skill_name: str) -> None:
    """Disable ``skill_name`` for this (user, agent) by removing its directory."""
    try:
        disable_user_agent_skill(user_id=user_id, agent_slug=agent_slug, skill_name=skill_name)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc



# ------------------------------------------------------------------
# Per-conversation input files (user uploads) + cleanup
# ------------------------------------------------------------------
@app.put(
    "/agents/{agent_slug}/users/{user_id}/conversations/{conversation_id}/input-files",
    response_model=SeedInputFilesResponse,
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(require_internal_caller)],
)
async def seed_conversation_input_files(
    agent_slug: str, user_id: str, conversation_id: str, payload: SeedInputFilesRequest
) -> SeedInputFilesResponse:
    """Persist user-uploaded files into the conversation's read-only ``input/``.

    Called by the bridge before a deep-agent run when the new user turn carries
    attachments. Idempotent (overwrite by filename); 422 on a bad/oversized file.
    """
    try:
        written = seed_input_files(
            user_id=user_id,
            agent_slug=agent_slug,
            conversation_id=conversation_id,
            files=payload.files,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc
    return SeedInputFilesResponse(written=written)


@app.post(
    "/agents/{agent_slug}/users/{user_id}/conversations/{conversation_id}/reap",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_internal_caller)],
)
async def reap_conversation(
    agent_slug: str, user_id: str, conversation_id: str, payload: ReapConversationRequest
) -> None:
    """Reap a conversation on delete: drop its durable checkpoint threads and
    its per-(user, agent) filesystem dir (input/output/artifacts). Called
    best-effort by the bridge, which owns the thread-id metadata. Idempotent —
    unknown threads / missing dirs are no-ops."""
    checkpointer = get_checkpointer()
    for thread_id in payload.thread_ids:
        if not thread_id:
            continue
        try:
            await checkpointer.adelete_thread(thread_id)
        except Exception:
            logger.warning(
                "checkpoint_thread_reap_failed",
                "Failed to delete a checkpoint thread during conversation reap",
                exc_info=True,
                thread_id=thread_id,
            )
    try:
        delete_conversation_files(user_id=user_id, agent_slug=agent_slug, conversation_id=conversation_id)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc



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
# Read-Aloud Speech Generation Endpoint
# ------------------------------------------------------------------
@app.post("/speech/read-aloud", status_code=status.HTTP_200_OK, dependencies=[Depends(require_internal_caller)])
async def generate_read_aloud_speech(req: ReadAloudRequest):
    """Generate spoken audio for an AI response."""
    audio = await generate_read_aloud_audio(req)
    audio_format = settings.runtime_models.read_aloud_format
    media_type = "audio/mpeg" if audio_format == "mp3" else f"audio/{audio_format}"
    return StreamingResponse(
        io.BytesIO(audio),
        media_type=media_type,
        headers={
            "Content-Disposition": f'inline; filename="read-aloud.{audio_format}"',
        },
    )


# ------------------------------------------------------------------
# Realtime Voice Session Endpoint
# ------------------------------------------------------------------
@app.post("/realtime/session", response_model=RealtimeSessionResponse, status_code=status.HTTP_200_OK, dependencies=[Depends(require_internal_caller)])
async def create_realtime_session(req: RealtimeSessionRequest) -> RealtimeSessionResponse:
    """Create an OpenAI Realtime WebRTC session from an SDP offer."""
    api_key = settings.api_keys.openai.get_secret_value() if settings.api_keys.openai else None
    if not api_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Realtime voice is not configured.",
        )

    model = (req.model or settings.runtime_models.realtime).strip()
    voice = _normalize_realtime_voice(req.voice)
    session_config = {
        "type": "realtime",
        "model": model,
        "instructions": req.instructions,
        "audio": {
            "input": {
                "turn_detection": {"type": "server_vad"},
                "transcription": {"model": settings.runtime_models.dictation},
            },
            "output": {"voice": voice},
        },
    }
    multipart_fields = {
        "sdp": (None, req.sdp),
        "session": (None, json.dumps(session_config)),
    }
    try:
        async with httpx.AsyncClient(timeout=settings.realtime.timeout) as client:
            response = await client.post(
                settings.realtime.api_url,
                headers={"Authorization": f"Bearer {api_key}"},
                files=multipart_fields,
            )
            response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        max_chars = settings.realtime.error_body_max_chars
        upstream_body = exc.response.text[:max_chars]
        try:
            upstream_body = json.dumps(exc.response.json(), separators=(",", ":"))[:max_chars]
        except ValueError:
            pass
        provider_error_handler.raise_provider_error(
            logger,
            exc,
            event="realtime_session_provider_http_error",
            message="OpenAI Realtime session request failed",
            public_detail="Realtime voice is temporarily unavailable. Please try again.",
            provider="openai",
            operation="realtime_session",
            model=model,
            upstream_status_code=exc.response.status_code,
            upstream_response_body=upstream_body,
        )
    except httpx.RequestError as exc:
        provider_error_handler.raise_provider_error(
            logger,
            exc,
            event="realtime_session_provider_unreachable",
            message="OpenAI Realtime session request could not be completed",
            public_detail="Realtime voice is temporarily unavailable. Please try again.",
            provider="openai",
            operation="realtime_session",
            model=model,
        )

    logger.info("realtime_session_created", "Realtime voice session created", provider="openai", model=model, voice=voice)
    return RealtimeSessionResponse(sdp=response.text, model=model, voice=voice)



async def _emit_checkpoint_committed(agent, thread_id, agent_logger, request_context):
    """Read the durable checkpoint head this run produced and encode it as a
    terminal AG-UI CHECKPOINT_COMMITTED frame (or None). The bridge persists
    ``(thread_id, checkpoint_id)`` on the assistant message so the next turn
    resumes and edit/retry fork from this head."""
    if not thread_id:
        return None
    try:
        aget_state = getattr(getattr(agent, "compiled", None), "aget_state", None)
        if aget_state is None:
            return None
        snapshot = await aget_state(agent.run_config)
        cfg = getattr(snapshot, "config", None) or {}
        checkpoint_id = (cfg.get("configurable") or {}).get("checkpoint_id")
        return agent.agui_emitter.checkpoint_committed(thread_id=thread_id, checkpoint_id=checkpoint_id)
    except Exception:
        agent_logger.warning(
            "checkpoint_commit_emit_failed",
            "Failed to read/emit committed checkpoint head",
            context=request_context,
            exc_info=True,
        )
        return None


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
                detail="Unknown agent.",
            )
        # Initialise the agent
        agent_logger.info("agent_initialization_started", "Agent initialization started")
        agent = definition.cls(config=req.config)
    except HTTPException:
        raise
    except Exception as exc:
        agent_logger.warning(
            "agent_initialization_failed",
            "Failed to initialise the requested agent",
            exc_info=True,
            failure_reason="agent_init_failed",
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Failed to initialise the requested agent.",
        ) from exc
    agent_logger.info("agent_initialization_completed", "Agent initialization completed", agent_type=type(agent).__name__)
    request_context = get_context()
    stream_thread_id = configurable.get("thread_id") or ""
    # Per-run identity (assistant message id) used for the namespace-binding
    # cache; distinct from the branch-scoped checkpoint thread_id.
    run_id = context_data.get("run_id") or stream_thread_id
    # Edit/retry forks: seed this (fresh) branch thread from the parent branch's
    # checkpoint at the fork point before running the delta. Continue/new omit it.
    fork_from = req.config.get("fork_from") if isinstance(req.config, dict) else None

    # Stream agent responses. NOTE: durable threads — a fresh /stream must NOT
    # wipe the checkpoint; resume relies on it persisting across turns.
    async def event_stream():
        try:
            agent_logger.info("agent_stream_started", "Agent stream execution started", context=request_context)
            async with mcp_session_context() as session:
                agent_logger.info("mcp_session_connected", "MCP session connected for agent stream", context=request_context)
                live_tools = await load_mcp_tools(session)
                agent_logger.info("mcp_tools_loaded", "Loaded live MCP tools for agent stream", context=request_context, live_tool_count=len(live_tools))
                agent.attach_tools(live_tools)
                agent_logger.info("agent_tools_attached", "Agent tools attached for stream", context=request_context, attached_tool_count=len(getattr(agent, "tools_names", [])))
                if isinstance(fork_from, dict) and stream_thread_id:
                    # Build with tools first (deep agents compile against self.tools),
                    # then seed the new thread from the fork-point checkpoint.
                    await agent.ensure_built()
                    await seed_thread_from_checkpoint(
                        graph=agent.compiled,
                        source_thread_id=str(fork_from.get("thread_id") or ""),
                        source_checkpoint_id=fork_from.get("checkpoint_id"),
                        target_thread_id=stream_thread_id,
                    )
                async for chunk in agent.astream(payload={"messages": req.messages}):
                    yield chunk
            committed = await _emit_checkpoint_committed(agent, stream_thread_id, agent_logger, request_context)
            if committed is not None:
                yield committed
            agent_logger.info("agent_stream_completed", "Agent stream execution completed", context=request_context)
        except asyncio.CancelledError:
            agent_logger.info("agent_stream_cancelled", "Agent stream execution cancelled", context=request_context)
            return
        except Exception as exc:
            agent_logger.error("agent_stream_failed", "Agent stream execution failed", context=request_context, exc_info=True)
            yield agent._encode_run_error(exc)
        finally:
            try:
                await release_checkpoint_unless_paused(agent, run_id)
            except Exception:
                agent_logger.warning("checkpoint_release_failed", "Failed to release namespace cache after stream", context=request_context, exc_info=True)

    return StreamingResponse(event_stream(), media_type="text/event-stream")



# ------------------------------------------------------------------
# Agent HITL Resume Endpoint
# ------------------------------------------------------------------
@app.post("/agents/{agent_slug}/resume", status_code=status.HTTP_200_OK, dependencies=[Depends(require_internal_caller)])
async def resume_agent(agent_slug: str, req: AgentResumeRequest):
    """Resume a LangGraph run paused on a ``__interrupt__`` HITL event.

    Instantiates a fresh agent bound to the shared durable saver on the run's
    branch thread, reads the paused checkpoint (``aget_state``), builds a
    ``Command(resume=...)`` from the bridge's decision payload, and streams the
    resulting AG-UI events back. Stream framing and error encoding mirror the
    regular ``/stream`` endpoint so the bridge can plumb resume output through
    the same Redis stream + WebSocket observer pipeline. Because the checkpoint
    is durable, this now works even across an agents-service restart.
    """
    context_data = req.config.get("context", {}) if isinstance(req.config, dict) else {}
    run_config = req.config.get("run_config", {}) if isinstance(req.config, dict) else {}
    configurable = run_config.get("configurable", {}) if isinstance(run_config, dict) else {}
    # The thread the run was using; the cache key for the saved checkpoint.
    effective_thread_id = req.thread_id or configurable.get("thread_id") or ""
    agent_logger = logger.bind(agent_slug=agent_slug)
    set_context(
        agent_slug=agent_slug,
        user_id=context_data.get("user_id"),
        conversation_id=context_data.get("conversation_id"),
        thread_id=effective_thread_id,
    )
    agent_logger.info(
        "agent_resume_request_received",
        "Agent resume request received",
        decision=req.decision,
        has_value=req.value is not None,
        has_reason=bool(req.reason),
    )

    if not effective_thread_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="thread_id is required to resume a paused run.",
        )
    if not has_checkpointer_initialized():
        # Saver not wired (startup race) — distinct from "no paused interrupt",
        # which is detected below from the durable checkpoint itself.
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Checkpointer is not ready.",
        )

    definition = AGENT_REGISTRY.get(agent_slug, None)
    if definition is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Unknown agent.",
        )

    try:
        # Force the thread_id onto the run_config so the agent binds the shared
        # durable saver to the SAME branch thread the original stream used.
        resume_config = dict(req.config)
        run_config_in = dict(resume_config.get("run_config") or {})
        configurable_in = dict(run_config_in.get("configurable") or {})
        configurable_in["thread_id"] = effective_thread_id
        run_config_in["configurable"] = configurable_in
        resume_config["run_config"] = run_config_in
        agent = definition.cls(config=resume_config)
    except HTTPException:
        raise
    except Exception as exc:
        agent_logger.warning(
            "agent_resume_initialization_failed",
            "Failed to initialise agent for resume",
            exc_info=True,
            failure_reason="agent_init_failed",
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Failed to initialise the requested agent.",
        ) from exc

    request_context = get_context()

    # Build the LangChain HumanInTheLoopMiddleware-compatible resume payload.
    # The middleware expects a dict of the form
    #     {"decisions": [<decision>, <decision>, ...]}
    # with one entry per pending tool call in the SAME order. The middleware
    # raises a ValueError if the count is wrong, so we read it back from the
    # saved checkpoint instead of guessing.
    try:
        # Build the graph bound to the durable saver, then read the saved state
        # (async — AsyncPostgresSaver has no sync get_state) before issuing the
        # resume command. astream() reuses the same built graph.
        await agent.ensure_built()
        snapshot = await agent.compiled.aget_state(agent.run_config)
        pending_interrupts = list(snapshot.interrupts or [])
    except Exception as exc:
        agent_logger.warning(
            "agent_resume_state_load_failed",
            "Failed to load saved state for resume",
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to load the paused checkpoint.",
        ) from exc

    if not pending_interrupts:
        # The cached checkpointer exists but no interrupt is parked on it.
        # This happens if the previous resume already drained the queue or the
        # cache was warmed without ever pausing. Treat as "not paused".
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="No pending interrupt found on the checkpoint.",
        )

    pending_interrupt = pending_interrupts[0]
    pending_id = getattr(pending_interrupt, "id", None)
    # When the bridge passes the interrupt_id the user clicked, verify it
    # matches the graph's currently-pending interrupt. A mismatch means the
    # user clicked a stale card (e.g. the run already advanced past that
    # interrupt) — better to 409 than silently resolve the wrong one.
    if req.interrupt_id and pending_id and req.interrupt_id != str(pending_id):
        agent_logger.warning(
            "agent_resume_stale_interrupt",
            "Resume request targets an interrupt that is no longer pending",
            requested_interrupt_id=req.interrupt_id,
            pending_interrupt_id=str(pending_id),
        )
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="The targeted interrupt is no longer pending.",
        )

    # The first interrupt's value is a langchain HITLRequest:
    #   { "action_requests": [...], "review_configs": [...] }
    interrupt_value = pending_interrupt.value
    if isinstance(interrupt_value, dict):
        action_requests = interrupt_value.get("action_requests") or []
    else:
        action_requests = getattr(interrupt_value, "action_requests", []) or []
    decision_count = max(1, len(action_requests))

    def _to_lc_decision(decision: str, reason: Optional[str]) -> dict[str, Any]:
        # LangChain's RejectDecision requires `message`. Falling back to a
        # generic string when the user didn't type a reason avoids a KeyError
        # in HumanInTheLoopMiddleware.after_model when it does
        # `decision["message"]` to build the ToolMessage. Reject is non-
        # terminal in LangChain — the rejection becomes a ToolMessage and the
        # agent loop continues, which is exactly the "rehydrate after reject"
        # behavior the bridge expects.
        if decision == "approve":
            return {"type": "approve"}
        return {"type": "reject", "message": reason or "User rejected this action."}

    if req.decisions is not None:
        # Per-action path (batched interrupt): one decision per hanging tool
        # call, in order. LangChain maps decisions[i] -> action_requests[i]
        # positionally and raises ValueError on a count mismatch, so we guard
        # with a 422 (clearer than a 500 from a leaked ValueError).
        if len(req.decisions) != len(action_requests):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail=(
                    f"Decision count ({len(req.decisions)}) does not match the "
                    f"number of pending actions ({len(action_requests)})."
                ),
            )
        decisions = [_to_lc_decision(d.decision, d.reason) for d in req.decisions]
    else:
        # Legacy / single-action path: replicate the one decision across every
        # hanging tool call.
        decisions = [dict(_to_lc_decision(req.decision, req.reason)) for _ in range(decision_count)]

    resume_command = Command(resume={"decisions": decisions})

    agent_logger.info(
        "agent_resume_command_built",
        "Built LangChain HITL resume command",
        decision=req.decision,
        decision_count=len(decisions),
        decision_types=[d["type"] for d in decisions],
        per_action=req.decisions is not None,
    )

    resume_run_id = context_data.get("run_id") or effective_thread_id

    async def event_stream():
        try:
            agent_logger.info("agent_resume_started", "Agent resume execution started", context=request_context)
            async with mcp_session_context() as session:
                live_tools = await load_mcp_tools(session)
                agent.attach_tools(live_tools)
                async for chunk in agent.astream(payload={"messages": []}, command=resume_command):
                    yield chunk
            committed = await _emit_checkpoint_committed(agent, effective_thread_id, agent_logger, request_context)
            if committed is not None:
                yield committed
            agent_logger.info("agent_resume_completed", "Agent resume execution completed", context=request_context)
        except asyncio.CancelledError:
            agent_logger.info("agent_resume_cancelled", "Agent resume execution cancelled", context=request_context)
            return
        except Exception as exc:
            agent_logger.error("agent_resume_failed", "Agent resume execution failed", context=request_context, exc_info=True)
            yield agent._encode_run_error(exc)
        finally:
            # Resume drained the interrupt → drop the namespace cache. Resume
            # re-paused on another interrupt → keep it for the next /resume.
            # The durable checkpoint is never deleted here.
            try:
                await release_checkpoint_unless_paused(agent, resume_run_id)
            except Exception:
                agent_logger.warning("checkpoint_release_failed", "Failed to release namespace cache after resume", context=request_context, exc_info=True)

    return StreamingResponse(event_stream(), media_type="text/event-stream")
