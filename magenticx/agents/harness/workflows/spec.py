"""``WorkflowSpec`` v1 — the document a workflow is saved and versioned as.

A workflow is a LangGraph graph described as data: typed run inputs, nodes from
the closed node catalogue (``harness/workflows/nodes``) and the edges between
them. Variables are not declared: every key a ``set`` step's ``values`` writes
is one (:meth:`WorkflowSpec.variables`), untyped, and a write overwrites. This
module owns only
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

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

#: Hard caps. Checked before the nodes are parsed, so an oversized document is
#: refused without paying for its validation.
MAX_NODES = 50
MAX_EDGES = 200
MAX_INPUTS = 32
MAX_SPEC_BYTES = 256 * 1024

#: Input and variable names: identifiers, so they are valid template path
#: segments.
NAME_PATTERN = r"^[A-Za-z_][A-Za-z0-9_]{0,63}$"
#: Node ids: no dots (they are a template path segment) and no leading
#: underscore (LangGraph reserves ``__start__`` / ``__end__``).
NODE_ID_PATTERN = r"^[A-Za-z][A-Za-z0-9_-]{0,63}$"
EDGE_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$"
#: Branch names a node can produce (router cases included).
BRANCH_PATTERN = r"^[a-z][a-z0-9_]{0,31}$"

#: State keys the engine itself uses (and the template roots); a node id may not
#: take one — LangGraph refuses a node named like a state channel.
RESERVED_NAMES = frozenset(
    {"input", "nodes", "iterations", "trace", "history", "conversations", "vars", "state", "output"}
)
#: The kinds whose config names variables: ``set`` writes them (``values``),
#: ``end`` carries some over to the next run (``keep``).
SET_KIND = "set"
END_KIND = "end"

ValueType = Literal["string", "number", "boolean", "object", "array"]


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
    nodes: list[NodeSpec] = Field(min_length=1, max_length=MAX_NODES)
    edges: list[EdgeSpec] = Field(default_factory=list, max_length=MAX_EDGES)

    @model_validator(mode="before")
    @classmethod
    def _upgrade_legacy(cls, data: Any) -> Any:
        """Read a spec saved before variables were implicit.

        Such a spec declares ``state`` fields and may write them through any
        node's ``assign``. Both are gone: ``state`` is dropped, and every field
        it marked ``persist: true`` is carried over by being added to each
        ``end`` step's ``keep`` (a run that ends elsewhere kept nothing before
        either); every node's ``assign`` is dropped. A value an ``assign`` wrote
        is still in ``nodes.<id>.output``; a template that read it through
        ``state`` now names a variable no ``set`` step writes, which the
        validator reports — so the owner sees what to fix instead of a spec
        that will not load.
        """
        if not isinstance(data, dict) or ("state" not in data and not _any_assign(data.get("nodes"))):
            return data
        data = dict(data)
        legacy_state = data.pop("state", None)
        persisted = [
            field["name"]
            for field in (legacy_state if isinstance(legacy_state, list) else [])
            if isinstance(field, dict) and field.get("persist") is True and isinstance(field.get("name"), str)
        ]
        nodes = data.get("nodes")
        if isinstance(nodes, list):
            data["nodes"] = [_upgrade_legacy_node(node, persisted) for node in nodes]
        return data

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

    def variables(self) -> list[str]:
        """The workflow's variable names: every key of every ``set`` step's
        ``values``, in first-written order.

        Read from the raw configs, so a ``set`` step whose config is otherwise
        invalid still defines its names (its own issue is reported on it).
        """
        names: dict[str, None] = {}
        for node in self.nodes:
            values = node.config.get("values") if node.kind == SET_KIND else None
            if isinstance(values, dict):
                names.update(dict.fromkeys(key for key in values if isinstance(key, str)))
        return list(names)

    def kept_variables(self) -> list[str]:
        """The variables some ``end`` step keeps for the next run (``keep``)."""
        names: dict[str, None] = {}
        for node in self.nodes:
            keep = node.config.get("keep") if node.kind == END_KIND else None
            if isinstance(keep, list):
                names.update(dict.fromkeys(name for name in keep if isinstance(name, str)))
        variables = set(self.variables())
        return [name for name in names if name in variables]


def _any_assign(nodes: Any) -> bool:
    """Whether any raw node config still carries a legacy ``assign``."""
    return isinstance(nodes, list) and any(
        isinstance(node, dict) and isinstance(node.get("config"), dict) and "assign" in node["config"]
        for node in nodes
    )


def _upgrade_legacy_node(node: Any, persisted: list[str]) -> Any:
    """One raw node without its legacy ``assign``; an ``end`` keeps ``persisted``."""
    if not isinstance(node, dict) or not isinstance(node.get("config"), dict):
        return node
    config = {key: value for key, value in node["config"].items() if key != "assign"}
    if node.get("kind") == END_KIND and persisted:
        keep = config.get("keep")
        keep = list(keep) if isinstance(keep, list) else []
        config["keep"] = [*keep, *(name for name in persisted if name not in keep)]
    return {**node, "config": config}


def normalize_spec(raw: Any) -> Any:
    """A stored spec as the API returns it: parsed and dumped, so a legacy one
    comes back without ``state`` or ``assign``.

    Stored specs were dumped from this same model when saved, so a current one
    keeps its exact shape. A document that no longer parses at all is returned
    as stored — the owner must still be able to open it to fix it.
    """
    try:
        return WorkflowSpec.model_validate(raw).model_dump(mode="json")
    except ValidationError:
        return raw


# ---------------------------------------------------------------------------
# Value types — shared by inputs
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


def spec_size_bytes(raw: Any) -> int:
    """The spec's size as compact UTF-8 JSON — what the 256 KiB cap measures."""
    return len(json.dumps(raw, separators=(",", ":"), ensure_ascii=False, default=str).encode("utf-8"))


def canonical_json(raw: Any) -> str:
    """A stable serialization, so "did the spec change?" is a string compare."""
    return json.dumps(raw, separators=(",", ":"), ensure_ascii=False, sort_keys=True)


__all__ = [
    "BRANCH_PATTERN",
    "END_KIND",
    "MAX_EDGES",
    "MAX_INPUTS",
    "MAX_NODES",
    "MAX_SPEC_BYTES",
    "NAME_PATTERN",
    "NODE_ID_PATTERN",
    "RESERVED_NAMES",
    "SET_KIND",
    "EdgeSpec",
    "InputSpec",
    "NodeSpec",
    "Position",
    "WorkflowSpec",
    "canonical_json",
    "normalize_spec",
    "spec_size_bytes",
    "type_matches",
]
