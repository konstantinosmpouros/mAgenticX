import secrets

from fastapi import HTTPException, Request, status

from core.settings import settings

TRUSTED_PROXY_HEADER_NAME = settings.proxy.trusted_proxy_header_name


def is_trusted_proxy_request(request: Request) -> bool:
    expected = settings.proxy.trusted_proxy_secret.get_secret_value()
    presented = request.headers.get(TRUSTED_PROXY_HEADER_NAME, "")
    return bool(presented) and secrets.compare_digest(presented, expected)


def require_internal_caller(request: Request) -> None:
    if not is_trusted_proxy_request(request):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")
