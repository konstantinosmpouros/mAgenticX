# Path setup
from pathlib import Path
import os
import sys

PACKAGE_ROOT = Path(os.path.abspath(os.path.dirname(__file__)))
sys.path.append(str(PACKAGE_ROOT))

# Load LangGraph agents
from agents.langgraph_agents import (
    hr_policies_agent_v1,
    RetailAgentV1,
    OrthodoxAgentV1,
)

import asyncio
import json
import traceback
from fastapi import FastAPI
from pydantic import BaseModel
from fastapi.responses import StreamingResponse
from typing import Any, Dict, List, Optional


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


@app.post("/OrthodoxAI/v1/stream", status_code=200)
async def stream_agent(req: Request):
    """Stream responses from the OrthodoxAI v1 agent."""
    async def event_stream():
        agent = OrthodoxAgentV1(config=req.config)
        try:
            async for msg in agent.astream({"user_input": req.user_input}, stream_mode="custom"):
                yield msg
        except asyncio.CancelledError:
            # Client disconnected; stop quietly to avoid noisy logs
            return
        except (BrokenPipeError, ConnectionResetError):
            # Downstream closed; no further writes
            return
        except Exception as e:
            err = {"type": "RUN_ERROR", "message": _format_run_error_message(e)}
            yield ("data: " + json.dumps(err) + "\n\n").encode("utf-8")
    
    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.post("/HRPolicies/v1/stream", status_code=200)
async def stream_agent(req: Request):
    """Stream responses from the HR Policies v1 agent."""
    async def event_stream():
        try:
            async for msg in hr_policies_agent_v1.astream({"user_input": req.user_input}, stream_mode="custom"):
                # If nodes emit pre-encoded SSE frames (AG-UI EventEncoder), forward as-is
                if isinstance(msg, (str, bytes)):
                    if isinstance(msg, str):
                        yield msg.encode("utf-8")
                    else:
                        yield msg
                else:
                    # Fallback: wrap dicts as SSE data lines
                    yield ("data: " + json.dumps(msg) + "\n\n").encode("utf-8")
        except asyncio.CancelledError:
            # Client disconnected; stop quietly to avoid noisy logs
            return
        except (BrokenPipeError, ConnectionResetError):
            # Downstream closed; no further writes
            return
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
        except asyncio.CancelledError:
            # Client disconnected; stop quietly to avoid noisy logs
            return
        except (BrokenPipeError, ConnectionResetError):
            # Downstream closed; no further writes
            return
        except Exception as e:
            err = {"type": "RUN_ERROR", "message": _format_run_error_message(e)}
            yield ("data: " + json.dumps(err) + "\n\n").encode("utf-8")
    
    return StreamingResponse(event_stream(), media_type="text/event-stream")


