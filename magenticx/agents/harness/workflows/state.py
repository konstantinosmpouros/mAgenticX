"""The LangGraph state of a workflow run.

The state is one fixed ``TypedDict`` — the same keys for every workflow, all
owned by the engine:

``input``          the run's validated inputs (written once, at start)
``vars``           ``{name: value}`` — the workflow's variables (the keys its
                   ``set`` steps write, :meth:`WorkflowSpec.variables`). A write
                   overwrites the name it writes; a name never written this run
                   is absent (it reads ``null``), unless the previous run kept
                   it (``end``'s ``keep``), in which case it starts with that value
``nodes``          ``{node_id: {"output", "outputs", "branch", "executionId"}}`` —
                   each node's latest result (``output``) and the outputs of
                   its every execution this run (``outputs``, oldest first; a
                   loop's iteration cap bounds how many), merged per node
``iterations``     ``{node_id: n}`` — how many times each node has executed
``trace``          ``{"loops": [executionId, …], "last": executionId}`` — the
                   active loop iterations (innermost last) and the last execution
                   (steps on parallel paths write it in the same superstep; one
                   wins — they share the loop frames, so only ``last`` differs)
``history``        ``[{"node", "executionId"}, …]`` — every execution in order,
                   capped to the newest :data:`MAX_HISTORY`
``conversations``  ``{thread: [message, …]}`` — the ``llm`` steps' conversation
                   memory, appended per thread, capped to the newest
                   :data:`MAX_CONVERSATION_MESSAGES` per thread

Checkpoints written before ``history`` / ``conversations`` / ``outputs`` /
``vars`` existed lack them, so every read goes through ``.get(...) or <empty>``.

Everything here is plain JSON data, so it checkpoints under the strict msgpack
allow-list and replays identically.
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Annotated, Any, TypedDict

from harness.workflows.spec import WorkflowSpec, type_matches

FIXED_KEYS = ("input", "vars", "nodes", "iterations", "trace", "history", "conversations")

#: Newest executions kept in ``history`` — enough for every step of a long
#: looped run, bounded so the checkpoint stays small.
MAX_HISTORY = 500
#: Newest messages kept per conversation thread (a user/assistant pair per turn).
MAX_CONVERSATION_MESSAGES = 100


def merge_dicts(current: dict | None, update: dict | None) -> dict:
    """Shallow merge — the reducer of ``vars``, ``nodes`` and ``iterations``.

    For ``vars`` this is what makes a write an overwrite of the names it
    writes, leaving every other variable as it was. Two ``set`` steps on
    parallel paths writing the same name in one superstep: one of them wins
    (unordered).
    """
    return {**(current or {}), **(update or {})}


def replace_value(current: Any, update: Any) -> Any:
    """The reducer of ``trace``: the update wins.

    A reducer (not LangGraph's plain last-value channel) because steps on
    parallel paths finish in the same superstep, and a plain channel refuses
    two writes in one step.
    """
    return update


def append_history(current: list | None, update: Any) -> list:
    """The reducer of ``history``: append, keep the newest :data:`MAX_HISTORY`."""
    items = update if isinstance(update, list) else [update]
    return [*(current or []), *items][-MAX_HISTORY:]


def append_conversations(current: dict | None, update: dict | None) -> dict:
    """The reducer of ``conversations``: ``{thread: [new messages]}`` appends to
    that thread, keeping its newest :data:`MAX_CONVERSATION_MESSAGES`.

    Appending (not replacing) mirrors LangGraph's ``add_messages``: a node
    returns only its own turn, never the whole thread it read.
    """
    merged = dict(current or {})
    for thread, messages in (update or {}).items():
        merged[thread] = [*(merged.get(thread) or []), *(messages or [])][-MAX_CONVERSATION_MESSAGES:]
    return merged


class WorkflowState(TypedDict):
    """The run's state; every workflow has the same keys (see the module docstring)."""

    input: dict
    vars: Annotated[dict, merge_dicts]
    nodes: Annotated[dict, merge_dicts]
    iterations: Annotated[dict, merge_dicts]
    trace: Annotated[dict, replace_value]
    history: Annotated[list, append_history]
    conversations: Annotated[dict, append_conversations]


def initial_state(spec: WorkflowSpec, inputs: Mapping[str, Any], persisted: Mapping[str, Any]) -> dict:
    """The state a fresh run starts from.

    ``persisted`` is what the previous completed run kept. Only names that are
    still variables some ``end`` step keeps are loaded: a later version may
    have dropped the ``set`` step that wrote one, or stopped keeping it, and a
    value nothing keeps any more must not leak into the run. Every other
    variable starts unwritten (it reads ``null``).
    """
    kept = spec.kept_variables()
    return {
        "input": dict(inputs),
        "vars": {name: persisted[name] for name in kept if name in persisted},
        "nodes": {},
        "iterations": {},
        "trace": {"loops": [], "last": None},
        "history": [],
        "conversations": {},
    }


def variable_values(state: Mapping[str, Any], spec: WorkflowSpec) -> dict[str, Any]:
    """Every variable's current value — the ``state`` template root.

    Every name the spec's ``set`` steps write is present, so a step may read a
    variable before (or without) the ``set`` that writes it: unwritten reads
    ``null``.
    """
    current = state.get("vars") or {}
    return {name: current.get(name) for name in spec.variables()}


def coerce_inputs(spec: WorkflowSpec, raw: Mapping[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """Validate a run's inputs against the declared ones; fill defaults.

    Unknown inputs are refused (the spec is the contract), a required input
    without a default must be present, and every value must match its type.
    Returns ``(values, errors)``.
    """
    declared = {item.name: item for item in spec.inputs}
    errors = [f"Unknown input '{name}'." for name in raw if name not in declared]
    values: dict[str, Any] = {}
    for name, item in declared.items():
        if name in raw and raw[name] is not None:
            value = raw[name]
            if not type_matches(item.type, value):
                errors.append(f"Input '{name}' must be of type {item.type}.")
                continue
            values[name] = value
        elif item.default is not None:
            values[name] = item.default
        elif item.required:
            errors.append(f"Input '{name}' is required.")
        else:
            values[name] = None
    return values, errors


def _escape(token: str) -> str:
    """A JSON Pointer token (RFC 6901)."""
    return token.replace("~", "~0").replace("/", "~1")


def variables_patch(updates: Mapping[str, Any]) -> list[dict[str, Any]]:
    """The JSON Patch a step's variable writes apply to the variables document.

    One ``add`` per written name (``add`` on an existing member replaces it),
    so applying every step's patch in order rebuilds the variables.
    """
    return [{"op": "add", "path": f"/{_escape(name)}", "value": value} for name, value in updates.items()]


__all__ = [
    "FIXED_KEYS",
    "MAX_CONVERSATION_MESSAGES",
    "MAX_HISTORY",
    "WorkflowState",
    "append_conversations",
    "append_history",
    "coerce_inputs",
    "initial_state",
    "merge_dicts",
    "replace_value",
    "variable_values",
    "variables_patch",
]
