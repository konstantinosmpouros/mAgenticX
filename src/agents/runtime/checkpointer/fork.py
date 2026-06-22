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

from observability import get_logger

logger = get_logger(__name__)


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
        logger.info(
            "checkpoint_fork_seeded",
            "Seeded branch thread from fork-point checkpoint",
            source_thread_id=source_thread_id,
            source_checkpoint_id=source_checkpoint_id,
            target_thread_id=target_thread_id,
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
