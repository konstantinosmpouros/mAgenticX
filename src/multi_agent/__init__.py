# Path setup
from pathlib import Path
import os
import sys

PACKAGE_ROOT = Path(os.path.abspath(os.path.dirname(__file__)))
sys.path.append(str(PACKAGE_ROOT))

from dotenv import find_dotenv, load_dotenv

_ = load_dotenv(find_dotenv())

# Load agents
from workflows.orthodoxai import agent

# Import libraries for the server to expose the endpoints
from fastapi import FastAPI
from pydantic import BaseModel


class StrUserInput(BaseModel):
    """Schema for the inbound payload."""
    user_input: str


theological_inputs = {"user_input": "Tell me about Psalm 23"}
simple_input = {"user_input": "Do you know what is langgraph?"}


STRUCTURED = {"analysis", "query_gen", "reflectioner"}
CHUNKED_TEXT = {"summarizer", "simple_generation", "complex_generation"}
last_node = None

for message, meta in agent.stream(simple_input, stream_mode="messages"):
    node = meta["langgraph_node"]

    if node != last_node:
        print("\n\n\n")
        print(node)
        last_node = node
        print("\n\n\n")

    # 1) nodes that eventually emit a structured result -----------------
    if node in STRUCTURED:
        parsed = message.additional_kwargs.get("parsed")
        if parsed is not None:
            print(f"[{node}] parsed → {parsed}")
        continue

    # 2) retrieval just signals completion ------------------------------
    if node == "retrieval":
        print("✅ Retrieved content completed")
        continue

    # 3) nodes whose textual content we stream live ---------------------
    if node in CHUNKED_TEXT:
        for ch in message.content:
            print(ch, end="", flush=True)
        continue
