from __future__ import annotations

import logging
import time
import uuid

from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware

from observability.context import set_context
from observability.events import log_event
from utils.proxy import resolve_client_ip


logger = logging.getLogger("dialogue_bridge.request")


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
        log_event(
            logger,
            logging.INFO,
            "http_request_started",
            "HTTP request started",
            query=str(request.url.query or ""),
        )

        try:
            response = await call_next(request)
        except Exception:
            duration_ms = round((time.perf_counter() - started_at) * 1000, 2)
            log_event(
                logger,
                logging.ERROR,
                "http_request_failed",
                "HTTP request failed before response creation",
                duration_ms=duration_ms,
            )
            raise

        duration_ms = round((time.perf_counter() - started_at) * 1000, 2)
        response.headers["X-Request-ID"] = request_id
        set_context(status_code=response.status_code)
        log_event(
            logger,
            logging.INFO,
            "http_request_completed",
            "HTTP request completed",
            duration_ms=duration_ms,
            response_class=response.__class__.__name__,
            content_type=response.headers.get("content-type"),
        )
        return response
