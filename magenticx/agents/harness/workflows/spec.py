"""``WorkflowSpec`` v1 — the document a workflow is saved and versioned as.

A workflow is a LangGraph graph described as data: typed run inputs, declared
state fields (each with a reducer), nodes from the closed node catalogue
(``harness/workflows/nodes``) and the edges between them. This module owns only
the *shape* — every model forbids unknown keys, so a typo is an error rather
than a silently ignored field. The graph rules (one trigger, reachability,
loops, template references) live in ``validator.py``, and each node kind
validates its own ``config``.

A workflow is deliberately not an ``AgentSpec`` and not an agent row: it is its
own definition with its own store (``store.py``), and a run of it is not a
conversation.
"""
from __future__ import annotations

import json
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

#: Hard caps. Checked before the nodes are parsed, so an oversized document is
#: refused without paying for its validation.
MAX_NODES = 50
MAX_EDGES = 200
MAX_INPUTS = 32
MAX_STATE_FIELDS = 32
MAX_SPEC_BYTES = 256 * 1024

#: Input and state-field names: identifiers, so they are valid template path
#: segments and valid LangGraph channel names.
NAME_PATTERN = r"^[A-Za-z_][A-Za-z0-9_]{0,63}$"
#: Node ids: no dots (they are a template path segment) and no leading
#: underscore (LangGraph reserves ``__start__`` / ``__end__``).
NODE_ID_PATTERN = r"^[A-Za-z][A-Za-z0-9_-]{0,63}$"
EDGE_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$"
#: Branch names a node can produce (router cases included).
BRANCH_PATTERN = r"^[a-z][a-z0-9_]{0,31}$"

#: State keys the engine itself uses; a declared field (or a node id — LangGraph
#: refuses a node named like a state channel) may not take one.
RESERVED_NAMES = frozenset({"input", "nodes", "iterations", "trace", "state", "output"})

ValueType = Literal["string", "number", "boolean", "object", "array"]
Reducer = Literal["overwrite", "append", "merge"]


class _Strict(BaseModel):
    """Every spec model refuses unknown keys."""

    model_config = ConfigDict(extra="forbid")


class InputSpec(_Strict):
    """One run input, supplied by whoever starts the run (``{{input.<name>}}``)."""

    name: str = Field(pattern=NAME_PATTERN)
    type: ValueType = "string"
    required: bool = False
    default: Any = None
    description: str = Field(default="", max_length=500)


class StateFieldSpec(_Strict):
    """One declared state field (``{{state.<name>}}``).

    ``reducer`` decides how a write combines with the current value:
    ``overwrite`` replaces it, ``append`` adds to an ``array`` field, ``merge``
    shallow-merges into an ``object`` field. ``persist`` fields survive the run:
    loaded at the start of the next run and written when a run completes.
    """

    name: str = Field(pattern=NAME_PATTERN)
    type: ValueType = "string"
    reducer: Reducer = "overwrite"
    default: Any = None
    persist: bool = False


class Position(_Strict):
    """Canvas position — layout only, never read by the engine."""

    x: float = 0.0
    y: float = 0.0


class NodeSpec(_Strict):
    """One node: its id, its kind from the catalogue and the kind's config."""

    id: str = Field(pattern=NODE_ID_PATTERN)
    kind: str = Field(min_length=1, max_length=64)
    label: str | None = Field(default=None, max_length=120)
    config: dict[str, Any] = Field(default_factory=dict)
    position: Position = Field(default_factory=Position)


class EdgeSpec(_Strict):
    """A directed edge. ``branch`` is required exactly when the source branches."""

    id: str = Field(pattern=EDGE_ID_PATTERN)
    source: str = Field(pattern=NODE_ID_PATTERN)
    target: str = Field(pattern=NODE_ID_PATTERN)
    branch: str | None = Field(default=None, pattern=BRANCH_PATTERN)


class WorkflowSpec(_Strict):
    """The whole workflow document, version 1."""

    version: Literal[1]
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=2000)
    inputs: list[InputSpec] = Field(default_factory=list, max_length=MAX_INPUTS)
    state: list[StateFieldSpec] = Field(default_factory=list, max_length=MAX_STATE_FIELDS)
    nodes: list[NodeSpec] = Field(min_length=1, max_length=MAX_NODES)
    edges: list[EdgeSpec] = Field(default_factory=list, max_length=MAX_EDGES)

    @field_validator("name")
    @classmethod
    def _name_is_a_title(cls, value: str) -> str:
        """Every workflow has a title: trimmed, never blank (spaces alone are no name)."""
        title = value.strip()
        if not title:
            raise ValueError("Give the workflow a name.")
        return title

    def node(self, node_id: str) -> NodeSpec | None:
        """The node with this id, or ``None``."""
        return next((n for n in self.nodes if n.id == node_id), None)

    def state_fields(self) -> dict[str, StateFieldSpec]:
        """Declared state fields by name."""
        return {field.name: field for field in self.state}


# ---------------------------------------------------------------------------
# Value types — shared by inputs, state defaults and runtime state writes
# ---------------------------------------------------------------------------
def type_matches(value_type: str, value: Any) -> bool:
    """Whether ``value`` is of the declared JSON type. ``bool`` is not a number."""
    if value_type == "string":
        return isinstance(value, str)
    if value_type == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if value_type == "boolean":
        return isinstance(value, bool)
    if value_type == "object":
        return isinstance(value, dict)
    if value_type == "array":
        return isinstance(value, list)
    return False


def empty_value(value_type: str) -> Any:
    """The zero value of a type — a state field's default when none is declared."""
    return {"string": "", "number": 0, "boolean": False, "object": {}, "array": []}[value_type]


def spec_size_bytes(raw: Any) -> int:
    """The spec's size as compact UTF-8 JSON — what the 256 KiB cap measures."""
    return len(json.dumps(raw, separators=(",", ":"), ensure_ascii=False, default=str).encode("utf-8"))


def canonical_json(raw: Any) -> str:
    """A stable serialization, so "did the spec change?" is a string compare."""
    return json.dumps(raw, separators=(",", ":"), ensure_ascii=False, sort_keys=True)


__all__ = [
    "BRANCH_PATTERN",
    "MAX_EDGES",
    "MAX_INPUTS",
    "MAX_NODES",
    "MAX_SPEC_BYTES",
    "MAX_STATE_FIELDS",
    "NAME_PATTERN",
    "NODE_ID_PATTERN",
    "RESERVED_NAMES",
    "EdgeSpec",
    "InputSpec",
    "NodeSpec",
    "Position",
    "StateFieldSpec",
    "WorkflowSpec",
    "canonical_json",
    "empty_value",
    "spec_size_bytes",
    "type_matches",
]
