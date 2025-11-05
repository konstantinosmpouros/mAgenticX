# Path setup
from pathlib import Path
import os
import sys

PACKAGE_ROOT = Path(os.path.abspath(os.path.dirname(__file__)))
sys.path.append(str(PACKAGE_ROOT))

# Load LangGraph agents
from langgraph_agents import (
    HRPoliciesAgentV1,
    RetailAgentV1,
    OrthodoxAgentV1,
)

import asyncio
import io
import json
import traceback
from fastapi import FastAPI, UploadFile, File, HTTPException, status
from pydantic import BaseModel
from fastapi.responses import StreamingResponse
from typing import Any, Dict, List, Optional

from openai import OpenAI


app = FastAPI()


def _format_run_error_message(exc: BaseException) -> str:
    tb = traceback.format_exc()
    if tb and tb.strip() and tb.strip() != "NoneType: None":
        return tb.strip()
    return f"{type(exc).__name__}: {exc}"

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


@app.on_event("startup")
async def _configure_loop_exception_handler():
    loop = asyncio.get_event_loop()
    old = loop.get_exception_handler()
    loop.set_exception_handler(_make_loop_exception_handler(old))


class Request(BaseModel):
    """Pydantic model for incoming requests: a list of user input dictionaries."""
    user_input: List[Dict[str, Any]]
    config: Optional[Dict[str, Any]] = None


class TranscriptionResponse(BaseModel):
    text: str


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


@app.post("/OrthodoxAI/v1/stream", status_code=200)
async def stream_agent(req: Request):
    """Stream responses from the OrthodoxAI v1 agent."""
    async def event_stream():
        agent = OrthodoxAgentV1(config=req.config)
        try:
            async for msg in agent.astream({"user_input": req.user_input}, stream_mode="custom"):
                yield msg
        except (BrokenPipeError, ConnectionResetError, asyncio.CancelledError):
            return # Downstream closed; no further writes or Client disconnected; stop quietly to avoid noisy logs
        except Exception as e:
            err = {"type": "RUN_ERROR", "message": _format_run_error_message(e)}
            yield ("data: " + json.dumps(err) + "\n\n").encode("utf-8")
    
    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.post("/HRPolicies/v1/stream", status_code=200)
async def stream_agent(req: Request):
    """Stream responses from the HR Policies v1 agent."""
    async def event_stream():
        agent = HRPoliciesAgentV1(config=req.config)
        try:
            async for msg in agent.astream({"user_input": req.user_input}, stream_mode="custom"):
                yield msg
        except (BrokenPipeError, ConnectionResetError, asyncio.CancelledError):
            return # Downstream closed; no further writes or Client disconnected; stop quietly to avoid noisy logs
        except Exception as e:
            err = {"type": "RUN_ERROR", "message": _format_run_error_message(e)}
            yield ("data: " + json.dumps(err) + "\n\n").encode("utf-8")
    
    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.post("/Retail/v1/stream", status_code=200)
async def stream_agent(req: Request):
    """Stream responses from the Retail v1 agent."""
    async def event_stream():
        agent = RetailAgentV1(config=req.config)
        try:
            async for msg in agent.astream({"user_input": req.user_input}, stream_mode="custom"):
                yield msg
        except (BrokenPipeError, ConnectionResetError, asyncio.CancelledError):
            return # Downstream closed; no further writes or Client disconnected; stop quietly to avoid noisy logs
        except Exception as e:
            err = {"type": "RUN_ERROR", "message": _format_run_error_message(e)}
            yield ("data: " + json.dumps(err) + "\n\n").encode("utf-8")
    
    return StreamingResponse(event_stream(), media_type="text/event-stream")


