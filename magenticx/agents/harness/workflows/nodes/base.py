"""``WorkflowNode`` — the abstract node every kind in the catalogue extends.

A node kind is a class: catalogue metadata (``kind``, ``label``, ``group``,
``description``), a Pydantic ``Config`` (its JSON Schema is the builder's form),
the branch names it can produce, and one coroutine, :meth:`run`. Everything
else — templating, typing the resolved config, counting executions, state
writes and the AG-UI stream — is done here, by :meth:`__call__`, which is what
the compiler registers as the LangGraph node. Subclasses never emit the
bracket events themselves, so no kind can forget one or get the order wrong.

Every execution streams, in this order (all carrying the run envelope)::

    STEP_STARTED (stepName = node id)
    CUSTOM workflow.node_input   {config: <resolved config>|null, iteration}
    … the node's own events (tool calls, text — via ctx.emitter) …
    CUSTOM workflow.node_output  {output, branch, durationMs, error: null}
    STATE_DELTA                  (JSON Patch of the node's state writes)
    STEP_FINISHED

A failure still closes its bracket — ``node_output`` with ``error`` and
``output: null``, then ``STEP_FINISHED`` (no ``STATE_DELTA``: nothing was
written) — and then fails the run with :class:`WorkflowNodeError`. A node that
pauses on a LangGraph ``interrupt`` (``approval``) emits ``HITL_INTERRUPT`` and
leaves its step open; on resume the same execution (same ``executionId``) is
re-run from the top, as LangGraph re-runs an interrupted node.
"""
from __future__ import annotations

import time
from abc import ABC, abstractmethod
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, ClassVar

from langchain_core.runnables import RunnableConfig
from langgraph.config import get_stream_writer
from langgraph.errors import GraphBubbleUp, GraphInterrupt
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from core.logging import get_logger
from harness.workflows.errors import NodeExecutionError, TemplateError, WorkflowNodeError
from harness.workflows.events import APPROVAL_INTERRUPT_SOURCE, WorkflowEmitter, WorkflowEnvelope
from harness.workflows.spec import NodeSpec, StateFieldSpec, WorkflowSpec
from harness.workflows.state import check_state_write, declared_values, state_patch
from harness.workflows.templating import (
    ASSIGN_ROOTS,
    BASE_ROOTS,
    Reference,
    find_references,
    render,
)

logger = get_logger(__name__)

MAX_ASSIGNMENTS = 32


class NodeConfig(BaseModel):
    """Fields every node kind's config has.

    ``assign`` is how any node writes declared state: ``{field: template}``,
    rendered after the node ran, so its values may read the node's own result
    as ``{{output.<path>}}`` besides ``input`` / ``state`` / ``nodes``.
    """

    model_config = ConfigDict(extra="forbid")

    assign: dict[str, Any] = Field(
        default_factory=dict,
        max_length=MAX_ASSIGNMENTS,
        description="State fields to write after the node runs: {field: value}. "
        "Values are templates and may read {{output.<path>}}.",
    )


@dataclass
class NodeResult:
    """What :meth:`WorkflowNode.run` returns.

    ``output`` becomes ``nodes.<id>.output``; ``state_update`` writes declared
    fields (through their reducers, like ``assign``); ``branch`` picks the
    outgoing edge of a branching kind.
    """

    output: Any = None
    state_update: dict[str, Any] = field(default_factory=dict)
    branch: str | None = None


@dataclass
class RunInfo:
    """Run-wide identity a node may need, read from the LangGraph config.

    ``trigger_kind`` is how the run was started (``manual`` — "Run now" — or
    ``schedule`` — a bridge scheduler fire) and ``fired_at`` when (ISO 8601,
    UTC); the trigger nodes report them. ``fired_at`` is ``None`` when the
    caller did not say.
    """

    run_id: str
    thread_id: str
    owner_user_id: str
    workflow_id: str
    version_no: int | None
    trigger_kind: str = "manual"
    fired_at: str | None = None

    @classmethod
    def from_config(cls, config: RunnableConfig | None) -> RunInfo:
        configurable = (config or {}).get("configurable") or {}
        return cls(
            run_id=str(configurable.get("workflow_run_id") or ""),
            thread_id=str(configurable.get("thread_id") or ""),
            owner_user_id=str(configurable.get("owner_user_id") or ""),
            workflow_id=str(configurable.get("workflow_id") or ""),
            version_no=configurable.get("version_no"),
            trigger_kind=str(configurable.get("trigger_kind") or "manual"),
            fired_at=configurable.get("fired_at") or None,
        )


@dataclass
class NodeContext:
    """Everything one execution of a node gets besides the state."""

    node_id: str
    execution_id: str
    iteration: int
    parent_execution_id: str | None
    run: RunInfo
    config: Any
    scope: Mapping[str, Any]
    emitter: WorkflowEmitter
    writer: Any


@dataclass
class ValidationContext:
    """Live facts a kind's own checks may need (``tool`` checks its ref)."""

    known_mcp_tools: frozenset[str] | None = None


class WorkflowNode(ABC):
    """One node of a compiled workflow; one class per kind."""

    kind: ClassVar[str]
    label: ClassVar[str]
    group: ClassVar[str]
    description: ClassVar[str] = ""
    Config: ClassVar[type[NodeConfig]] = NodeConfig
    #: Static branch names; empty for a kind that does not branch.
    branches: ClassVar[tuple[str, ...]] = ()
    #: Branch names come from the config (``router``), not from ``branches``.
    dynamic_branches: ClassVar[bool] = False
    #: The run's entry node. Exactly one per workflow.
    is_trigger: ClassVar[bool] = False
    #: Whether the config's string values are templates rendered before each
    #: execution. A kind whose config is static data (``trigger.schedule``: a
    #: cadence and literal run inputs) sets it false, so a literal ``{{`` in a
    #: value is neither checked as a reference nor substituted.
    templated: ClassVar[bool] = True

    def __init__(self, node: NodeSpec, spec: WorkflowSpec) -> None:
        """Bind the kind to one node. Raises ``ValidationError`` on a bad config."""
        self.node = node
        self.spec = spec
        self.config = self.Config.model_validate(node.config)
        self.fields: dict[str, StateFieldSpec] = spec.state_fields()

    @property
    def id(self) -> str:
        return self.node.id

    # ------------------------------------------------------------------
    # Declarations (validator + catalogue)
    # ------------------------------------------------------------------
    def branch_names(self) -> tuple[str, ...]:
        """The branches this node can take. ``router`` derives them from its cases."""
        return self.branches

    def config_template(self) -> dict[str, Any]:
        """The config as rendered before :meth:`run` — everything but ``assign``."""
        return {key: value for key, value in self.node.config.items() if key != "assign"}

    def rule_paths(self) -> list[str]:
        """Bare paths the kind reads besides its templates (rule ``path`` fields)."""
        return []

    def references(self) -> list[Reference]:
        """Every path this node reads before it runs. Raises on a malformed one."""
        refs = find_references(self.config_template(), roots=BASE_ROOTS) if self.templated else []
        refs += [find_references("{{" + path + "}}", roots=BASE_ROOTS)[0] for path in self.rule_paths()]
        return refs

    def assign_references(self) -> list[Reference]:
        """Paths the ``assign`` block reads (``output`` allowed)."""
        return find_references(self.config.assign, roots=ASSIGN_ROOTS)

    def reads(self) -> list[str]:
        """Declared reads: the paths this node depends on (templates, rules, assign)."""
        refs = [*self.references(), *(r for r in self.assign_references() if r.root != "output")]
        return sorted({ref.text for ref in refs})

    def writes(self) -> list[str]:
        """Declared writes: its own output and every state field it assigns."""
        return [f"nodes.{self.id}.output", *(f"state.{name}" for name in self.config.assign)]

    def validate_semantics(self, ctx: ValidationContext) -> list[tuple[str, str]]:
        """Kind-specific checks beyond the config schema: ``(config path, message)``."""
        return []

    @classmethod
    def catalog_entry(cls) -> dict[str, Any]:
        """The kind as the builder sees it."""
        return {
            "kind": cls.kind,
            "label": cls.label,
            "group": cls.group,
            "description": cls.description,
            "branches": list(cls.branches),
            "dynamicBranches": cls.dynamic_branches,
            "isTrigger": cls.is_trigger,
            "configSchema": cls.Config.model_json_schema(),
        }

    # ------------------------------------------------------------------
    # Execution
    # ------------------------------------------------------------------
    @abstractmethod
    async def run(self, state: Mapping[str, Any], ctx: NodeContext) -> NodeResult:
        """Do the node's work. ``ctx.config`` is the typed, rendered config."""

    def next_loops(self, loops: list[str], result: NodeResult, execution_id: str) -> list[str]:
        """The active loop stack after this execution. Only ``loop`` changes it."""
        return loops

    def scope_of(self, state: Mapping[str, Any]) -> dict[str, Any]:
        """The template roots for this run's current state."""
        return {
            "input": state.get("input") or {},
            "state": declared_values(state, self.spec),
            "nodes": state.get("nodes") or {},
        }

    async def __call__(self, state: Mapping[str, Any], config: RunnableConfig) -> dict[str, Any]:
        """The LangGraph node: run once, stream the bracket, return the state update."""
        writer = get_stream_writer()
        run = RunInfo.from_config(config)
        iteration = int((state.get("iterations") or {}).get(self.id, 0)) + 1
        execution_id = f"{self.id}#{iteration}"
        trace = state.get("trace") or {}
        loops = list(trace.get("loops") or [])
        parent = loops[-1] if loops else None
        emitter = WorkflowEmitter(
            WorkflowEnvelope(
                run_id=run.run_id,
                node_id=self.id,
                execution_id=execution_id,
                parent_execution_id=parent,
                iteration=iteration,
            )
        )
        started = time.monotonic()
        input_sent = False
        emitter.step_started(self.id, writer)
        try:
            scope = self.scope_of(state)
            template = self.config_template()
            rendered = render(template, scope, roots=BASE_ROOTS) if self.templated else template
            emitter.node_input(config=rendered, iteration=iteration, writer=writer)
            input_sent = True
            typed = self.Config.model_validate({**rendered, "assign": self.config.assign})
            ctx = NodeContext(
                node_id=self.id,
                execution_id=execution_id,
                iteration=iteration,
                parent_execution_id=parent,
                run=run,
                config=typed,
                scope=scope,
                emitter=emitter,
                writer=writer,
            )
            result = await self.run(state, ctx)
            if self.branch_names() and result.branch not in self.branch_names():
                raise NodeExecutionError(f"Produced an unknown branch '{result.branch}'.", code="branch")
            updates = self._state_writes(result, scope)
            emitter.node_output(
                output=result.output,
                branch=result.branch,
                duration_ms=_elapsed_ms(started),
                error=None,
                writer=writer,
            )
            emitter.state_delta(state_patch(updates, self.fields), writer)
            emitter.step_finished(self.id, writer)
        except GraphBubbleUp as exc:
            # Not a failure: LangGraph control flow. An interrupt pauses the run
            # here; tell the client what it is waiting for, then let it unwind.
            if isinstance(exc, GraphInterrupt):
                self._emit_interrupts(exc, emitter, run, execution_id, writer)
            raise
        except Exception as exc:
            error = _describe(exc)
            if not input_sent:
                emitter.node_input(config=None, iteration=iteration, writer=writer)
            emitter.node_output(
                output=None,
                branch=None,
                duration_ms=_elapsed_ms(started),
                error=error,
                writer=writer,
            )
            emitter.step_finished(self.id, writer)
            # Ids and the error code only — never the config or any data.
            logger.warning(
                "workflow_node_failed",
                "Workflow node failed",
                workflow_id=run.workflow_id,
                node_id=self.id,
                node_kind=self.kind,
                execution_id=execution_id,
                error_code=error["code"],
                exception_type=type(exc).__name__,
            )
            raise WorkflowNodeError(self.id, error["message"], code=error["code"]) from exc

        return {
            "nodes": {self.id: {"output": result.output, "branch": result.branch, "executionId": execution_id}},
            "iterations": {self.id: iteration},
            "trace": {"loops": self.next_loops(loops, result, execution_id), "last": execution_id},
            **updates,
        }

    def _state_writes(self, result: NodeResult, scope: Mapping[str, Any]) -> dict[str, Any]:
        """The node's own state writes plus its rendered ``assign``, type-checked."""
        updates = dict(result.state_update)
        if self.config.assign:
            assign_scope = {**scope, "output": result.output}
            updates.update(render(self.config.assign, assign_scope, roots=ASSIGN_ROOTS))
        for name, value in updates.items():
            declared = self.fields.get(name)
            if declared is None:
                raise NodeExecutionError(f"'{name}' is not a declared state field.", code="state")
            check_state_write(declared, value)
        return updates

    def _emit_interrupts(
        self, exc: GraphInterrupt, emitter: WorkflowEmitter, run: RunInfo, execution_id: str, writer: Any
    ) -> None:
        """One ``HITL_INTERRUPT`` per pending interrupt, in the shape agent runs use."""
        interrupts = exc.args[0] if exc.args else ()
        for item in interrupts or ():
            emitter.hitl_interrupt(
                thread_id=run.thread_id,
                interrupt={"id": getattr(item, "id", None), "value": getattr(item, "value", item)},
                metadata={
                    "namespace": None,
                    "source": APPROVAL_INTERRUPT_SOURCE,
                    "nodeId": self.id,
                    "executionId": execution_id,
                },
                writer=writer,
            )


def _elapsed_ms(started: float) -> int:
    return int((time.monotonic() - started) * 1000)


def _describe(exc: Exception) -> dict[str, str]:
    """A failure as ``{code, message}`` safe to stream to the owner.

    Messages from our own error types are written to be shown; a config that
    no longer validates after templating is described by field location only
    (Pydantic's own text can echo the offending value); anything else is an
    unexpected failure and says only that.
    """
    if isinstance(exc, TemplateError):
        return {"code": "template", "message": str(exc)}
    if isinstance(exc, NodeExecutionError):
        return {"code": exc.code, "message": str(exc)}
    if isinstance(exc, ValidationError):
        first = exc.errors()[0] if exc.errors() else {}
        where = ".".join(str(part) for part in first.get("loc", ())) or "config"
        return {"code": "config", "message": f"Config is invalid after templating at '{where}': {first.get('type', 'invalid')}."}
    return {"code": "internal", "message": "The node failed unexpectedly."}


__all__ = [
    "NodeConfig",
    "NodeContext",
    "NodeResult",
    "RunInfo",
    "ValidationContext",
    "WorkflowNode",
]
