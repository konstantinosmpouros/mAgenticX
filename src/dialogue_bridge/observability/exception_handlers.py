from __future__ import annotations

import logging

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.exception_handlers import (
    http_exception_handler,
    request_validation_exception_handler,
)
from starlette.responses import JSONResponse

from observability.events import log_event


logger = logging.getLogger("dialogue_bridge.exceptions")


async def _http_exception_handler(request: Request, exc: HTTPException):
    level = logging.WARNING if exc.status_code < 500 else logging.ERROR
    log_event(
        logger,
        level,
        "http_exception",
        "HTTP exception raised",
        status_code=exc.status_code,
        detail=exc.detail,
    )
    return await http_exception_handler(request, exc)


async def _validation_exception_handler(request: Request, exc: RequestValidationError):
    log_event(
        logger,
        logging.WARNING,
        "request_validation_failed",
        "Request validation failed",
        errors=exc.errors(),
    )
    return await request_validation_exception_handler(request, exc)


async def _unhandled_exception_handler(request: Request, exc: Exception):
    logger.exception(
        "Unhandled exception raised during request processing",
        extra={"event": "unhandled_exception", "event_data": {"exception_type": exc.__class__.__name__}},
    )
    return JSONResponse(status_code=500, content={"detail": "Internal server error."})


def register_exception_handlers(app: FastAPI) -> None:
    app.add_exception_handler(HTTPException, _http_exception_handler)
    app.add_exception_handler(RequestValidationError, _validation_exception_handler)
    app.add_exception_handler(Exception, _unhandled_exception_handler)
