# Path setup
from contextlib import asynccontextmanager
from pathlib import Path
import os
import sys

PACKAGE_ROOT = Path(os.path.abspath(os.path.dirname(__file__)))
sys.path.append(str(PACKAGE_ROOT))

# Load LangGraph agents (module import ensures subclasses are registered)
import langgraph_agents

import asyncio
import io
import inspect
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Type

from fastapi import FastAPI, UploadFile, File, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from openai import OpenAI

from blueprints import LangGraphAgent



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
        yield
    finally:
        loop.set_exception_handler(old)


app = FastAPI(lifespan=_lifespan, title="Agents Service")


class Request(BaseModel):
    """Pydantic model for incoming requests: a list of user input dictionaries."""
    user_input: List[Dict[str, Any]]
    config: Optional[Dict[str, Any]] = None


class TranscriptionResponse(BaseModel):
    text: str


class AgentManifest(BaseModel):
    id: str
    slug: str
    name: str
    version: Optional[str] = None
    type: str
    description: str
    icon: str


@dataclass(frozen=True)
class AgentDefinition:
    slug: str
    cls: Type[LangGraphAgent]
    manifest: Dict[str, Any]


def _discover_agents() -> Dict[str, AgentDefinition]:
    """Inspect langgraph_agents exports and register available agent templates."""
    registry: Dict[str, AgentDefinition] = {}
    for attr_name in dir(langgraph_agents):
        candidate = getattr(langgraph_agents, attr_name, None)
        if not inspect.isclass(candidate):
            continue
        if not issubclass(candidate, LangGraphAgent) or candidate is LangGraphAgent:
            continue
        slug = getattr(candidate, "name", None)
        if not isinstance(slug, str) or not slug:
            continue
        manifest = candidate.manifest()
        registry[slug] = AgentDefinition(slug=slug, cls=candidate, manifest=manifest)
    return registry


AGENT_REGISTRY: Dict[str, AgentDefinition] = _discover_agents()


def _instantiate_agent(definition: AgentDefinition, *, config: Optional[Dict[str, Any]]) -> LangGraphAgent:
    """Instantiate an agent template, wrapping errors into HTTPExceptions."""
    try:
        return definition.cls(config=config)
    except Exception as exc:  # noqa: BLE001
        detail = f"Failed to initialise agent '{definition.slug}': {exc}"
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=detail) from exc


# --------------------------------------
# Dictation Endpoint
# --------------------------------------
@app.post("/dictate/transcribe", response_model=TranscriptionResponse, status_code=status.HTTP_200_OK)
async def transcribe_audio(file: UploadFile = File(...)) -> TranscriptionResponse:
    """
    Transcribe an uploaded audio file using OpenAI's Speech-to-Text capability.
    """
    _OPENAI_STT_MODEL = "gpt-4o-transcribe"
    _OPENAI_CLIENT = OpenAI()
    
    if not file.filename:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Audio file upload is required.",
        )
    
    try:
        audio_bytes = await file.read()
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Failed to read uploaded audio file: {exc}",
        ) from exc
    
    if not audio_bytes:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="The uploaded audio file is empty.",
        )
    
    audio_stream = io.BytesIO(audio_bytes)
    audio_stream.name = file.filename
    
    try:
        transcription = _OPENAI_CLIENT.audio.transcriptions.create(
            model=_OPENAI_STT_MODEL,
            file=audio_stream,
        )
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"OpenAI transcription request failed: {exc}",
        ) from exc
    
    text = getattr(transcription, "text", None)
    if text is None and isinstance(transcription, dict):
        text = transcription.get("text")
    
    if text is None:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="OpenAI transcription response did not include text.",
        )
    
    return TranscriptionResponse(text=text)



# --------------------------------------
# Available Agent Endpoint
# --------------------------------------
@app.get("/agents", response_model=List[AgentManifest], status_code=status.HTTP_200_OK)
async def get_available_agents() -> List[AgentManifest]:
    """Return the discovered LangGraph agent manifests for downstream services."""
    manifests = [definition.manifest for definition in AGENT_REGISTRY.values()]
    manifests.sort(key=lambda item: item.get("name", ""))
    return [AgentManifest.model_validate(item) for item in manifests]



# --------------------------------------
# Agent Interaction Endpoint
# --------------------------------------
@app.post("/agents/{agent_slug}/stream", status_code=status.HTTP_200_OK)
async def stream_agent(agent_slug: str, req: Request):
    """Stream responses from the requested agent template."""
    definition = AGENT_REGISTRY.get(agent_slug)
    if definition is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Unknown agent '{agent_slug}'.",
        )

    agent = _instantiate_agent(definition, config=req.config)

    async def event_stream():
        async for msg in agent.astream({"user_input": req.user_input}):
            yield msg

    return StreamingResponse(event_stream(), media_type="text/event-stream")
