from pathlib import Path
import os
import sys

PACKAGE_ROOT = Path(os.path.abspath(os.path.dirname(__file__)))
sys.path.append(str(PACKAGE_ROOT))

from dotenv import find_dotenv, load_dotenv
_ = load_dotenv(find_dotenv())

from workflows.orthodoxai import agent

initial_inputs = {"user_input": "Tell me about Psalm 23"}

for state in agent.stream(initial_inputs, stream_mode="values"):
    print(state)
    print()
    print()
    print()
