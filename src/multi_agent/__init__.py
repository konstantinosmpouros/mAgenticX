from pathlib import Path
import os
import sys

PACKAGE_ROOT = Path(os.path.abspath(os.path.dirname(__file__)))
sys.path.append(str(PACKAGE_ROOT))

from dotenv import find_dotenv, load_dotenv
_ = load_dotenv(find_dotenv())

from workflows.orthodoxai import agent

theological_inputs = {"user_input": "Tell me about Psalm 23"}
simple_input = {"user_input": "Do you know what is langgraph?"}

for state in agent.stream(simple_input, stream_mode="values"):
    print()
    print()
    print()
    print(state)
    print()
    print()
    print()
