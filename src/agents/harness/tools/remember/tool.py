"""Agent tool: save a durable memory for this (user, agent) pair.

Bound **per run** — it closes over the current run's ``user_id`` +
``agent_slug`` + conversation/run identity, which ``BaseAgent`` reads from the
request config into ``self.context`` — so it can never write into another
(user, agent)'s memory.

Writes a row in ``agent_memories`` (``harness/memory/``). There is no file I/O:
``/memories/`` is a virtual route over that table, so the entry the agent reads
back and the ``AGENTS.md`` index it always sees are both served from the row.
The index in particular is *derived*, which is why this tool no longer maintains
it — the old version wrote the entry and patched the index, and the two could
disagree.

Idempotent by name: re-saving the same name updates in place. That is not a
convenience — LangGraph checkpoints at super-step boundaries, so a node re-entered
after an approval pause, a tool retry, or a container restart runs this again.
"""
from __future__ import annotations

from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

from core.logging import get_logger
from core.settings import settings
from harness.memory import AgentMemoryStore, get_memory_pool, slugify_name

logger = get_logger(__name__)

_MAX_SUMMARY = 200
_MAX_CONTENT = 8000


class _RememberArgs(BaseModel):
    name: str = Field(
        description="Short identifier for this memory, e.g. 'user-timezone' or "
        "'project-magenticx'. Reused as the entry's filename — re-using an "
        "existing name updates that memory in place."
    )
    summary: str = Field(
        description="One concise line describing the memory. This is what you "
        "always see in your memory index, so make it self-contained."
    )
    content: str = Field(
        description="The full detail to store — everything worth recalling later. "
        "Saved to the entry file you can read on demand."
    )


def build_remember_tool(
    *,
    user_id: str,
    agent_slug: str,
    conversation_id: str | None,
    run_id: str | None = None,
    thread_id: str | None = None,
    trust_level: str = "unknown",
) -> StructuredTool:
    """Return a ``remember`` tool bound to this run's (user, agent).

    ``trust_level`` is decided by the caller from the run's tool set, not here —
    the tool cannot see what else the agent has been given. It is recorded so a
    memory written by a run that could reach external content is findable later;
    see the column comment for how weak a signal it is.
    """

    async def _remember(name: str, summary: str, content: str) -> str:
        slug = slugify_name(name)
        if not slug:
            return "Could not save: 'name' must contain letters or digits."
        summary = summary.strip()[:_MAX_SUMMARY]
        content = content.strip()[:_MAX_CONTENT]
        if not summary or not content:
            return "Could not save: both 'summary' and 'content' are required."

        store = AgentMemoryStore(get_memory_pool())

        # Hard cap per (user, agent). Updates to an existing entry always go
        # through; only brand-new entries are refused once the limit is hit, so
        # a full memory can still be corrected.
        existing = await store.read_entry(user_id, agent_slug, slug)
        if existing is None:
            cap = settings.filesystem.memory_max_entries
            current = await store.count_pair(user_id, agent_slug)
            if current >= cap:
                return (
                    f"Memory is full ({current}/{cap}). Update an existing memory "
                    "instead, or ask the user to remove some in their memory panel."
                )

        try:
            await store.upsert(
                user_id=user_id,
                agent_slug=agent_slug,
                name=slug,
                summary=summary,
                content=content,
                source_conversation_id=conversation_id,
                source_run_id=run_id,
                source_thread_id=thread_id,
                created_by="agent",
                trust_level=trust_level,
            )
        except Exception as exc:
            # The agent is mid-thought. Report the failure as a tool result it
            # can reason about rather than raising, which would fail the run.
            logger.warning(
                "remember_tool_write_failed",
                "Failed to persist a memory entry",
                user_id=user_id,
                agent_slug=agent_slug,
                memory_name=slug,
                failure_reason=type(exc).__name__,
                exc_info=True,
            )
            return "Could not save the memory right now."

        logger.info(
            "memory_saved",
            "Saved an agent memory entry",
            user_id=user_id,
            agent_slug=agent_slug,
            memory_name=slug,
            trust_level=trust_level,
            updated=existing is not None,
        )
        return f"Saved memory '{slug}'. It will be available in your future conversations with this user."

    return StructuredTool.from_function(
        coroutine=_remember,
        name="remember",
        description=(
            "Save a durable fact about THIS user to your long-term memory so you "
            "can recall it in future conversations — preferences, recurring "
            "projects, key people, decisions, important dates. Provide a short "
            "'name' (reuse it to update the same memory later), a one-line "
            "'summary' for your memory index, and the full 'content'. Save only "
            "things worth remembering long-term, not transient details."
        ),
        args_schema=_RememberArgs,
    )


__all__ = ["build_remember_tool"]
