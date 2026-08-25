import ipaddress
import secrets

from fastapi import HTTPException, Request, status
from core.settings import settings
from core.logging.context import get_context


TRUSTED_PROXY_HEADER_NAME = settings.proxy.header_name


def _normalize_ip(value: str | None) -> str | None:
    if not value:
        return None
    candidate = value.strip()
    if not candidate:
        return None
    try:
        return str(ipaddress.ip_address(candidate))
    except ValueError:
        return None


def _first_forwarded_for_ip(value: str | None) -> str | None:
    if not value:
        return None
    for part in value.split(","):
        normalized = _normalize_ip(part)
        if normalized:
            return normalized
    return None


def _remote_ip(request: Request) -> str | None:
    if request.client is None:
        return None
    return _normalize_ip(request.client.host)


def is_trusted_proxy_request(request: Request) -> bool:
    expected = settings.proxy.secret.get_secret_value()
    presented = request.headers.get(TRUSTED_PROXY_HEADER_NAME, "")
    return bool(presented) and secrets.compare_digest(presented, expected)


def require_internal_caller(request: Request) -> None:
    """FastAPI dependency for service-to-service-only endpoints (e.g. the
    agents → bridge memory search). Rejects anything that doesn't present the
    shared internal proxy secret.

    SECURITY: nginx injects this same secret on browser traffic, so an endpoint
    guarded by this dependency MUST ALSO be blocked at the nginx edge (see the
    ``/api/v1/internal/`` deny in ``agentic_ui/nginx.conf.template``). The agents
    service reaches these endpoints directly on the ``backend`` network, never
    through nginx, so denying the path at nginx leaves them reachable only
    server-to-server.
    """
    if not is_trusted_proxy_request(request):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Internal caller required.",
        )


def internal_service_headers(
    request_id: str | None = None, session_id: str | None = None, user_id: str | None = None
) -> dict[str, str]:
    headers: dict[str, str] = {
        TRUSTED_PROXY_HEADER_NAME: settings.proxy.secret.get_secret_value(),
    }
    if request_id:
        headers["X-Request-ID"] = request_id
    # Forward the RAW session/user ids so every internal hop logs them identically
    # and they correlate with the database. Auto-derived from the request context
    # when the caller omits them, so all hops carry them — not just inference.
    if session_id is None:
        session_id = get_context().get("session_id")
    if session_id and session_id != "no-session":
        headers["X-Session-Id"] = session_id
    if user_id is None:
        user_id = get_context().get("user_id")
    if user_id and user_id != "anonymous":
        headers["X-User-Id"] = user_id
    return headers


def resolve_client_ip(request: Request) -> str | None:
    remote_ip = _remote_ip(request)
    if not is_trusted_proxy_request(request):
        return remote_ip

    forwarded_candidates = (
        _normalize_ip(request.headers.get("cf-connecting-ip")),
        _first_forwarded_for_ip(request.headers.get("x-forwarded-for")),
        _normalize_ip(request.headers.get("x-real-ip")),
    )
    for candidate in forwarded_candidates:
        if candidate:
            return candidate

    return remote_ip
