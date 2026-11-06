"""The LangGraph state of a workflow run, built from the spec.

The state is a ``TypedDict`` assembled at compile time: one key per declared
state field, each ``Annotated`` with the reducer the spec chose, plus six
fixed keys the engine owns:

``input``          the run's validated inputs (written once, at start)
``nodes``          ``{node_id: {"output", "outputs", "branch", "executionId"}}`` —
                   each node's latest result (``output``) and the outputs of
                   its every execution this run (``outputs``, oldest first,
                   capped), merged per node
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

Checkpoints written before ``history`` / ``conversations`` / ``outputs``
existed lack them, so every read goes through ``.get(...) or <empty>``.

Everything here is plain JSON data, so it checkpoints under the strict msgpack
allow-list and replays identically.
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Annotated, Any, TypedDict

from harness.workflows.errors import NodeExecutionError
from harness.workflows.spec import StateFieldSpec, WorkflowSpec, empty_value, type_matches

FIXED_KEYS = ("input", "nodes", "iterations", "trace", "history", "conversations")

#: Newest executions kept in ``history`` — enough for every step of a long
#: looped run, bounded so the checkpoint stays small.
MAX_HISTORY = 500
#: Newest messages kept per conversation thread (a user/assistant pair per turn).
MAX_CONVERSATION_MESSAGES = 100


def merge_dicts(current: dict | None, update: dict | None) -> dict:
    """Shallow merge — the reducer of ``merge`` fields, ``nodes`` and ``iterations``."""
    return {**(current or {}), **(update or {})}


def replace_value(current: Any, update: Any) -> Any:
    """The reducer of ``overwrite`` fields and of ``trace``: the update wins.

    A reducer (not LangGraph's plain last-value channel) because steps on
    parallel paths finish in the same superstep, and a plain channel refuses
    two writes in one step. Two parallel steps writing the same field: one of
    them wins (unordered) — collect from parallel paths with an ``append`` or
    ``merge`` field instead.
    """
    return update


def append_items(current: list | None, update: Any) -> list:
    """The reducer of ``append`` fields: a list extends, anything else is one item."""
    items = update if isinstance(update, list) else [update]
    return [*(current or []), *items]


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


def build_state_type(spec: WorkflowSpec) -> type:
    """The run's state ``TypedDict``, with each declared field's reducer."""
    annotations: dict[str, Any] = {
        "input": dict,
        "nodes": Annotated[dict, merge_dicts],
        "iterations": Annotated[dict, merge_dicts],
        "trace": Annotated[dict, replace_value],
        "history": Annotated[list, append_history],
        "conversations": Annotated[dict, append_conversations],
    }
    for field in spec.state:
        if field.reducer == "append":
            annotations[field.name] = Annotated[list, append_items]
        elif field.reducer == "merge":
            annotations[field.name] = Annotated[dict, merge_dicts]
        else:
            annotations[field.name] = Annotated[Any, replace_value]
    return TypedDict("WorkflowState", annotations)  # type: ignore[operator]


def field_default(field: StateFieldSpec) -> Any:
    """A field's starting value: its declared default, else its type's zero value."""
    return field.default if field.default is not None else empty_value(field.type)


def initial_state(spec: WorkflowSpec, inputs: Mapping[str, Any], persisted: Mapping[str, Any]) -> dict:
    """The state a fresh run starts from.

    Persisted values (``persist: true`` fields from the previous completed run)
    win over defaults, but only when they still fit the field's declared type —
    a later version may have changed it, and a stale value of the wrong type
    must not leak into the run.
    """
    state: dict[str, Any] = {
        "input": dict(inputs),
        "nodes": {},
        "iterations": {},
        "trace": {"loops": [], "last": None},
        "history": [],
        "conversations": {},
    }
    for field in spec.state:
        value = field_default(field)
        if field.persist and field.name in persisted and type_matches(field.type, persisted[field.name]):
            value = persisted[field.name]
        state[field.name] = value
    return state


def declared_values(state: Mapping[str, Any], spec: WorkflowSpec) -> dict[str, Any]:
    """The declared fields' current values — the ``state`` template root."""
    return {field.name: state.get(field.name, field_default(field)) for field in spec.state}


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


def check_state_write(field: StateFieldSpec, value: Any) -> None:
    """Refuse a write that does not fit the field — a node error, not a crash
    deep inside a reducer."""
    if field.reducer == "append":
        return  # any item may be appended; the field itself is always an array
    if field.reducer == "merge":
        if not isinstance(value, dict):
            raise NodeExecutionError(
                f"State field '{field.name}' merges objects; got {type(value).__name__}.", code="state"
            )
        return
    if not type_matches(field.type, value):
        raise NodeExecutionError(
            f"State field '{field.name}' is of type {field.type}; got {type(value).__name__}.", code="state"
        )


def _escape(token: str) -> str:
    """A JSON Pointer token (RFC 6901)."""
    return token.replace("~", "~0").replace("/", "~1")


def state_patch(updates: Mapping[str, Any], fields: Mapping[str, StateFieldSpec]) -> list[dict[str, Any]]:
    """The JSON Patch a node's writes apply to the declared-state document.

    Mirrors the reducers, so applying the patches in order rebuilds the state:
    ``overwrite`` is an ``add`` of the field (which replaces), ``append`` adds
    each item at ``/-``, ``merge`` adds each key.
    """
    ops: list[dict[str, Any]] = []
    for name, value in updates.items():
        field = fields[name]
        base = f"/{_escape(name)}"
        if field.reducer == "append":
            for item in value if isinstance(value, list) else [value]:
                ops.append({"op": "add", "path": f"{base}/-", "value": item})
        elif field.reducer == "merge":
            for key, item in value.items():
                ops.append({"op": "add", "path": f"{base}/{_escape(str(key))}", "value": item})
        else:
            ops.append({"op": "add", "path": base, "value": value})
    return ops


__all__ = [
    "FIXED_KEYS",
    "MAX_CONVERSATION_MESSAGES",
    "MAX_HISTORY",
    "append_conversations",
    "append_history",
    "append_items",
    "build_state_type",
    "check_state_write",
    "coerce_inputs",
    "declared_values",
    "field_default",
    "initial_state",
    "merge_dicts",
    "replace_value",
    "state_patch",
]
