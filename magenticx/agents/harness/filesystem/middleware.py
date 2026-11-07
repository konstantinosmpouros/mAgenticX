"""The filesystem middleware every deep agent and sub-agent runs, as under deepagents 0.6.x.

deepagents 0.7 changed three things about its ``FilesystemMiddleware`` that
would change what a run can do, so every stack gets this one instead (passed
in a stack, it replaces deepagents' own by name):

* **No ``delete`` tool.** 0.7 adds a recursive ``delete``; a
  ``CompositeBackend`` always advertises it and ``StoreBackend`` honours it, so
  it would reach ``/memories/`` and ``/skills/``. It stays out until it is a
  deliberate, reviewed addition.
* **Uncapped ``grep``** — 0.7 caps it at 1000 matches by default.
* **The write-deny ladder with sandbox execution.** 0.7 refuses permission
  rules outside the mounted routes once the default backend can execute
  (``/reference{,/**}``, a read-only command's ``/**``), because a shell could
  bypass path rules on the same filesystem. Under 0.6.x the check never ran
  against our backend (a factory then). It stays off: the rules guard the
  agent's file tools on the routes, while ``execute`` is a locked approval gate
  at every depth and runs in the separate sandbox runner: the conversation's
  ``input/`` and ``output/`` travel with the call and only ``output/`` is
  written back (see :mod:`harness.filesystem.sandbox_backend`).
"""
from typing import Any

from deepagents import FilesystemPermission
from deepagents.middleware.filesystem import FilesystemMiddleware

#: The filesystem tools every agent and sub-agent is offered — the 0.6.x set.
FILESYSTEM_TOOLS: tuple[str, ...] = ("ls", "read_file", "write_file", "edit_file", "glob", "grep", "execute")


class PlatformFilesystemMiddleware(FilesystemMiddleware):
    """deepagents' filesystem middleware with the 0.6.x permission handling.

    Reports deepagents' own name, so ``create_deep_agent`` puts it in the
    stock middleware's slot instead of adding a second one.
    """

    @property
    def name(self) -> str:
        """deepagents' name, so name-based replacement swaps the stock one for this."""
        return FilesystemMiddleware.__name__

    def _set_permissions(self, permissions: list[FilesystemPermission] | None) -> None:
        """Keep the rules without 0.7's execution-backend scoping check (see module doc)."""
        self._permissions = list(permissions or [])


def filesystem_middleware(backend: Any, permissions: list[FilesystemPermission]) -> PlatformFilesystemMiddleware:
    """The filesystem middleware of every stack: ``backend``, ``permissions``, the 0.6.x tools."""
    return PlatformFilesystemMiddleware(
        backend=backend,
        permissions=permissions,
        tools=list(FILESYSTEM_TOOLS),
        grep_max_count=None,
    )
