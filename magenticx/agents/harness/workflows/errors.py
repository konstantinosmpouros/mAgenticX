"""Exceptions of the workflow engine.

Every message here is safe to show the workflow's owner: it names a node, a
path or a rule, never a secret, a traceback or a fetched payload. That is what
lets the node wrapper forward them into ``workflow.node_output`` and the run's
``RUN_ERROR`` as they are.
"""
from __future__ import annotations


class TemplateError(ValueError):
    """A ``{{…}}`` placeholder or rule path that is malformed or does not resolve."""

    def __init__(self, message: str, *, path: str | None = None) -> None:
        super().__init__(message)
        self.path = path


class NodeExecutionError(RuntimeError):
    """A node failed for a reason it can state (a blocked URL, a tool error…).

    ``code`` is a short machine-readable reason the UI can key on.
    """

    def __init__(self, message: str, *, code: str = "node_error") -> None:
        super().__init__(message)
        self.code = code


class WorkflowNodeError(RuntimeError):
    """Raised by the node wrapper after it has streamed a node's failure.

    It ends the run: the runner turns it into ``RUN_ERROR`` naming the node.
    """

    def __init__(self, node_id: str, message: str, *, code: str) -> None:
        super().__init__(f"Node '{node_id}' failed: {message}")
        self.node_id = node_id
        self.message = message
        self.code = code


class WorkflowSpecInvalid(ValueError):
    """A spec that fails validation reached a place that needs a valid one."""


__all__ = [
    "NodeExecutionError",
    "TemplateError",
    "WorkflowNodeError",
    "WorkflowSpecInvalid",
]
