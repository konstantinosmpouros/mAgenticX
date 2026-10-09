"""Copy-on-fork seeding for branch threads.

Edit/retry create a sibling branch in the conversation tree. With per-branch
checkpoint threads, the new branch's thread must be **seeded** from the parent
branch's real checkpoint state at the fork point — so the agent resumes with
full tool/sub-agent fidelity up to that point — then runs the new (edited or
re-sent) message forward.

The seed copies the *state snapshot* at the source checkpoint into a single
fresh checkpoint on the target thread via the graph's ``aget_state`` /
``aupdate_state`` — not the source's full checkpoint lineage. That is exactly
the desired semantics: the new branch starts from the fork-point state and
diverges, while the source thread is left untouched (isolation preserved).

If reducer-based seeding ever proves lossy for complex deepagents state, the
fallback is a row-level copy of the source thread's checkpoint chain up to the
fork checkpoint (rewriting ``thread_id``) directly in Postgres — see the
migration plan. Keep that swap localized to this module.
"""

from __future__ import annotations

from typing import Any, Optional

from core.logging import get_logger
from harness.middlewares import EVENT_KEY

logger = get_logger(__name__)

#: The node a private-state write is attributed to. A write through the input
#: (as the seed above is) drops private channels — deepagents' compaction among
#: them — and on a fresh thread LangGraph cannot pick the writer itself. The
#: agent's own "model" node writes ``_summarization_event`` in a real run, so
#: attributing the copy to it is exactly what a run would have produced.
STATE_WRITER_NODE = "model"


async def carry_compaction(
    graph: Any, source_cfg: dict[str, Any], source_values: dict[str, Any], target_cfg: dict[str, Any]
) -> bool:
    """Copy the source's compaction onto the freshly seeded target.

    The seed writes the fork-point values through the graph's input, which
    omits private channels, so a fork of a compacted branch used to start from
    the full raw history again (plan 34). The compaction comes from the source
    snapshot, or from its saved checkpoint when the snapshot does not surface
    it. Returns True when a compaction was carried.
    """
    event = source_values.get(EVENT_KEY)
    checkpointer = getattr(graph, "checkpointer", None)
    if not event and checkpointer is not None:
        source = await checkpointer.aget_tuple(source_cfg)
        event = (source.checkpoint.get("channel_values") or {}).get(EVENT_KEY) if source is not None else None
    if not event:
        return False
    await graph.aupdate_state(target_cfg, {EVENT_KEY: event}, as_node=STATE_WRITER_NODE)
    return True


async def seed_thread_from_checkpoint(
    *,
    graph: Any,
    source_thread_id: str,
    source_checkpoint_id: Optional[str],
    target_thread_id: str,
) -> bool:
    """Seed ``target_thread_id`` from the state at ``source_thread_id``/
    ``source_checkpoint_id``. Idempotent: if the target already has state it is
    left as-is. Returns True when the target ends up seeded (or already was),
    False when the source had no state to copy or seeding failed (the caller
    proceeds on an empty thread — degraded, never crashing)."""
    if not source_thread_id or not target_thread_id:
        return False

    target_cfg = {"configurable": {"thread_id": target_thread_id}}
    try:
        existing = await graph.aget_state(target_cfg)
        if existing is not None and getattr(existing, "values", None):
            return True  # already seeded by a prior attempt — don't double-apply

        src_cfg: dict[str, Any] = {"configurable": {"thread_id": source_thread_id}}
        if source_checkpoint_id:
            src_cfg["configurable"]["checkpoint_id"] = source_checkpoint_id
        src_snapshot = await graph.aget_state(src_cfg)
        src_values = getattr(src_snapshot, "values", None) if src_snapshot is not None else None
        if not src_values:
            logger.warning(
                "checkpoint_fork_source_empty",
                "Fork source had no checkpoint state to seed from",
                source_thread_id=source_thread_id,
                source_checkpoint_id=source_checkpoint_id,
                target_thread_id=target_thread_id,
            )
            return False

        # Seeding an EMPTY target: channel reducers (add_messages, the files
        # DeltaChannel, todos) merge the snapshot into nothing → an exact copy
        # of the fork-point values as a single seed checkpoint.
        await graph.aupdate_state(target_cfg, src_values)
        try:
            compacted = await carry_compaction(graph, src_cfg, src_values, target_cfg)
        except Exception:
            # The branch is seeded either way; without the compaction it only
            # starts from the full history again (and re-compacts when full).
            compacted = False
            logger.warning(
                "checkpoint_fork_compaction_not_carried",
                "Seeded a branch thread but could not carry the source's compaction",
                exc_info=True,
                source_thread_id=source_thread_id,
                target_thread_id=target_thread_id,
            )
        logger.info(
            "checkpoint_fork_seeded",
            "Seeded branch thread from fork-point checkpoint",
            source_thread_id=source_thread_id,
            source_checkpoint_id=source_checkpoint_id,
            target_thread_id=target_thread_id,
            carried_compaction=compacted,
        )
        return True
    except Exception:
        logger.error(
            "checkpoint_fork_seed_failed",
            "Failed to seed branch thread from fork checkpoint; proceeding on empty thread",
            exc_info=True,
            source_thread_id=source_thread_id,
            source_checkpoint_id=source_checkpoint_id,
            target_thread_id=target_thread_id,
        )
        return False
