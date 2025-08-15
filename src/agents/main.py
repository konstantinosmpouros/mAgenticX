# Path setup
from pathlib import Path
import os
import sys

PACKAGE_ROOT = Path(os.path.abspath(os.path.dirname(__file__)))
sys.path.append(str(PACKAGE_ROOT))

# Load agents
from orthodox_agents import orthodoxai_agent_v1
from hr_agents import hr_policies_agent_v1
from retail_agents import retail_agent_v1

# Load moderation
# from moderation import moderation_agent

import json
from fastapi import FastAPI
from pydantic import BaseModel
from fastapi.responses import StreamingResponse
from typing import List, Dict


app = FastAPI()

class StrRequest(BaseModel):
    """Pydantic model for incoming requests: a list of user input dictionaries."""
    user_input: List[Dict[str, str]]


@app.post("/OrthodoxAI/v1/stream", status_code=200)
async def stream_agent(req: StrRequest):
    """Stream responses from the OrthodoxAI v1 agent."""
    async def event_stream():
        async for msg in orthodoxai_agent_v1.astream({"user_input": req.user_input}, stream_mode="custom"):
            yield (json.dumps(msg) + "\n").encode(encoding="utf-8")
    
    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.post("/HRPolicies/v1/stream", status_code=200)
async def stream_agent(req: StrRequest):
    """Stream responses from the HR Policies v1 agent."""
    async def event_stream():
        async for msg in hr_policies_agent_v1.astream({"user_input": req.user_input}, stream_mode="custom"):
            yield (json.dumps(msg) + "\n").encode(encoding="utf-8")
    
    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.post("/Retail/v1/stream", status_code=200)
async def stream_agent(req: StrRequest):
    """Stream responses from the Retail v1 agent."""
    async def event_stream():
        async for msg in retail_agent_v1.astream({"user_input": req.user_input}, stream_mode="custom"):
            yield (json.dumps(msg) + "\n").encode(encoding="utf-8")
    
    return StreamingResponse(event_stream(), media_type="text/event-stream")


