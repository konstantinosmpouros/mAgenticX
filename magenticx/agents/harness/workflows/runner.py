"""Run a compiled workflow as an AG-UI SSE stream — fresh or resumed.

Two phases, so HTTP errors are real status codes and not frames in a stream
that already said 200:

1. :func:`prepare_run` checks everything that can be refused up front — the
   inputs against the spec (a fresh run), or that the thread is paused on an
   approval (a resume) — and loads the persisted state.
2. :meth:`PreparedRun.stream` runs the graph and yields frames::

       RUN_STARTED                      (envelope: run-level)
       CUSTOM workflow.run              {workflowId, versionNo, resumed}
       … every node's bracket …         (envelope: that node execution)
       CUSTOM CHECKPOINT_COMMITTED      {thread_id, checkpoint_id}
       RUN_FINISHED  result {status: "completed", output}
     or, paused on an approval: the node's CUSTOM HITL_INTERRUPT, then
       CUSTOM CHECKPOINT_COMMITTED and the stream ends (no RUN_FINISHED — the
       interrupt is that leg's terminal frame, as the bridge expects)
     or
       RUN_ERROR     {message, code}    (node_failed | step_limit | run_failed)

While a node is busy, an SSE comment (``: keep-alive``) goes out every
:data:`KEEPALIVE_SECONDS`, so the bridge's read timeout never fires on a slow
fetch or tool. The graph runs in its own task: when the client disconnects,
Starlette cancels this generator and the ``finally`` cancels the graph task —
a closed connection stops the run.

Persisted state (``persist: true`` fields) is written only when a run
completes — a failed or paused run leaves the previous values in place.
"""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass, field
from typing import Any, Protocol

from langgraph.errors import GraphRecursionError
from langgraph.types import Command

from core.logging import get_logger
from harness.workflows.compiler import CompiledWorkflow
from harness.workflows.errors import WorkflowNodeError
from harness.workflows.events import WorkflowEmitter, WorkflowEnvelope
from harness.workflows.nodes.approval import APPROVAL_INTERRUPT_TYPE
from harness.workflows.state import coerce_inputs, initial_state

logger = get_logger(__name__)

KEEPALIVE_SECONDS = 15.0
KEEPALIVE_FRAME = b": keep-alive\n\n"
#: Producer → stream queue markers.
_CHUNK, _DONE, _FAILED = "chunk", "done", "failed"
#: How long a cancelled graph task is given to unwind.
_CANCEL_GRACE_SECONDS = 5.0


class PersistedStateStore(Protocol):
    """What the runner needs from the store (``WorkflowStore`` satisfies it)."""

    async def load_persisted(self, owner_user_id: str, workflow_id: str) -> dict[str, Any]: ...

    async def save_persisted(self, owner_user_id: str, workflow_id: str, values: dict[str, Any]) -> None: ...


class RunRefused(Exception):
    """The run cannot start. ``status`` is the HTTP status the router answers."""

    def __init__(self, status: int, message: str, errors: list[str] | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.message = message
        self.errors = errors or []


@dataclass(frozen=True)
class RunTrigger:
    """How a run was started: ``manual`` ("Run now") or ``schedule`` (a bridge
    scheduler fire), and when (ISO 8601, UTC; ``None`` = not stated). The
    trigger node reports both in its output."""

    kind: str = "manual"
    fired_at: str | None = None


@dataclass(frozen=True)
class ResumeDecision:
    """A person's answer to an ``approval`` pause."""

    decision: str
    comment: str | None = None


@dataclass
class PreparedRun:
    """A run that passed every up-front check; :meth:`stream` executes it."""

    compiled: CompiledWorkflow
    run_id: str
    thread_id: str
    owner_user_id: str
    workflow_id: str
    version_no: int
    stream_input: Any
    resumed: bool
    store: PersistedStateStore | None
    config: dict[str, Any] = field(default_factory=dict)

    async def stream(self) -> AsyncIterator[bytes]:
        """Execute the graph and yield its AG-UI frames (see the module docstring)."""
        emitter = WorkflowEmitter(WorkflowEnvelope(run_id=self.run_id))
        graph = self.compiled.graph
        yield emitter.run_start(self.thread_id, self.run_id)
        yield emitter.run_info(workflow_id=self.workflow_id, version_no=self.version_no, resumed=self.resumed)
        log = logger.bind(workflow_id=self.workflow_id, version_no=self.version_no, run_id=self.run_id)
        log.info("workflow_run_started", "Workflow run started", resumed=self.resumed)
        queue: asyncio.Queue = asyncio.Queue(maxsize=256)

        async def produce() -> None:
            try:
                async for chunk in graph.astream(self.stream_input, config=self.config, stream_mode="custom"):
                    await queue.put((_CHUNK, chunk))
            except Exception as exc:
                await queue.put((_FAILED, exc))
                return
            await queue.put((_DONE, None))

        task = asyncio.create_task(produce(), name=f"workflow-run-{self.run_id}")
        try:
            while True:
                try:
                    kind, item = await asyncio.wait_for(queue.get(), KEEPALIVE_SECONDS)
                except TimeoutError:
                    yield KEEPALIVE_FRAME
                    continue
                if kind == _FAILED:
                    raise item
                if kind == _DONE:
                    break
                if isinstance(item, bytes):
                    yield item
                elif isinstance(item, str):
                    yield item.encode("utf-8")
            snapshot = await graph.aget_state(self.config)
            checkpoint_id = ((snapshot.config or {}).get("configurable") or {}).get("checkpoint_id")
            yield emitter.checkpoint_committed(thread_id=self.thread_id, checkpoint_id=checkpoint_id)
            if list(snapshot.interrupts or []):
                log.info("workflow_run_paused", "Workflow run paused for approval")
                return
            values = snapshot.values or {}
            await self._persist(values)
            log.info("workflow_run_completed", "Workflow run completed")
            yield emitter.run_finished(
                self.thread_id, self.run_id, {"status": "completed", "output": _final_output(values)}
            )
        except asyncio.CancelledError:
            log.info("workflow_run_cancelled", "Workflow run cancelled")
            raise
        except WorkflowNodeError as exc:
            log.info("workflow_run_failed", "Workflow run failed in a node", node_id=exc.node_id, error_code=exc.code)
            yield emitter.run_error(str(exc), "node_failed")
        except GraphRecursionError:
            log.warning("workflow_run_step_limit", "Workflow run hit its step limit")
            yield emitter.run_error("The workflow exceeded its step limit.", "step_limit")
        except Exception as exc:
            # Anything else is our bug or an infrastructure failure (the
            # checkpointer, the store); the owner sees a generic message and the
            # log has the traceback — never node data.
            log.error("workflow_run_error", "Workflow run failed", exc_info=True, exception_type=type(exc).__name__)
            yield emitter.run_error("The workflow could not complete this run.", "run_failed")
        finally:
            if not task.done():
                # Client gone (or the stream closed early): stop the graph.
                task.cancel()
                await asyncio.wait({task}, timeout=_CANCEL_GRACE_SECONDS)

    async def _persist(self, values: Mapping[str, Any]) -> None:
        """Write the ``persist: true`` fields of a completed run."""
        persisted = {f.name: values.get(f.name) for f in self.compiled.spec.state if f.persist}
        if persisted and self.store is not None:
            await self.store.save_persisted(self.owner_user_id, self.workflow_id, persisted)


def _final_output(values: Mapping[str, Any]) -> Any:
    """The output of the run's last executed node (an ``end`` node's result)."""
    last = (values.get("trace") or {}).get("last")
    if not last:
        return None
    node_id = str(last).split("#", 1)[0]
    return ((values.get("nodes") or {}).get(node_id) or {}).get("output")


def _pending_approval(snapshot: Any) -> Any | None:
    """The approval interrupt the thread is paused on, if any."""
    for item in list(getattr(snapshot, "interrupts", None) or []):
        value = getattr(item, "value", None)
        if isinstance(value, dict) and value.get("type") == APPROVAL_INTERRUPT_TYPE:
            return item
    return None


async def prepare_run(
    compiled: CompiledWorkflow,
    *,
    run_id: str,
    thread_id: str,
    owner_user_id: str,
    workflow_id: str,
    version_no: int,
    inputs: Mapping[str, Any] | None,
    resume: ResumeDecision | None,
    store: PersistedStateStore | None,
    trigger: RunTrigger | None = None,
) -> PreparedRun:
    """Check a run can start and build its graph input. Raises :class:`RunRefused`.

    A fresh run's inputs are the request's, validated against the declared
    inputs; any input the request leaves out takes its default. A scheduled
    fire sends none, so it runs on the defaults alone.
    """
    trigger = trigger or RunTrigger()
    config = {
        "configurable": {
            "thread_id": thread_id,
            "workflow_run_id": run_id,
            "owner_user_id": owner_user_id,
            "workflow_id": workflow_id,
            "version_no": version_no,
            "trigger_kind": trigger.kind,
            "fired_at": trigger.fired_at,
        },
        "recursion_limit": compiled.recursion_limit,
    }
    if resume is not None:
        snapshot = await compiled.graph.aget_state(config)
        pending = _pending_approval(snapshot)
        if pending is None:
            raise RunRefused(409, "The run is not waiting for an approval.")
        answer = {"decision": resume.decision, "comment": resume.comment}
        interrupt_id = getattr(pending, "id", None)
        # Keyed by interrupt id, so the answer can only ever reach this pause.
        command = Command(resume={interrupt_id: answer} if interrupt_id else answer)
        stream_input: Any = command
    else:
        # A fresh run needs a fresh thread: on a used one, LangGraph would merge
        # the new input into the old run's state (execution counts included).
        existing = await compiled.graph.aget_state(config)
        if getattr(existing, "values", None) or getattr(existing, "next", None):
            raise RunRefused(409, "This thread already holds a run; start a new run on a new thread.")
        values, errors = coerce_inputs(compiled.spec, inputs or {})
        if errors:
            raise RunRefused(422, "The run inputs are invalid.", errors)
        persisted: dict[str, Any] = {}
        if store is not None and any(f.persist for f in compiled.spec.state):
            persisted = await store.load_persisted(owner_user_id, workflow_id)
        stream_input = initial_state(compiled.spec, values, persisted)
    return PreparedRun(
        compiled=compiled,
        run_id=run_id,
        thread_id=thread_id,
        owner_user_id=owner_user_id,
        workflow_id=workflow_id,
        version_no=version_no,
        stream_input=stream_input,
        resumed=resume is not None,
        store=store,
        config=config,
    )


__all__ = [
    "PersistedStateStore",
    "PreparedRun",
    "ResumeDecision",
    "RunRefused",
    "RunTrigger",
    "prepare_run",
]
