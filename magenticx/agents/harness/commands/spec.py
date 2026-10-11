"""What a slash command is, and how one is read from its ``COMMAND.md``.

A command file is YAML frontmatter plus a Markdown body — the same shape as a
skill's ``SKILL.md``, so one format serves built-in commands and (later) skills
that opt in. For a ``prompt`` command the body is the instruction the model
receives; an ``action`` runs in the app and has no body.

```markdown
---
name: code-review
description: Review code without changing anything
kind: prompt
argument-hint: "[what to review]"
requires: []
read-only: true
---
Review the code the user points at…
```
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Literal

import yaml

CommandKind = Literal["action", "prompt"]

#: What a command may require of the agent it runs on. Each maps to a fact the
#: catalog can check: a deep agent (a filesystem and the platform tools), the
#: memory tools (``use_memory``), the past-conversation search
#: (``search_past_convs``).
Requirement = Literal["deep_agent", "memory", "past_conversations"]
_REQUIREMENTS: frozenset[str] = frozenset({"deep_agent", "memory", "past_conversations"})

#: A command name: what follows the ``/``. Lowercase words joined by hyphens.
NAME_PATTERN = re.compile(r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$")
_MAX_NAME = 40
_MAX_DESCRIPTION = 160
_MAX_HINT = 60
_MAX_BODY = 8_000

_FRONTMATTER = re.compile(r"\A---\s*\n(.*?)\n---\s*\n?(.*)\Z", re.DOTALL)


class CommandFileError(ValueError):
    """A ``COMMAND.md`` that cannot be a command — raised at load, never at run time."""


@dataclass(frozen=True)
class CommandSpec:
    """One slash command, as the catalog lists it and a run applies it.

    ``read_only`` makes the turn unable to write files (a deny rule over the
    whole filesystem, added to the agent's own) — a command can only ever take
    capabilities away, never add any.
    """

    name: str
    description: str
    kind: CommandKind
    instruction: str = ""
    argument_hint: str = ""
    requires: frozenset[Requirement] = field(default_factory=frozenset)
    read_only: bool = False
    source: str = "builtin"


def _text(meta: dict, key: str, limit: int, *, required: bool = False) -> str:
    value = meta.get(key, "")
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise CommandFileError(f"'{key}' must be text.")
    value = " ".join(value.split())
    if required and not value:
        raise CommandFileError(f"'{key}' is required.")
    if len(value) > limit:
        raise CommandFileError(f"'{key}' is longer than {limit} characters.")
    return value


def parse_command_md(text: str, *, source: str = "builtin") -> CommandSpec:
    """Read one ``COMMAND.md``. Strict: an unknown kind, requirement or key is an error,
    so a typo can never silently turn a command into a different one."""
    match = _FRONTMATTER.match(text or "")
    if not match:
        raise CommandFileError("Missing the '---' frontmatter block.")
    try:
        meta = yaml.safe_load(match.group(1)) or {}
    except yaml.YAMLError as exc:
        raise CommandFileError(f"Invalid frontmatter: {exc}") from exc
    if not isinstance(meta, dict):
        raise CommandFileError("The frontmatter must be a mapping.")
    unknown = set(meta) - {"name", "description", "kind", "argument-hint", "requires", "read-only"}
    if unknown:
        raise CommandFileError(f"Unknown keys: {', '.join(sorted(unknown))}.")

    name = _text(meta, "name", _MAX_NAME, required=True)
    if not NAME_PATTERN.match(name):
        raise CommandFileError(f"'{name}' is not a command name (lowercase words joined by hyphens).")
    kind = meta.get("kind")
    if kind not in ("action", "prompt"):
        raise CommandFileError("'kind' must be 'action' or 'prompt'.")
    requires = meta.get("requires") or []
    if not isinstance(requires, list) or not set(requires) <= _REQUIREMENTS:
        raise CommandFileError(f"'requires' may only list: {', '.join(sorted(_REQUIREMENTS))}.")
    read_only = meta.get("read-only", False)
    if not isinstance(read_only, bool):
        raise CommandFileError("'read-only' must be true or false.")

    instruction = match.group(2).strip()
    if kind == "prompt" and not instruction:
        raise CommandFileError("A prompt command needs its instruction as the body.")
    if kind == "action" and (instruction or read_only):
        raise CommandFileError("An action runs in the app: no body, no 'read-only'.")
    if len(instruction) > _MAX_BODY:
        raise CommandFileError(f"The instruction is longer than {_MAX_BODY} characters.")

    return CommandSpec(
        name=name,
        description=_text(meta, "description", _MAX_DESCRIPTION, required=True),
        kind=kind,
        instruction=instruction,
        argument_hint=_text(meta, "argument-hint", _MAX_HINT),
        requires=frozenset(requires),
        read_only=read_only,
        source=source,
    )
