"""``wait`` — pause the run for a fixed number of seconds.

``seconds`` is capped at 600 (10 minutes), and the cap is load-bearing, not a
taste: the bridge's watchdog fails a run that persists no event for 900 s
(``WORKFLOW_RUN_STREAM_IDLE_TIMEOUT_SECONDS``), and a waiting node emits
nothing between its ``node_input`` and its ``node_output``. The keep-alive
comments the runner sends while a node is busy keep the HTTP stream open, but
they are not persisted events, so they do not reset that watchdog. 600 s leaves
headroom below 900 s. A longer pause belongs in a schedule, not a sleeping run.

Output: ``{"waitedSeconds": seconds}``.
"""
from __future__ import annotations

import asyncio
from collections.abc import Mapping
from typing import Any

from pydantic import Field

from harness.workflows.nodes.base import NodeConfig, NodeContext, NodeResult, WorkflowNode

#: Must stay well below the bridge's 900 s idle watchdog (see the docstring).
MAX_WAIT_SECONDS = 600


class WaitConfig(NodeConfig):
    """How long to pause."""

    seconds: int = Field(ge=1, le=MAX_WAIT_SECONDS, description="Seconds to pause (1 to 600).")


class WaitNode(WorkflowNode):
    """A fixed pause."""

    kind = "wait"
    label = "Wait"
    group = "flow"
    description = "Pause the run for up to 10 minutes."
    Config = WaitConfig

    async def run(self, state: Mapping[str, Any], ctx: NodeContext) -> NodeResult:
        cfg: WaitConfig = ctx.config
        await asyncio.sleep(cfg.seconds)
        return NodeResult(output={"waitedSeconds": cfg.seconds})


__all__ = ["WaitConfig", "WaitNode"]
