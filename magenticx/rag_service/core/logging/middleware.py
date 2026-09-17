from __future__ import annotations

import time

from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware

from core.logging.context import clear_context, set_context
from core.logging.events import get_logger
from core.logging.redaction import sanitize_request_id


logger = get_logger("rag_service.request")

# Health-probe paths the container healthcheck hits every 30s — answered but
# never logged, to keep the access log free of probe noise.
_SILENT_PATHS = frozenset({"/health"})


class RequestLoggingMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if request.url.path in _SILENT_PATHS:
            return await call_next(request)
        request_id = sanitize_request_id(request.headers.get("X-Request-ID"))
        set_context(
            request_id=request_id,
            session_id=request.headers.get("X-Session-Id") or "no-session",
            user_id=request.headers.get("X-User-Id") or "anonymous",
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
