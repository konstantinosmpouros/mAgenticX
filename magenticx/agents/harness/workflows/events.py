"""AG-UI events of a workflow run, and the run envelope every one of them carries.

A workflow run streams ordinary AG-UI frames (``RUN_STARTED``, ``STEP_STARTED``,
``TOOL_CALL_*``, ``STATE_DELTA`` …) plus three custom events. What makes the
stream replayable node by node — loops included, where one node runs many
times — is the **envelope** stamped on every frame:

.. code-block:: json

    "workflow": {
      "runId": "<run id>",
      "nodeId": "fetch" | null,
      "executionId": "fetch#2" | null,
      "parentExecutionId": "retry#1" | null,
      "iteration": 2 | null
    }

``executionId`` is ``<nodeId>#<n>`` with ``n`` the 1-based count of that node's
executions in the run, and ``iteration`` is that same ``n``.
``parentExecutionId`` is the execution of the innermost ``loop`` node whose
iteration this execution belongs to (``null`` outside any loop). Run-level
frames (``RUN_STARTED`` / ``RUN_FINISHED`` / ``RUN_ERROR`` and the
``workflow.run`` info event) carry ``nodeId`` and the rest as ``null``.

The envelope is injected by the same mechanism that stamps ``namespace`` on
every agent frame (``AGUIEmitter._extra_fields``), so a node's own events —
emitted through ``ctx.emitter`` — carry it without any call site adding it.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ag_ui.core import (
    CustomEvent,
    EventType,
    RunErrorEvent,
    RunFinishedEvent,
    StateDeltaEvent,
    StepFinishedEvent,
    StepStartedEvent,
)

from harness.agui.emitter import AGUIEmitter

#: Custom event names. ``node_input`` / ``node_output`` bracket a node's own
#: events; ``run`` identifies what is running (workflow id, pinned version).
NODE_INPUT_EVENT = "workflow.node_input"
NODE_OUTPUT_EVENT = "workflow.node_output"
RUN_INFO_EVENT = "workflow.run"
#: ``metadata.source`` on the ``HITL_INTERRUPT`` an ``approval`` node raises.
APPROVAL_INTERRUPT_SOURCE = "workflow.approval"


@dataclass(frozen=True)
class WorkflowEnvelope:
    """Where in the run a frame comes from. Node fields are ``None`` for run-level frames."""

    run_id: str
    node_id: str | None = None
    execution_id: str | None = None
    parent_execution_id: str | None = None
    iteration: int | None = None

    def as_payload(self) -> dict[str, Any]:
        return {
            "runId": self.run_id,
            "nodeId": self.node_id,
            "executionId": self.execution_id,
            "parentExecutionId": self.parent_execution_id,
            "iteration": self.iteration,
        }


class WorkflowEmitter(AGUIEmitter):
    """An ``AGUIEmitter`` bound to one envelope — one per node execution.

    Every inherited method (tool calls, text, HITL) works unchanged; each frame
    simply gains the ``workflow`` field.
    """

    def __init__(self, envelope: WorkflowEnvelope) -> None:
        super().__init__()
        self.envelope = envelope

    def _extra_fields(self) -> dict[str, Any]:
        return {"workflow": self.envelope.as_payload()}

    # ---------- Steps ----------
    def step_started(self, step_name: str, writer: Any = None) -> bytes | None:
        return self._emit(StepStartedEvent(type=EventType.STEP_STARTED, step_name=step_name), writer)

    def step_finished(self, step_name: str, writer: Any = None) -> bytes | None:
        return self._emit(StepFinishedEvent(type=EventType.STEP_FINISHED, step_name=step_name), writer)

    def state_delta(self, patch: list[dict[str, Any]], writer: Any = None) -> bytes | None:
        """A JSON Patch (RFC 6902) against the run's variables document (``{name: value}``)."""
        return self._emit(StateDeltaEvent(type=EventType.STATE_DELTA, delta=patch), writer)

    # ---------- Node bracket ----------
    def node_input(self, *, config: Any, iteration: int, writer: Any = None) -> bytes | None:
        """What the node is about to run with: its config with templates resolved
        (``None`` when resolving failed)."""
        return self._custom(NODE_INPUT_EVENT, {"config": config, "iteration": iteration}, writer)

    def node_output(
        self,
        *,
        output: Any,
        branch: str | None,
        duration_ms: int,
        error: dict[str, str] | None,
        writer: Any = None,
    ) -> bytes | None:
        """What the node produced — or ``error`` ``{code, message}`` when it failed."""
        return self._custom(
            NODE_OUTPUT_EVENT,
            {"output": output, "branch": branch, "durationMs": duration_ms, "error": error},
            writer,
        )

    # ---------- Run level ----------
    def run_info(self, *, workflow_id: str, version_no: int, resumed: bool) -> bytes | None:
        """Which workflow and pinned version this run executes (history shows "v7")."""
        return self._custom(
            RUN_INFO_EVENT,
            {"workflowId": workflow_id, "versionNo": version_no, "resumed": resumed},
            None,
        )

    def run_finished(self, thread_id: str, run_id: str, result: dict[str, Any]) -> bytes | None:
        """``RUN_FINISHED`` of a completed run (a paused run ends on its interrupt)."""
        return self._emit(
            RunFinishedEvent(type=EventType.RUN_FINISHED, thread_id=thread_id, run_id=run_id, result=result)
        )

    def run_error(self, message: str, code: str) -> bytes | None:
        return self._emit(RunErrorEvent(type=EventType.RUN_ERROR, message=message, code=code))

    def _custom(self, name: str, value: Any, writer: Any) -> bytes | None:
        return self._emit(CustomEvent(type=EventType.CUSTOM, name=name, value=value), writer)


__all__ = [
    "APPROVAL_INTERRUPT_SOURCE",
    "NODE_INPUT_EVENT",
    "NODE_OUTPUT_EVENT",
    "RUN_INFO_EVENT",
    "WorkflowEmitter",
    "WorkflowEnvelope",
]
