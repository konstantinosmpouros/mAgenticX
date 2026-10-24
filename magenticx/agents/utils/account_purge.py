"""Account deletion (plan 32): remove everything this service holds for one user.

Two kinds of state live here:

* **Checkpoint threads** — LangGraph's durable agent state. They are keyed by
  thread id, not by user, so the bridge (which recorded the ids on its messages)
  sends them in batches.
* **``agent_runtime`` rows** — memories, the skill pool and its files, agent
  skill assignments, custom agent definitions and their files, and every
  conversation's files and their blobs. Each store deletes its own tables in
  its own transaction, by ``user_id`` — no conversation or agent lookup.

Every function here is idempotent — the bridge retries a failed step, and a
retry after a partial success finds less to delete, never an error. Failures
surface as :class:`AccountPurgeError` so the router can answer "try again"
rather than a generic 500.
"""
from __future__ import annotations

import psycopg

from core.logging import get_logger
from harness.agent_registry.store import AgentDefinitionStore
from harness.checkpointer import get_checkpointer
from harness.conversation_files import ConversationFileStore
from harness.filesystem import layout
from harness.memory import AgentMemoryStore, get_memory_pool
from harness.skill_registry.store import SkillStore
from utils.agents import forget_user_agents

logger = get_logger(__name__)


class AccountPurgeError(Exception):
    """A purge step could not finish; it is safe to call again."""

    def __init__(self, part: str) -> None:
        super().__init__(part)
        self.part = part


async def purge_threads(user_id: str, thread_ids: list[str]) -> int:
    """Delete the given checkpoint threads. Returns how many were processed.

    Unknown ids are no-ops in the checkpointer, so a retried batch is harmless.
    Unlike the per-conversation reap, a failure here is **not** swallowed: the
    purge must not record success while state remains.
    """
    try:
        checkpointer = get_checkpointer()
        for thread_id in thread_ids:
            await checkpointer.adelete_thread(thread_id)
    except (RuntimeError, psycopg.Error) as exc:
        # RuntimeError: the checkpointer is not initialised in this process.
        logger.warning(
            "account_purge_threads_failed",
            "Could not delete a user's checkpoint threads; the bridge will retry",
            user_id=user_id,
            error_type=type(exc).__name__,
        )
        raise AccountPurgeError("checkpoint_threads") from exc
    return len(thread_ids)


async def purge_user(user_id: str) -> dict[str, int]:
    """Delete the user's ``agent_runtime`` rows.

    The id is validated as a single safe path segment *before* anything is
    deleted (``ValueError`` → the router answers 400), so a malformed id
    cannot half-run the purge.
    """
    layout.safe_segment(user_id)
    pool = get_memory_pool()
    try:
        counts: dict[str, int] = {
            "agent_memories": await AgentMemoryStore(pool).purge_user(user_id)
        }
        counts.update(await SkillStore(pool).purge_user(user_id))
        counts.update(await AgentDefinitionStore(pool).purge_user(user_id))
        counts.update(await ConversationFileStore(pool).purge_user(user_id))
    except psycopg.Error as exc:
        logger.warning(
            "account_purge_rows_failed",
            "Could not delete a user's agent_runtime rows; the bridge will retry",
            user_id=user_id,
            error_type=type(exc).__name__,
        )
        raise AccountPurgeError("agent_runtime") from exc
    forget_user_agents(user_id)
    logger.info("account_purge_agents_done", "Purged a user's agents-service data", user_id=user_id, **counts)
    return counts
