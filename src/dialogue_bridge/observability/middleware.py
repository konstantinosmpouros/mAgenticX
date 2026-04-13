from __future__ import annotations

import time
import uuid

from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware

from observability.context import clear_context, set_context
from observability.events import get_logger
from observability.operations import elapsed_ms
from observability.redaction import sanitize_for_logging
from utils.proxy import resolve_client_ip


logger = get_logger("dialogue_bridge.request")


class RequestLoggingMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        request_id = request.headers.get("X-Request-ID") or str(uuid.uuid4())
        client_ip = resolve_client_ip(request)
        path_params = request.scope.get("path_params") or {}

        set_context(
            request_id=request_id,
            client_ip=client_ip,
            http_method=request.method,
            http_path=request.url.path,
            user_id=path_params.get("user_id") or "anonymous",
            session_id="no-session",
            conversation_id=path_params.get("conversation_id"),
            message_id=path_params.get("message_id"),
        )
        request.state.request_id = request_id

        started_at = time.perf_counter()
        raw_query = dict(request.query_params)
        logger.info("http_request_started", "HTTP request started", **({"query": sanitize_for_logging(raw_query)} if raw_query else {}))

        try:
            response = await call_next(request)
            response.headers["X-Request-ID"] = request_id
            set_context(status_code=response.status_code)
            logger.info(
                "http_request_completed",
                "HTTP request completed",
                duration_ms=elapsed_ms(started_at),
                response_class=response.__class__.__name__,
                content_type=response.headers.get("content-type"),
            )
            return response
        except Exception:
            set_context(status_code=500)
            logger.error(
                "http_request_failed",
                "HTTP request failed before response creation",
                exc_info=True,
                duration_ms=elapsed_ms(started_at),
            )
            raise
        finally:
            clear_context()
