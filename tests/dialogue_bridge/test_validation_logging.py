"""A request that fails validation is a 422 — and its input never reaches a log.

``RequestValidationError.errors()`` takes no arguments; the handler used to call
it with pydantic's ``include_input=False``, hit a ``TypeError``, and fall back to
the plain call — whose entries carry the raw ``input``. A malformed login or
token body would therefore have written the secret it carried into the logs.
(The agents service had the same call without the fallback, so every 422 there
was a 500; both are pinned by the plan-30 tests.)
"""
from __future__ import annotations

import pytest
from fastapi.exceptions import RequestValidationError

from core.error_handling import DialogueBridgeExceptionHandler


class _RecordingLogger:
    def __init__(self):
        self.warnings: list[tuple[str, dict]] = []

    def warning(self, event, message, **fields):
        self.warnings.append((event, fields))


@pytest.mark.asyncio
async def test_a_validation_error_is_a_422_and_logs_no_input():
    logger = _RecordingLogger()
    handler = DialogueBridgeExceptionHandler(logger)
    exc = RequestValidationError([{
        "type": "string_too_long",
        "loc": ("body", "refresh_token"),
        "msg": "String should have at most 10 characters",
        "input": "super-secret-token-value",
        "ctx": {"max_length": 10},
    }])

    response = await handler.handle_validation_exception(None, exc)

    assert response.status_code == 422
    [(event, fields)] = logger.warnings
    assert event == "request_validation_failed"
    assert fields["errors"] == [{
        "loc": ["body", "refresh_token"],
        "msg": "String should have at most 10 characters",
        "type": "string_too_long",
    }]
    assert "super-secret-token-value" not in repr(logger.warnings)
