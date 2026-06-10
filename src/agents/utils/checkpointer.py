from __future__ import annotations

from typing import Any

from observability import get_logger
from runtime.checkpointer import release_checkpointer

logger = get_logger(__name__)


async def release_checkpoint_unless_paused(agent: Any, thread_id: str) -> None:
    """Free a run's checkpointer unless the graph is parked on a HITL interrupt.

    Run-scoped checkpoints are scratch space: kept only while an interrupt is
    pending (so ``/resume`` can rehydrate the paused graph), otherwise discarded
    the instant the run reaches a non-HITL terminal — completion, error, or
    cancel. Without this a later run reusing the thread could rehydrate stale
    cross-branch state. When the interrupt state can't be read we release
    (favour isolation over a rare resume miss).
    """
    if not thread_id:
        return
    try:
        get_state = getattr(getattr(agent, "compiled", None), "get_state", None)
        if get_state is not None:
            snapshot = get_state(agent.run_config)
            if list(getattr(snapshot, "interrupts", None) or []):
                return
    except Exception:
        logger.warning(
            "checkpoint_interrupt_probe_failed",
            "Could not determine interrupt state; releasing checkpoint",
            exc_info=True,
        )
    await release_checkpointer(thread_id)
