"""Agent tool: delete one durable memory for this (user, agent) pair.

The counterpart to ``remember``. Bound **per run** — it closes over the current
run's ``user_id`` + ``agent_slug``, which ``BaseAgent`` reads from the request
config into ``self.context`` — so it can never reach another (user, agent)'s
memory.

Deletes the ``agent_memories`` row. There is no tombstone and no second copy:
the row is the only home the memory has, so a delete is a delete. That is why
the tool is approval-gated by default — the user cannot undo it from the memory
panel, because there is nothing left to restore.

Idempotent: forgetting a name that is already gone reports that plainly instead
of failing. LangGraph checkpoints at super-step boundaries, so a node re-entered
after an approval pause or a container restart runs this again.
"""
from __future__ import annotations

from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

from core.logging import get_logger
from harness.memory import AgentMemoryStore, get_memory_pool, slugify_name

logger = get_logger(__name__)


class _ForgetArgs(BaseModel):
    name: str = Field(
        description="The name of the memory to delete, exactly as it appears in "
        "your memory index."
    )


def build_forget_tool(*, user_id: str, agent_slug: str) -> StructuredTool:
    """Return a ``forget`` tool bound to this run's (user, agent)."""

    async def _forget(name: str) -> str:
        slug = slugify_name(name)
        if not slug:
            return "Could not forget: 'name' must contain letters or digits."

        store = AgentMemoryStore(get_memory_pool())
        try:
            removed = await store.delete_entry(user_id, agent_slug, slug)
        except Exception as exc:
            # The agent is mid-thought. Report the failure as a tool result it
            # can reason about rather than raising, which would fail the run.
            logger.warning(
                "forget_tool_delete_failed",
                "Failed to delete a memory entry",
                user_id=user_id,
                agent_slug=agent_slug,
                memory_name=slug,
                failure_reason=type(exc).__name__,
                exc_info=True,
            )
            return "Could not delete the memory right now."

        if not removed:
            # Not an error: the agent asked for an end state that already holds.
            return f"No memory named '{slug}' — nothing to forget."

        logger.info(
            "memory_forgotten",
            "Deleted an agent memory entry",
            user_id=user_id,
            agent_slug=agent_slug,
            memory_name=slug,
        )
        return f"Forgot memory '{slug}'. It is gone permanently."

    return StructuredTool.from_function(
        coroutine=_forget,
        name="forget",
        description=(
            "Permanently delete one memory from your long-term memory about THIS "
            "user — use it when a fact you saved is wrong, obsolete, or the user "
            "asks you to forget it. Pass the 'name' exactly as it appears in your "
            "memory index. This cannot be undone: to correct a memory rather than "
            "remove it, call 'remember' with the same name instead."
        ),
        args_schema=_ForgetArgs,
    )


__all__ = ["build_forget_tool"]
