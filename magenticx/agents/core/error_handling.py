import json
import logging
from typing import Any, NoReturn

from fastapi import HTTPException, Request, status
from fastapi.exceptions import RequestValidationError
from starlette.responses import JSONResponse


class AgentServiceExceptionHandler:

    def __init__(self, logger: Any):
        self._logger = logger


    async def handle_http_exception(self, request: Request, exc: HTTPException) -> JSONResponse:
        level = logging.WARNING if exc.status_code < 500 else logging.ERROR
        self._logger.log(
            level,
            "http_exception",
            "HTTP exception raised",
            exc_info=exc.status_code >= 500,
            status_code=exc.status_code,
            detail=exc.detail if exc.status_code >= 500 else None,
        )
        return JSONResponse(
            status_code=exc.status_code,
            content={"detail": self._public_http_detail(exc)},
            headers=exc.headers,
        )


    async def handle_validation_exception(self, request: Request, exc: RequestValidationError) -> JSONResponse:
        self._logger.warning(
            "request_validation_failed",
            "Request validation failed",
            errors=exc.errors(include_input=False),
        )
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            content={"detail": "Invalid request. Please check the submitted fields and try again."},
        )


    async def handle_unhandled_exception(self, request: Request, exc: Exception) -> JSONResponse:
        self._logger.exception(
            "unhandled_exception",
            "Unhandled exception raised during request processing",
            exception_type=exc.__class__.__name__,
        )
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={"detail": "Something went wrong. Please try again."},
        )


    @staticmethod
    def _public_http_detail(exc: HTTPException) -> str:
        if isinstance(exc.detail, str) and exc.detail.strip():
            return exc.detail
        return "Request could not be completed. Please try again."


class ProviderErrorHandler:

    def raise_provider_error(
        self,
        logger: Any,
        exc: Exception,
        *,
        event: str,
        message: str,
        public_detail: str,
        provider: str,
        operation: str,
        **fields: Any,
    ) -> NoReturn:
        logger.warning(
            event,
            message,
            exc_info=True,
            provider=provider,
            operation=operation,
            failure_reason="provider_request_failed",
            **fields,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=public_detail,
        ) from exc


    def raise_invalid_response(
        self,
        logger: Any,
        *,
        event: str,
        message: str,
        public_detail: str,
        provider: str,
        operation: str,
        **fields: Any,
    ) -> NoReturn:
        logger.error(
            event,
            message,
            provider=provider,
            operation=operation,
            failure_reason="invalid_provider_response",
            **fields,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=public_detail,
        )


class AgentStreamErrorHandler:

    def encode_run_error(
        self,
        logger: Any,
        exc: BaseException,
        *,
        agent_slug: str,
        public_message: str = "The agent could not complete this run. Please try again.",
    ) -> bytes:
        logger.error(
            "agent_run_error",
            "Agent run failed",
            exc_info=True,
            agent_slug=agent_slug,
            exception_type=type(exc).__name__,
        )
        err = {"type": "RUN_ERROR", "message": public_message}
        return ("data: " + json.dumps(err) + "\n\n").encode("utf-8")


provider_error_handler = ProviderErrorHandler()
agent_stream_error_handler = AgentStreamErrorHandler()
