"""The internal-caller gate: ``X-Internal-Proxy-Secret`` compared in constant time.

This is one of the runner's two controls; the other is mTLS, enforced by
uvicorn itself (``--ssl-cert-reqs 2``) before a request reaches the app.
Missing and wrong secrets are both 403, like every other internal service.
"""
import secrets

from fastapi import HTTPException, Request, status

from core.settings import settings

TRUSTED_PROXY_HEADER_NAME = settings.proxy.trusted_proxy_header_name


def is_trusted_proxy_request(request: Request) -> bool:
    """True when the request carries the shared secret."""
    expected = settings.proxy.trusted_proxy_secret.get_secret_value()
    presented = request.headers.get(TRUSTED_PROXY_HEADER_NAME, "")
    return bool(presented) and bool(expected) and secrets.compare_digest(presented, expected)


def require_internal_caller(request: Request) -> None:
    """FastAPI dependency: refuse any caller without the shared secret."""
    if not is_trusted_proxy_request(request):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")
