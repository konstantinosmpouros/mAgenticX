from __future__ import annotations

import time
import uuid

from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware

from observability.context import clear_context, set_context
from observability.events import get_logger


logger = get_logger("rag_service.request")

# Health-probe paths the container healthcheck hits every 30s — answered but
# never logged, to keep the access log free of probe noise.
_SILENT_PATHS = frozenset({"/health"})


class RequestLoggingMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if request.url.path in _SILENT_PATHS:
            return await call_next(request)
        request_id = request.headers.get("X-Request-ID") or str(uuid.uuid4())
        set_context(
            request_id=request_id,
            http_method=request.method,
            http_path=request.url.path,
        )
        request.state.request_id = request_id
        started_at = time.perf_counter()
        logger.info("http_request_started")

        try:
            response = await call_next(request)
            response.headers["X-Request-ID"] = request_id
            logger.info(
                "http_request_completed",
                status_code=response.status_code,
                duration_ms=round((time.perf_counter() - started_at) * 1000, 2),
            )
            return response
        except Exception:
            logger.error(
                "http_request_failed",
                exc_info=True,
                duration_ms=round((time.perf_counter() - started_at) * 1000, 2),
            )
            raise
        finally:
            clear_context()
