"""Structured rules — the only way a workflow branches.

A rule is a triple ``{path, op, value}``: a bare path into the run's data
(``nodes.fetch.output.status``, ``state.attempts`` — the same paths as
templates, without braces), a fixed operator and a literal (which may itself
be a template, resolved before the rule is evaluated). There is no expression
language, so a condition can never execute anything.

Semantics, kept strict on purpose so a mistyped rule fails loudly instead of
quietly taking the wrong branch:

* ``exists`` / ``empty`` treat a missing path as "does not exist" / "empty";
  every other operator raises when its path is missing.
* ``gt``/``gte``/``lt``/``lte`` compare numbers with numbers or strings with
  strings; any other pairing is ``False``.
* ``contains``: substring for strings, membership for arrays, key for objects.
* ``empty``: ``None``, ``""``, ``[]`` or ``{}``.
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from harness.workflows.errors import TemplateError
from harness.workflows.templating import BASE_ROOTS, resolve_path

RuleOp = Literal["eq", "ne", "gt", "gte", "lt", "lte", "contains", "exists", "empty"]
MatchMode = Literal["all", "any"]
MAX_RULES = 20

#: A bare dotted path — braces are refused so a rule path is never templated.
RULE_PATH_PATTERN = r"^[A-Za-z0-9_.-]{1,512}$"

_MISSING = object()


class Rule(BaseModel):
    """One comparison."""

    model_config = ConfigDict(extra="forbid")

    path: str = Field(pattern=RULE_PATH_PATTERN, description="Path to test, e.g. nodes.fetch.output.status")
    op: RuleOp
    value: Any = Field(default=None, description="Literal to compare with (ignored by exists / empty)")


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _ordered(left: Any, right: Any) -> bool:
    """Whether the two can be ordered: number vs number or string vs string."""
    return (_is_number(left) and _is_number(right)) or (isinstance(left, str) and isinstance(right, str))


def _equal(left: Any, right: Any) -> bool:
    """``==`` except that a boolean only equals a boolean (Python has ``True == 1``)."""
    if isinstance(left, bool) or isinstance(right, bool):
        return type(left) is type(right) and left == right
    return left == right


def _is_empty(value: Any) -> bool:
    return value is None or value == "" or value == [] or value == {}


def evaluate_rule(rule: Rule, scope: Mapping[str, Any]) -> bool:
    """Evaluate one rule against the run's data."""
    try:
        actual: Any = resolve_path(rule.path, scope, roots=BASE_ROOTS)
    except TemplateError:
        if rule.op in ("exists", "empty"):
            actual = _MISSING
        else:
            raise
    op, expected = rule.op, rule.value
    if op == "exists":
        return actual is not _MISSING and actual is not None
    if op == "empty":
        return actual is _MISSING or _is_empty(actual)
    if op == "eq":
        return _equal(actual, expected)
    if op == "ne":
        return not _equal(actual, expected)
    if op in ("gt", "gte", "lt", "lte"):
        if not _ordered(actual, expected):
            return False
        return {
            "gt": actual > expected,
            "gte": actual >= expected,
            "lt": actual < expected,
            "lte": actual <= expected,
        }[op]
    if op == "contains":
        if isinstance(actual, str):
            return isinstance(expected, str) and expected in actual
        if isinstance(actual, list):
            return expected in actual
        if isinstance(actual, dict):
            return isinstance(expected, str) and expected in actual
        return False
    return False


def evaluate_rules(rules: list[Rule], mode: MatchMode, scope: Mapping[str, Any]) -> bool:
    """``all`` / ``any`` over a rule list. An empty list is vacuously true for
    ``all`` and false for ``any``."""
    results = (evaluate_rule(rule, scope) for rule in rules)
    return all(results) if mode == "all" else any(results)


__all__ = [
    "MAX_RULES",
    "RULE_PATH_PATTERN",
    "MatchMode",
    "Rule",
    "RuleOp",
    "evaluate_rule",
    "evaluate_rules",
]
