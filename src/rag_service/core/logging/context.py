from __future__ import annotations

from contextvars import ContextVar
from typing import Any


_REQUEST_CONTEXT: ContextVar[dict[str, Any]] = ContextVar("rag_service_request_context", default={})


def get_context() -> dict[str, Any]:
    return dict(_REQUEST_CONTEXT.get())


def set_context(**values: Any) -> dict[str, Any]:
    current = get_context()
    for key, value in values.items():
        if value is None:
            current.pop(key, None)
        else:
            current[key] = value
    _REQUEST_CONTEXT.set(current)
    return current


def clear_context() -> None:
    _REQUEST_CONTEXT.set({})
