from fastapi import FastAPI
from pydantic import BaseModel

from .workflows.orthodoxai import agent
from .states import Orthodox_State


app = FastAPI()

class ChatRequest(BaseModel):
    user_input: str


class ChatResponse(BaseModel):
    response: str


@app.post("/chat", response_model=ChatResponse)
async def chat_endpoint(req: ChatRequest):
    """
    Accepts a JSON body {"user_input": "..."} and returns
    {"response": "..."} once the workflow terminates.
    """
    # 1) Build the initial state
    initial_state = Orthodox_State(user_input=req.user_input)

    # 2) Run the agent to completion
    final_state = agent.run(initial_state)

    # 3) Extract the generated response
    return ChatResponse(response=final_state["response"])

