"""Path substitution for node configs — ``{{input.x}}``, ``{{state.x}}``,
``{{nodes.<id>.output.<path>}}``, ``{{nodes.<id>.outputs.<n>.<path>}}``.

This is the only way data moves between nodes, and it is deliberately not a
template language: no expressions, no filters, no Jinja, no ``eval``. A
placeholder is a dotted path, looked up segment by segment in plain dicts and
lists. That closes the injection surface workflow engines usually have — a
fetched page or a tool result that contains ``{{state.secret}}`` is substituted
as text, once, and never rendered again.

Rules:

* Only **string** values are templated (recursively through dicts and lists);
  keys, numbers and booleans are left alone.
* A string that is **exactly one** placeholder becomes the referenced value
  with its type kept (an object stays an object). A placeholder embedded in
  other text is stringified — JSON for objects and arrays.
* A path that does not resolve is a :class:`TemplateError` naming the path;
  the node wrapper reports it against the node.

Roots: ``input`` (run inputs), ``state`` (the workflow's variables — every
name a ``set`` step writes; one not written yet is ``null``) and ``nodes``
(``nodes.<id>.output…`` — each node's latest output; ``nodes.<id>.outputs…`` —
the list of its outputs from every execution this run, oldest first, so a step
after a loop can read each iteration of a step inside it).
"""
from __future__ import annotations

import copy
import json
import re
from collections.abc import Iterable, Iterator, Mapping
from dataclasses import dataclass
from typing import Any

from harness.workflows.errors import TemplateError

#: ``{{ path }}`` — the inside may not contain braces, so placeholders never nest.
PLACEHOLDER = re.compile(r"\{\{\s*([^{}]*?)\s*\}\}")
_SEGMENT = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
MAX_SEGMENTS = 16

BASE_ROOTS = ("input", "state", "nodes")
#: What a ``nodes.<id>`` path may read: the latest output, or every execution's.
NODE_DATA_KEYS = ("output", "outputs")


@dataclass(frozen=True)
class Reference:
    """A parsed path: its root and every segment after it."""

    root: str
    segments: tuple[str, ...]

    @property
    def text(self) -> str:
        return ".".join((self.root, *self.segments))

    @property
    def node_id(self) -> str | None:
        """For a ``nodes.<id>.output…`` / ``nodes.<id>.outputs…`` path, the node it reads."""
        return self.segments[0] if self.root == "nodes" else None

    @property
    def name(self) -> str | None:
        """For an ``input.<name>`` / ``state.<name>`` path, the name it reads."""
        return self.segments[0] if self.root in ("input", "state") and self.segments else None


def parse_path(expr: str, *, roots: Iterable[str] = BASE_ROOTS) -> Reference:
    """Parse a dotted path, refusing anything that is not one.

    ``nodes`` paths must read a node's ``output`` (``nodes.<id>.output[.<path>]``)
    or ``outputs`` (``nodes.<id>.outputs[.<n>[.<path>]]``) — the rest of a
    node's record is engine bookkeeping, not data.
    """
    allowed = tuple(roots)
    parts = expr.strip().split(".")
    if not parts or len(parts) > MAX_SEGMENTS + 1 or not all(_SEGMENT.match(p) for p in parts):
        raise TemplateError(f"'{expr}' is not a valid path.", path=expr)
    root, segments = parts[0], tuple(parts[1:])
    if root not in allowed:
        raise TemplateError(
            f"'{expr}' must start with one of: {', '.join(allowed)}.", path=expr
        )
    if root in ("input", "state") and not segments:
        raise TemplateError(f"'{expr}' must name a field ({root}.<name>).", path=expr)
    if root == "nodes" and (len(segments) < 2 or segments[1] not in NODE_DATA_KEYS):
        raise TemplateError(
            f"'{expr}' must read a node's output: nodes.<id>.output or nodes.<id>.outputs.", path=expr
        )
    return Reference(root=root, segments=segments)


def iter_strings(value: Any) -> Iterator[str]:
    """Every string inside a config value (dict values and list items, not keys)."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, Mapping):
        for item in value.values():
            yield from iter_strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from iter_strings(item)


def find_references(value: Any, *, roots: Iterable[str] = BASE_ROOTS) -> list[Reference]:
    """Every placeholder path in a config value, parsed. Raises on a bad one."""
    allowed = tuple(roots)
    return [
        parse_path(match.group(1), roots=allowed)
        for text in iter_strings(value)
        for match in PLACEHOLDER.finditer(text)
    ]


def lookup(ref: Reference, scope: Mapping[str, Any]) -> Any:
    """Walk a reference through ``scope``. Missing at any step is an error.

    Dicts are read by key and lists by a decimal index; nothing else is
    traversed (no attribute access, no calls).
    """
    if ref.root not in scope:
        raise TemplateError(f"'{ref.text}' does not resolve: no {ref.root} here.", path=ref.text)
    current: Any = scope[ref.root]
    for depth, segment in enumerate(ref.segments):
        where = ".".join((ref.root, *ref.segments[: depth + 1]))
        if isinstance(current, Mapping):
            if segment not in current:
                raise TemplateError(f"'{ref.text}' does not resolve: '{where}' is missing.", path=ref.text)
            current = current[segment]
        elif isinstance(current, list):
            if not segment.isdigit() or int(segment) >= len(current):
                raise TemplateError(f"'{ref.text}' does not resolve: '{where}' is out of range.", path=ref.text)
            current = current[int(segment)]
        else:
            raise TemplateError(f"'{ref.text}' does not resolve: '{where}' is not an object or array.", path=ref.text)
    return current


def resolve_path(expr: str, scope: Mapping[str, Any], *, roots: Iterable[str] = BASE_ROOTS) -> Any:
    """Parse and look up one bare path (a rule's ``path``)."""
    return lookup(parse_path(expr, roots=roots), scope)


def stringify(value: Any) -> str:
    """How a value reads when embedded in text."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float)):
        return str(value)
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str)


def render(value: Any, scope: Mapping[str, Any], *, roots: Iterable[str] = BASE_ROOTS) -> Any:
    """Substitute every placeholder in ``value``; returns a new value.

    Single pass by construction (``re.sub`` with a function never rescans what
    it inserted), so substituted text is never itself rendered.
    """
    allowed = tuple(roots)
    if isinstance(value, str):
        whole = PLACEHOLDER.fullmatch(value)
        if whole is not None:
            # Deep copy: the result goes into a node's config and output, and
            # must never alias a live state object.
            return copy.deepcopy(lookup(parse_path(whole.group(1), roots=allowed), scope))
        return PLACEHOLDER.sub(
            lambda m: stringify(lookup(parse_path(m.group(1), roots=allowed), scope)), value
        )
    if isinstance(value, Mapping):
        return {key: render(item, scope, roots=allowed) for key, item in value.items()}
    if isinstance(value, list):
        return [render(item, scope, roots=allowed) for item in value]
    return value


__all__ = [
    "BASE_ROOTS",
    "NODE_DATA_KEYS",
    "PLACEHOLDER",
    "Reference",
    "find_references",
    "iter_strings",
    "lookup",
    "parse_path",
    "render",
    "resolve_path",
    "stringify",
]
