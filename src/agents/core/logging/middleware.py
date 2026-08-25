from __future__ import annotations

import logging
import time

from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware

from core.logging.context import clear_context, set_context
from core.logging.events import log_event
from core.logging.operations import elapsed_ms
from core.logging.redaction import sanitize_for_logging, sanitize_request_id
import core.security.internal_trust as internal_trust


logger = logging.getLogger("agents.request")

# Health-probe paths the container healthcheck hits every 30s — answered but
# never logged, to keep the access log free of probe noise.
_SILENT_PATHS = frozenset({"/health"})


class RequestLoggingMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if request.url.path in _SILENT_PATHS:
            return await call_next(request)
        request_id = sanitize_request_id(request.headers.get("X-Request-ID"))
        client_ip = internal_trust.resolve_client_ip(request)
        path_params = request.scope.get("path_params") or {}

        set_context(
            request_id=request_id,
            client_ip=client_ip,
            http_method=request.method,
            http_path=request.url.path,
            user_id=request.headers.get("X-User-Id") or path_params.get("user_id") or "anonymous",
            session_id=request.headers.get("X-Session-Id") or "no-session",
            conversation_id=path_params.get("conversation_id"),
            message_id=path_params.get("message_id"),
            agent_slug=path_params.get("agent_slug"),
        )
        request.state.request_id = request_id

        started_at = time.perf_counter()
        raw_query = dict(request.query_params)
        log_event(
            logger,
            logging.INFO,
            "http_request_started",
            "HTTP request started",
            **({"query": sanitize_for_logging(raw_query)} if raw_query else {}),
        )

        try:
            response = await call_next(request)
            response.headers["X-Request-ID"] = request_id
            set_context(status_code=response.status_code)
            log_event(
                logger,
                logging.INFO,
                "http_request_completed",
                "HTTP request completed",
                duration_ms=elapsed_ms(started_at),
                response_class=response.__class__.__name__,
                content_type=response.headers.get("content-type"),
            )
            return response
        except Exception:
            set_context(status_code=500)
            log_event(
                logger,
                logging.ERROR,
                "http_request_failed",
                "HTTP request failed before response creation",
                exc_info=True,
                duration_ms=elapsed_ms(started_at),
            )
            raise
        finally:
            clear_context()
