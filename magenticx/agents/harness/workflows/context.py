"""Context — "data from earlier steps" handed to an ``llm`` or ``code`` step.

Templates (``{{nodes.<id>.output…}}``) are precise but make the author wire
every value by hand. ``context`` is the friendly default: a step names *which*
earlier steps it wants (by default just the one that ran before it) and gets
their outputs as one JSON list — appended to the ``llm`` prompt, or as
``steps`` in the ``code`` step's ``input.json``.

Modes (``StepContext.mode``):

``previous``  the step that executed last before this one (default)
``last``      the last ``count`` distinct steps that executed, oldest first
``steps``     the named steps, in the given order — those that have not run
              (yet, or on a branch not taken) are skipped
``none``      nothing

Each entry is ``{"step", "label", "kind", "output"}`` plus ``"outputs"`` — every
execution's output, oldest first — only when the step ran more than once (a
step inside a loop). Values go through the kind's
:meth:`~harness.workflows.nodes.base.WorkflowNode.context_value`: an ``llm``
step passes on only its answer (the text, or the JSON object), never its
conversation or model.

The entries are data, never instructions or templates: they are serialized
once and never rendered. They are capped at :data:`MAX_CONTEXT_BYTES` so one
step cannot hand an unbounded blob to a model or a sandbox.

This module does not import the node catalogue (the catalogue's ``llm`` and
``code`` import it); the caller passes the kinds in.
"""
from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from harness.workflows.errors import NodeExecutionError
from harness.workflows.spec import NODE_ID_PATTERN, WorkflowSpec

MAX_CONTEXT_BYTES = 64 * 1024
MAX_CONTEXT_STEPS = 20
MAX_LAST_COUNT = 10

ContextMode = Literal["previous", "last", "steps", "none"]
StepId = Annotated[str, StringConstraints(pattern=NODE_ID_PATTERN)]


class StepContext(BaseModel):
    """Which earlier steps' outputs a step receives."""

    model_config = ConfigDict(extra="forbid")

    mode: ContextMode = Field(
        default="previous",
        description="previous: the step that ran just before. last: the last `count` steps. "
        "steps: the steps listed. none: no data from earlier steps.",
    )
    count: int = Field(default=3, ge=1, le=MAX_LAST_COUNT, description="How many steps, for mode last.")
    steps: list[StepId] = Field(
        default_factory=list,
        max_length=MAX_CONTEXT_STEPS,
        description="Step ids, for mode steps.",
    )


def _selected_ids(ctx_spec: StepContext, state: Mapping[str, Any], self_id: str) -> list[str]:
    """The node ids to include, oldest first (``steps``: as listed).

    Only nodes with a record in ``state["nodes"]`` qualify — a step that never
    ran has nothing to pass on.
    """
    records = state.get("nodes") or {}
    history = state.get("history") or []  # a pre-history checkpoint lacks it
    if ctx_spec.mode == "none":
        return []
    if ctx_spec.mode == "steps":
        return [step for step in ctx_spec.steps if step in records]
    wanted = 1 if ctx_spec.mode == "previous" else ctx_spec.count
    picked: list[str] = []
    for entry in reversed(history):
        node_id = entry.get("node") if isinstance(entry, Mapping) else None
        if node_id is None or node_id == self_id or node_id in picked or node_id not in records:
            continue
        picked.append(node_id)
        if len(picked) >= wanted:
            break
    return list(reversed(picked))


def gather_context(
    ctx_spec: StepContext,
    state: Mapping[str, Any],
    spec: WorkflowSpec,
    self_id: str,
    *,
    kinds: Mapping[str, Any],
) -> list[dict[str, Any]]:
    """The context entries for one execution of ``self_id``.

    ``kinds`` is the node catalogue (``kind -> class``), used for each kind's
    ``context_value`` view. Raises ``NodeExecutionError(code="context_too_large")``
    when the entries exceed :data:`MAX_CONTEXT_BYTES` as JSON.
    """
    records = state.get("nodes") or {}
    entries: list[dict[str, Any]] = []
    for node_id in _selected_ids(ctx_spec, state, self_id):
        node = spec.node(node_id)
        if node is None:
            continue
        cls = kinds.get(node.kind)
        view = cls.context_value if cls is not None else (lambda value: value)
        record = records.get(node_id) or {}
        entry: dict[str, Any] = {
            "step": node_id,
            "label": node.label or node_id,
            "kind": node.kind,
            "output": view(record.get("output")),
        }
        outputs = record.get("outputs") or []
        if len(outputs) > 1:
            entry["outputs"] = [view(item) for item in outputs]
        entries.append(entry)
    size = len(json.dumps(entries, ensure_ascii=False, separators=(",", ":"), default=str).encode("utf-8"))
    if size > MAX_CONTEXT_BYTES:
        raise NodeExecutionError(
            f"The data from earlier steps is larger than {MAX_CONTEXT_BYTES // 1024} KiB. "
            "Pick fewer steps (or 'none') in this step's context.",
            code="context_too_large",
        )
    return entries


def context_issues(ctx_spec: StepContext, spec: WorkflowSpec, self_id: str) -> list[tuple[str, str]]:
    """Validator issues for a context: every listed step must exist and not be the step itself.

    Only in ``steps`` mode: a list left over from before the mode was switched
    is not read, so it must not block a save.
    """
    issues: list[tuple[str, str]] = []
    if ctx_spec.mode != "steps":
        return issues
    for step in ctx_spec.steps:
        if step == self_id:
            issues.append(("context.steps", "A step can't use its own output as context."))
        elif spec.node(step) is None:
            issues.append(("context.steps", f"'{step}' is not a step in this workflow."))
    return issues


def context_reads(ctx_spec: StepContext) -> list[str]:
    """The listed steps as declared reads (``nodes.<id>.output``), in ``steps`` mode only."""
    if ctx_spec.mode != "steps":
        return []
    return [f"nodes.{step}.output" for step in ctx_spec.steps]


def context_json(entries: list[dict[str, Any]]) -> str:
    """The entries as the compact JSON a prompt carries."""
    return json.dumps(entries, ensure_ascii=False, separators=(",", ":"), default=str)


__all__ = [
    "MAX_CONTEXT_BYTES",
    "MAX_CONTEXT_STEPS",
    "MAX_LAST_COUNT",
    "ContextMode",
    "StepContext",
    "context_issues",
    "context_json",
    "context_reads",
    "gather_context",
]
