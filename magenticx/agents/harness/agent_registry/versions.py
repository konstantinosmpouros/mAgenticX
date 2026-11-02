"""What changed between two saves of a user-authored agent.

The version history keeps a whole copy of the agent on every save; this names
the parts of it a save touched, in the words the History tab shows — so the
list reads "instructions, tools" rather than a diff the user has to open to
find out. It is computed once, when the version is written, and stored with it:
a later reader never re-derives it from two snapshots that may by then be
pruned.

Pure functions over plain data — a spec dict and ``{path: (content, encoding)}``
— so they are tested without a database.
"""
from __future__ import annotations

from typing import Any

#: How many versions of one agent are kept. The oldest goes when a save makes one more.
MAX_VERSIONS = 20

#: Why a version exists. ``baseline`` is the agent as it stood before history
#: began: recorded on the first save after the feature shipped, so that save's
#: own changes can be compared and undone.
KINDS = ("created", "saved", "restored", "baseline")

#: The parts of an agent, in the order the History tab lists them.
CHANGE_ORDER = ("details", "instructions", "model", "tools", "skills", "team", "files", "settings")

# Spec keys each part covers; whatever is left over counts as ``settings``.
_DETAIL_KEYS = ("name", "description", "icon")
_TOOL_KEYS = ("tools", "hitl")
_HANDLED_KEYS = frozenset((*_DETAIL_KEYS, *_TOOL_KEYS, "prompt", "model", "skills", "subagents"))
# Bookkeeping the builder may rewrite on any save; never a change of its own.
_IGNORED_KEYS = frozenset(("id", "version", "type", "slug"))

_SUBAGENT_DIR = "subagents/"

Files = dict[str, tuple[str, str]]


def _prompt_path(spec: dict[str, Any]) -> str:
    """The main prompt's file, as a stored path (``./AGENT.md`` → ``AGENT.md``)."""
    raw = spec.get("prompt")
    return raw[2:] if isinstance(raw, str) and raw.startswith("./") else str(raw or "")


def _subagent_models(spec: dict[str, Any]) -> Any:
    model = spec.get("model")
    return model.get("subagents") if isinstance(model, dict) else None


def _main_model(spec: dict[str, Any]) -> Any:
    model = spec.get("model")
    return model.get("main") if isinstance(model, dict) else model


def _split_files(spec: dict[str, Any], files: Files) -> tuple[Any, Files, Files]:
    """``(main prompt, sub-agent prompts, everything else)``."""
    main_path = _prompt_path(spec)
    main = files.get(main_path, spec.get("prompt"))
    team = {path: body for path, body in files.items() if path.startswith(_SUBAGENT_DIR)}
    rest = {
        path: body
        for path, body in files.items()
        if path != main_path and not path.startswith(_SUBAGENT_DIR)
    }
    return main, team, rest


def describe_changes(
    before: tuple[dict[str, Any], Files], after: tuple[dict[str, Any], Files]
) -> list[str]:
    """The parts of the agent that differ, in :data:`CHANGE_ORDER`; empty when none do."""
    old_spec, old_files = before
    new_spec, new_files = after
    old_main, old_team, old_rest = _split_files(old_spec, old_files)
    new_main, new_team, new_rest = _split_files(new_spec, new_files)

    def differs(*keys: str) -> bool:
        return any(old_spec.get(key) != new_spec.get(key) for key in keys)

    found = {
        "details": differs(*_DETAIL_KEYS),
        "instructions": old_main != new_main,
        "model": _main_model(old_spec) != _main_model(new_spec),
        "tools": differs(*_TOOL_KEYS),
        "skills": differs("skills"),
        "team": (
            differs("subagents")
            or old_team != new_team
            or _subagent_models(old_spec) != _subagent_models(new_spec)
        ),
        "files": old_rest != new_rest,
        "settings": any(
            old_spec.get(key) != new_spec.get(key)
            for key in (set(old_spec) | set(new_spec)) - _HANDLED_KEYS - _IGNORED_KEYS
        ),
    }
    return [part for part in CHANGE_ORDER if found[part]]


__all__ = ["CHANGE_ORDER", "KINDS", "MAX_VERSIONS", "describe_changes"]
