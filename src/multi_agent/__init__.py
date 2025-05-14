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

import asyncio

async def call(input):
    
    # Use the async streaming API
    async for message in agent.astream(input, stream_mode="custom"):
        print(message, '\n\n')


if __name__ == '__main__':
    
    # Define your inputs
    theological_inputs = {"user_input": "Tell me about Psalm 23"}
    simple_input = {"user_input": "Do you know what is langgraph?"}
    
    asyncio.run(call(simple_input))