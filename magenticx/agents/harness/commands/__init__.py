"""Slash commands (plan 35): what they are, which an agent offers, how a turn applies one.

* :mod:`spec` — ``CommandSpec`` and the ``COMMAND.md`` format (frontmatter + body).
* :mod:`registry` — the built-in commands (``builtin/<name>/COMMAND.md``), the
  same for every agent; availability per agent; checking an invocation.
* :mod:`render` — the user message the model receives: the platform's
  instruction, then the user's text fenced as data.
* :mod:`policy` — what a command takes away from the turn (``read-only``); it
  can never add a capability.

An ``action`` (``/compact``, ``/new`` …) runs in the app and never reaches a
run; a ``prompt`` command rewrites that one turn and nothing after it.
"""
from harness.commands.policy import command_permissions
from harness.commands.registry import (
    AgentFacts,
    CommandInvocation,
    CommandRefused,
    builtin_commands,
    list_commands,
    lookup_command,
    resolve_invocation,
)
from harness.commands.render import apply_command, render_command
from harness.commands.spec import CommandFileError, CommandSpec, parse_command_md

__all__ = [
    "AgentFacts",
    "CommandFileError",
    "CommandInvocation",
    "CommandRefused",
    "CommandSpec",
    "apply_command",
    "builtin_commands",
    "command_permissions",
    "list_commands",
    "lookup_command",
    "parse_command_md",
    "render_command",
    "resolve_invocation",
]
