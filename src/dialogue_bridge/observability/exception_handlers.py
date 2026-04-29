from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from slowapi.errors import RateLimitExceeded

from core.error_handling import DialogueBridgeExceptionHandler
from observability.events import get_logger


logger = get_logger("dialogue_bridge.exceptions")
bridge_exception_handler = DialogueBridgeExceptionHandler(logger)


async def _http_exception_handler(request: Request, exc: HTTPException):
    return await bridge_exception_handler.handle_http_exception(request, exc)


async def _validation_exception_handler(request: Request, exc: RequestValidationError):
    return await bridge_exception_handler.handle_validation_exception(request, exc)


async def _unhandled_exception_handler(request: Request, exc: Exception):
    return await bridge_exception_handler.handle_unhandled_exception(request, exc)


async def _rate_limit_exception_handler(request: Request, exc: RateLimitExceeded):
    return await bridge_exception_handler.handle_rate_limit_exception(request, exc)


def register_exception_handlers(app: FastAPI) -> None:
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exception_handler)
    app.add_exception_handler(HTTPException, _http_exception_handler)
    app.add_exception_handler(RequestValidationError, _validation_exception_handler)
    app.add_exception_handler(Exception, _unhandled_exception_handler)
