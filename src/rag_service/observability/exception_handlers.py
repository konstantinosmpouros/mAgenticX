from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError

from core.error_handling import RagServiceExceptionHandler
from observability.events import get_logger


logger = get_logger("rag_service.exceptions")
rag_exception_handler = RagServiceExceptionHandler(logger)


async def _http_exception_handler(request: Request, exc: HTTPException):
    return await rag_exception_handler.handle_http_exception(request, exc)


async def _validation_exception_handler(request: Request, exc: RequestValidationError):
    return await rag_exception_handler.handle_validation_exception(request, exc)


async def _unhandled_exception_handler(request: Request, exc: Exception):
    return await rag_exception_handler.handle_unhandled_exception(request, exc)


def register_exception_handlers(app: FastAPI) -> None:
    app.add_exception_handler(HTTPException, _http_exception_handler)
    app.add_exception_handler(RequestValidationError, _validation_exception_handler)
    app.add_exception_handler(Exception, _unhandled_exception_handler)
