"""What a command does to the turn's capabilities — only ever less.

The agent's own tools, gates and write-deny ladder stand as they are; a command
can add restrictions on top, never lift one. The rule lives here, in one place,
so "a command cannot widen access" is one function to read and test.
"""
from __future__ import annotations

from deepagents import FilesystemPermission

from harness.commands.spec import CommandSpec

# Deny every write, everywhere: the agent can still read, list and search.
_DENY_ALL_WRITES = FilesystemPermission(operations=["write"], paths=["/**"], mode="deny")


def command_permissions(spec: CommandSpec | None) -> list[FilesystemPermission]:
    """Extra filesystem rules for a turn running ``spec``; appended to the agent's."""
    if spec is not None and spec.read_only:
        return [_DENY_ALL_WRITES]
    return []
