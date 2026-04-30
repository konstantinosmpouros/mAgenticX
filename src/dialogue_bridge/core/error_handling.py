import asyncio
from typing import Any, Awaitable, Callable, NoReturn, TypeVar

import httpx
from fastapi import HTTPException, Request, status
from fastapi.exceptions import RequestValidationError
from slowapi.errors import RateLimitExceeded
from starlette.responses import JSONResponse


T = TypeVar("T")


class DialogueBridgeExceptionHandler:

    def __init__(self, logger: Any):
        self._logger = logger


    async def handle_http_exception(self, request: Request, exc: HTTPException) -> JSONResponse:
        level = "warning" if exc.status_code < 500 else "error"
        log = getattr(self._logger, level)
        log(
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
        try:
            errors = exc.errors(include_input=False)
        except TypeError:
            errors = exc.errors()
        self._logger.warning(
            "request_validation_failed",
            "Request validation failed",
            errors=errors,
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


    async def handle_rate_limit_exception(self, request: Request, exc: RateLimitExceeded) -> JSONResponse:
        self._logger.warning(
            "rate_limit_exceeded",
            "Rate limit exceeded",
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            limit=getattr(exc, "detail", None),
        )
        return JSONResponse(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            content={"detail": "Too many requests. Please wait and try again."},
        )


    @staticmethod
    def _public_http_detail(exc: HTTPException) -> str:
        if isinstance(exc.detail, str) and exc.detail.strip():
            return exc.detail
        return "Request could not be completed. Please try again."


class UpstreamErrorHandler:

    async def run_with_retries(
        self,
        logger: Any,
        operation_fn: Callable[[], Awaitable[T]],
        *,
        upstream_service: str,
        operation: str,
        attempts: int = 2,
        retry_delay_seconds: float = 0.2,
    ) -> T:
        if attempts < 1:
            raise ValueError("attempts must be greater than zero.")

        for attempt in range(1, attempts + 1):
            try:
                return await operation_fn()
            except httpx.RequestError:
                if attempt >= attempts:
                    raise
                logger.warning(
                    "upstream_request_retrying",
                    "Retrying upstream request after transport error",
                    exc_info=True,
                    upstream_service=upstream_service,
                    operation=operation,
                    attempt=attempt,
                    attempts=attempts,
                    retry_delay_seconds=retry_delay_seconds,
                    failure_reason="upstream_request_error",
                )
                await asyncio.sleep(retry_delay_seconds)

        raise RuntimeError("unreachable retry state")


    def raise_http_error(
        self,
        logger: Any,
        exc: httpx.HTTPStatusError,
        *,
        event: str,
        message: str,
        public_detail: str,
        upstream_service: str,
        operation: str,
    ) -> NoReturn:
        logger.warning(
            event,
            message,
            exc_info=True,
            upstream_service=upstream_service,
            operation=operation,
            status_code=exc.response.status_code,
            failure_reason="upstream_http_error",
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=public_detail,
        ) from exc


    def raise_request_error(
        self,
        logger: Any,
        exc: httpx.RequestError,
        *,
        event: str,
        message: str,
        public_detail: str,
        upstream_service: str,
        operation: str,
    ) -> NoReturn:
        self.log_request_error(
            logger,
            exc,
            event=event,
            message=message,
            upstream_service=upstream_service,
            operation=operation,
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=public_detail,
        ) from exc


    def raise_invalid_response(
        self,
        logger: Any,
        exc: Exception | None = None,
        *,
        event: str,
        message: str,
        public_detail: str,
        upstream_service: str,
        operation: str,
        **fields: Any,
    ) -> NoReturn:
        self.log_invalid_response(
            logger,
            exc,
            event=event,
            message=message,
            upstream_service=upstream_service,
            operation=operation,
            **fields,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=public_detail,
        ) from exc


    def log_request_error(
        self,
        logger: Any,
        exc: httpx.RequestError,
        *,
        event: str,
        message: str,
        upstream_service: str,
        operation: str,
        **fields: Any,
    ) -> None:
        logger.warning(
            event,
            message,
            exc_info=True,
            upstream_service=upstream_service,
            operation=operation,
            failure_reason="upstream_request_error",
            **fields,
        )


    def log_http_error(
        self,
        logger: Any,
        exc: httpx.HTTPStatusError,
        *,
        event: str,
        message: str,
        upstream_service: str,
        operation: str,
        **fields: Any,
    ) -> None:
        logger.warning(
            event,
            message,
            exc_info=True,
            upstream_service=upstream_service,
            operation=operation,
            status_code=exc.response.status_code,
            failure_reason="upstream_http_error",
            **fields,
        )


    def log_invalid_response(
        self,
        logger: Any,
        exc: Exception | None = None,
        *,
        event: str,
        message: str,
        upstream_service: str,
        operation: str,
        **fields: Any,
    ) -> None:
        logger.warning(
            event,
            message,
            exc_info=exc is not None,
            upstream_service=upstream_service,
            operation=operation,
            failure_reason="invalid_upstream_response",
            **fields,
        )


upstream_error_handler = UpstreamErrorHandler()
