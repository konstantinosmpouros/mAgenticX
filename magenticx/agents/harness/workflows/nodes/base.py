"""``WorkflowNode`` — the abstract node every kind in the catalogue extends.

A node kind is a class: catalogue metadata (``kind``, ``label``, ``group``,
``description``), a Pydantic ``Config`` (its JSON Schema is the builder's form),
the branch names it can produce, and one coroutine, :meth:`run`. Everything
else — templating, typing the resolved config, counting executions, variable
writes and the AG-UI stream — is done here, by :meth:`__call__`, which is what
the compiler registers as the LangGraph node. Subclasses never emit the
bracket events themselves, so no kind can forget one or get the order wrong.

Every execution streams, in this order (all carrying the run envelope)::

    STEP_STARTED (stepName = node id)
    CUSTOM workflow.node_input   {config: <resolved config>|null, iteration}
    … the node's own events (tool calls, text — via ctx.emitter) …
    CUSTOM workflow.node_output  {output, branch, durationMs, error: null}
    STATE_DELTA                  (JSON Patch of the node's variable writes —
                                  ``[]`` for every kind but ``set``)
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
from pydantic import BaseModel, ConfigDict, ValidationError, model_validator

from core.logging import get_logger
from harness.agui.emitter import send
from harness.workflows.errors import NodeExecutionError, TemplateError, WorkflowNodeError
from harness.workflows.events import APPROVAL_INTERRUPT_SOURCE, WorkflowEmitter, WorkflowEnvelope
from harness.workflows.spec import NodeSpec, WorkflowSpec
from harness.workflows.state import variable_values, variables_patch
from harness.workflows.templating import BASE_ROOTS, Reference, find_references, render

logger = get_logger(__name__)

#: Engine-owned state keys a node may write through ``NodeResult.engine_update``.
#: Variables go through ``vars_update``; nothing else is writable.
ENGINE_UPDATE_KEYS = frozenset({"conversations"})


class NodeConfig(BaseModel):
    """The base of every node kind's config: unknown keys are refused.

    There are no common fields. A node's result is always in state as
    ``nodes.<id>.output``; variables are written only by ``set`` steps.
    """

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="before")
    @classmethod
    def _drop_legacy_assign(cls, data: Any) -> Any:
        # Specs saved before variables were implicit carry an ``assign`` block
        # on any node; it is no longer read (``WorkflowSpec`` drops it too).
        if isinstance(data, dict) and "assign" in data:
            data = {key: value for key, value in data.items() if key != "assign"}
        return data


@dataclass
class NodeResult:
    """What :meth:`WorkflowNode.run` returns.

    ``output`` becomes ``nodes.<id>.output``; ``vars_update`` overwrites the
    variables it names (only ``set`` returns one); ``branch`` picks the
    outgoing edge of a branching kind. ``engine_update`` writes engine-owned
    keys (only :data:`ENGINE_UPDATE_KEYS` — ``llm``'s conversation turn) through
    their own reducers; it is not a variable write, so it is not part of
    ``STATE_DELTA``.
    """

    output: Any = None
    vars_update: dict[str, Any] = field(default_factory=dict)
    branch: str | None = None
    engine_update: dict[str, Any] = field(default_factory=dict)


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
    #: cadence) sets it false, so a literal ``{{`` in a
    #: value is neither checked as a reference nor substituted.
    templated: ClassVar[bool] = True
    #: Top-level config keys that are never templated in a templated kind —
    #: passed to :meth:`run` exactly as written and skipped by the reference
    #: check. ``code``'s script is one: ``{{`` is legitimate Python.
    literal_fields: ClassVar[frozenset[str]] = frozenset()

    def __init__(self, node: NodeSpec, spec: WorkflowSpec) -> None:
        """Bind the kind to one node. Raises ``ValidationError`` on a bad config."""
        self.node = node
        self.spec = spec
        self.config = self.Config.model_validate(node.config)

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
        """The config as rendered before :meth:`run` — everything but the kind's
        :attr:`literal_fields`."""
        return {key: value for key, value in self.node.config.items() if key not in self.literal_fields}

    def config_literals(self) -> dict[str, Any]:
        """The :attr:`literal_fields` the config sets, as written (never rendered)."""
        return {key: value for key, value in self.node.config.items() if key in self.literal_fields}

    def rule_paths(self) -> list[str]:
        """Bare paths the kind reads besides its templates (rule ``path`` fields)."""
        return []

    def references(self) -> list[Reference]:
        """Every path this node reads before it runs. Raises on a malformed one."""
        refs = find_references(self.config_template(), roots=BASE_ROOTS) if self.templated else []
        refs += [find_references("{{" + path + "}}", roots=BASE_ROOTS)[0] for path in self.rule_paths()]
        return refs

    def extra_reads(self) -> list[str]:
        """Paths the kind reads outside its templates (``llm`` / ``code`` context steps)."""
        return []

    def reads(self) -> list[str]:
        """Declared reads: the paths this node depends on (templates, rules, context)."""
        return sorted({ref.text for ref in self.references()} | set(self.extra_reads()))

    def writes(self) -> list[str]:
        """Declared writes: its own output (``set`` adds the variables it writes)."""
        return [f"nodes.{self.id}.output"]

    def validate_semantics(self, ctx: ValidationContext) -> list[tuple[str, str]]:
        """Kind-specific checks beyond the config schema: ``(config path, message)``."""
        return []

    @classmethod
    def availability(cls) -> tuple[bool, str | None]:
        """Whether this deployment can run the kind: ``(True, None)`` or
        ``(False, reason)``.

        Read live (settings, not a cached flag), so the catalogue and the
        validator always agree. An unavailable kind stays in the catalogue —
        the builder shows it disabled with the reason — but a spec that uses it
        is refused by the validator, and the kind fails closed at run time.
        """
        return True, None

    @classmethod
    def config_schema(cls) -> dict[str, Any]:
        """The config's JSON Schema as the builder's form reads it.

        A kind whose choices depend on the deployment (``llm``'s model list)
        overrides this to inject them; the Pydantic model stays the authority
        and :meth:`validate_semantics` re-checks the live values.
        """
        return cls.Config.model_json_schema()

    @classmethod
    def catalog_entry(cls) -> dict[str, Any]:
        """The kind as the builder sees it."""
        available, reason = cls.availability()
        return {
            "kind": cls.kind,
            "label": cls.label,
            "group": cls.group,
            "description": cls.description,
            "branches": list(cls.branches),
            "dynamicBranches": cls.dynamic_branches,
            "isTrigger": cls.is_trigger,
            "available": available,
            "unavailableReason": None if available else reason,
            "configSchema": cls.config_schema(),
        }

    # ------------------------------------------------------------------
    # Output views
    # ------------------------------------------------------------------
    @classmethod
    def history_entry(cls, output: Any) -> Any:
        """The copy of an output kept in ``nodes.<id>.outputs``.

        Identity by default. A kind whose output embeds something that grows
        with every execution (``llm``'s ``messages``) drops it here, or the
        history would grow quadratically.
        """
        return output

    def input_view(self, rendered: dict[str, Any]) -> dict[str, Any]:
        """The resolved config as ``workflow.node_input`` carries it.

        That event is stored with the run and shown in the run view, so a kind
        whose rendered config can hold credentials (``fetch``'s headers and
        query) masks them here. Identity by default; :meth:`run` still gets the
        real values.
        """
        return rendered

    @classmethod
    def context_value(cls, output: Any) -> Any:
        """What a later step's context sees of an output (``context.py``).

        Identity by default; ``llm`` passes on only its answer.
        """
        return output

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
            "state": variable_values(state, self.spec),
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
        send(writer, emitter.step_started(self.id))
        try:
            scope = self.scope_of(state)
            template = self.config_template()
            rendered = render(template, scope, roots=BASE_ROOTS) if self.templated else template
            rendered = {**rendered, **self.config_literals()}
            send(writer, emitter.node_input(config=self.input_view(rendered), iteration=iteration))
            input_sent = True
            typed = self.Config.model_validate(rendered)
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
            if not set(result.engine_update) <= ENGINE_UPDATE_KEYS:
                raise NodeExecutionError("Wrote an engine key it may not write.", code="internal")
            if self.branch_names() and result.branch not in self.branch_names():
                raise NodeExecutionError(f"Produced an unknown branch '{result.branch}'.", code="branch")
            if result.vars_update and not set(result.vars_update) <= set(self.spec.variables()):
                raise NodeExecutionError("Wrote a name that is not a variable.", code="internal")
            send(writer, emitter.node_output(
                output=result.output,
                branch=result.branch,
                duration_ms=_elapsed_ms(started),
                error=None,
            ))
            send(writer, emitter.state_delta(variables_patch(result.vars_update)))
            send(writer, emitter.step_finished(self.id))
        except GraphBubbleUp as exc:
            # Not a failure: LangGraph control flow. An interrupt pauses the run
            # here; tell the client what it is waiting for, then let it unwind.
            if isinstance(exc, GraphInterrupt):
                self._emit_interrupts(exc, emitter, run, execution_id, writer)
            raise
        except Exception as exc:
            error = _describe(exc)
            if not input_sent:
                send(writer, emitter.node_input(config=None, iteration=iteration))
            send(writer, emitter.node_output(
                output=None,
                branch=None,
                duration_ms=_elapsed_ms(started),
                error=error,
            ))
            send(writer, emitter.step_finished(self.id))
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

        # Built from the current record: a step sits on one path only (the
        # validator keeps parallel paths disjoint), so nothing else writes this
        # node's record concurrently. ``.get(...) or`` because a checkpoint from
        # before ``outputs`` existed lacks it. Every execution is kept: only a
        # loop runs a step again, and its iteration cap bounds how often.
        previous = (state.get("nodes") or {}).get(self.id) or {}
        outputs = [*(previous.get("outputs") or []), self.history_entry(result.output)]
        return {
            "nodes": {
                self.id: {
                    "output": result.output,
                    "outputs": outputs,
                    "branch": result.branch,
                    "executionId": execution_id,
                }
            },
            "iterations": {self.id: iteration},
            "trace": {"loops": self.next_loops(loops, result, execution_id), "last": execution_id},
            "history": [{"node": self.id, "executionId": execution_id}],
            **result.engine_update,
            **({"vars": dict(result.vars_update)} if result.vars_update else {}),
        }

    def _emit_interrupts(
        self, exc: GraphInterrupt, emitter: WorkflowEmitter, run: RunInfo, execution_id: str, writer: Any
    ) -> None:
        """One ``HITL_INTERRUPT`` per pending interrupt, in the shape agent runs use."""
        interrupts = exc.args[0] if exc.args else ()
        for item in interrupts or ():
            send(writer, emitter.hitl_interrupt(
                thread_id=run.thread_id,
                interrupt={"id": getattr(item, "id", None), "value": getattr(item, "value", item)},
                metadata={
                    "namespace": None,
                    "source": APPROVAL_INTERRUPT_SOURCE,
                    "nodeId": self.id,
                    "executionId": execution_id,
                },
            ))


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
    "ENGINE_UPDATE_KEYS",
    "NodeConfig",
    "NodeContext",
    "NodeResult",
    "RunInfo",
    "ValidationContext",
    "WorkflowNode",
]
