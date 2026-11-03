"""Exception handlers: log where and why a request failed, never what it carried.

A validation error's raw ``input`` can be the whole command, so only the
location and the message are logged; the public body is generic. Unhandled
errors become a bare 500 — no stack trace or internal path reaches the caller.
"""
from __future__ import annotations

import logging

from fastapi import FastAPI, HTTPException, Request, status
from fastapi.exceptions import RequestValidationError
from starlette.responses import JSONResponse

from core.logging.events import get_logger

logger = get_logger("sandbox_runner.exceptions")


async def _http_exception_handler(request: Request, exc: HTTPException) -> JSONResponse:
    """Log an HTTPException at a level matching its class and echo its detail."""
    level = logging.WARNING if exc.status_code < 500 else logging.ERROR
    logger.log(level, "http_exception", "HTTP exception raised", status_code=exc.status_code)
    detail = exc.detail if isinstance(exc.detail, str) and exc.detail.strip() else "Request could not be completed."
    return JSONResponse(status_code=exc.status_code, content={"detail": detail}, headers=exc.headers)


async def _validation_exception_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    """422 with the field locations only — the rejected values are never logged."""
    errors = [
        {"loc": [str(part) for part in err.get("loc", ())], "msg": err.get("msg"), "type": err.get("type")}
        for err in exc.errors()
    ]
    logger.warning("request_validation_failed", "Request validation failed", errors=errors)
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
        content={"detail": "Invalid request.", "errors": errors},
    )


async def _unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """A generic 500; the traceback goes to the log only."""
    logger.exception("unhandled_exception", "Unhandled exception", exception_type=exc.__class__.__name__)
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={"detail": "Something went wrong."},
    )


def register_exception_handlers(app: FastAPI) -> None:
    """Attach the three handlers to the app."""
    app.add_exception_handler(HTTPException, _http_exception_handler)
    app.add_exception_handler(RequestValidationError, _validation_exception_handler)
    app.add_exception_handler(Exception, _unhandled_exception_handler)
