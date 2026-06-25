from __future__ import annotations

import time

from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware

from observability.context import clear_context, set_context
from observability.events import get_logger
from observability.operations import elapsed_ms
from observability.redaction import sanitize_for_logging, sanitize_request_id
from core.proxy import resolve_client_ip


logger = get_logger("dialogue_bridge.request")

# Health-probe paths the container healthcheck hits every 30s — answered but
# never logged, to keep the access log free of probe noise.
_SILENT_PATHS = frozenset({"/health"})


class RequestLoggingMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if request.url.path in _SILENT_PATHS:
            return await call_next(request)
        request_id = sanitize_request_id(request.headers.get("X-Request-ID"))
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
            # Auth deps stash the resolved session/user on request.state (Starlette
            # isolates the endpoint's contextvars from this middleware), so the
            # access line carries the same identity as the business logs.
            ctx_updates: dict = {"status_code": response.status_code}
            resolved_session = getattr(request.state, "session_id", None)
            if resolved_session:
                ctx_updates["session_id"] = resolved_session
            resolved_user = getattr(request.state, "user_id", None)
            if resolved_user:
                ctx_updates["user_id"] = resolved_user
            set_context(**ctx_updates)
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
