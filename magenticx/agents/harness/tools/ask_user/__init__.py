"""Ask the user clarifying questions, pausing the run until they answer.

One folder per tool: ``tool.py`` holds the implementation and the interrupt /
resume contract, ``schema.py`` the model-facing arguments; this barrel fixes the
public surface so ``harness.tools.ask_user`` stays the import path.
"""
from harness.tools.ask_user.tool import (
    ASK_USER_TOOL_NAME,
    build_ask_user_tool,
    format_reply,
    in_subagent,
    is_ask_user_interrupt,
    resume_value,
)

__all__ = [
    "ASK_USER_TOOL_NAME",
    "build_ask_user_tool",
    "format_reply",
    "in_subagent",
    "is_ask_user_interrupt",
    "resume_value",
]
