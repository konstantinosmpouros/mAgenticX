# Path setup
from pathlib import Path
import os
import sys

PACKAGE_ROOT = Path(os.path.abspath(os.path.dirname(__file__)))
sys.path.append(str(PACKAGE_ROOT))

from dotenv import find_dotenv, load_dotenv
_ = load_dotenv(find_dotenv())

# Load agents
from workflows import agent

import json
from fastapi import FastAPI
from pydantic import BaseModel
from fastapi.responses import StreamingResponse


app = FastAPI()

class StrRequest(BaseModel):
    user_input: str


@app.post("/OrthodoxAI/v1/stream")
async def stream_agent(req: StrRequest):
    async def event_stream():
        async for msg in agent.astream({"user_input": req.user_input}, stream_mode="custom"):
            yield json.dumps(msg).encode("utf-8")

    return StreamingResponse(event_stream(), media_type="application/json")

