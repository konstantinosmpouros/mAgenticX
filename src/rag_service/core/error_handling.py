import logging
from typing import Any, NoReturn

from fastapi import HTTPException, Request, status
from fastapi.exceptions import RequestValidationError
from starlette.responses import JSONResponse


class RagServiceExceptionHandler:

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
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
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


class RagOperationErrorHandler:

    def raise_dependency_error(
        self,
        logger: Any,
        exc: Exception,
        *,
        event: str,
        message: str,
        public_detail: str,
        **fields: Any,
    ) -> NoReturn:
        logger.warning(
            event,
            message,
            exc_info=True,
            failure_reason="dependency_failed",
            **fields,
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=public_detail,
        ) from exc


    def raise_bad_request(
        self,
        logger: Any,
        exc: Exception,
        *,
        event: str,
        message: str,
        public_detail: str,
        **fields: Any,
    ) -> NoReturn:
        logger.warning(
            event,
            message,
            exc_info=True,
            failure_reason="operation_failed",
            **fields,
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=public_detail,
        ) from exc


rag_operation_error_handler = RagOperationErrorHandler()
