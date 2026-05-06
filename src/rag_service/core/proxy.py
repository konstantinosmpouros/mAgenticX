import ipaddress
import secrets

from fastapi import HTTPException, Request, status

from core.settings import settings

TRUSTED_PROXY_HEADER_NAME = settings.proxy.trusted_proxy_header_name
TRUSTED_PROXY_NETWORKS = settings.proxy.trusted_proxy_networks


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


def _remote_ip_is_trusted(request: Request) -> bool:
    if request.client is None or not TRUSTED_PROXY_NETWORKS:
        return False
    try:
        parsed = ipaddress.ip_address(request.client.host.strip())
        return any(parsed in net for net in TRUSTED_PROXY_NETWORKS)
    except ValueError:
        return False


def is_trusted_proxy_request(request: Request) -> bool:
    expected = settings.proxy.trusted_proxy_secret.get_secret_value()
    if expected:
        presented = request.headers.get(TRUSTED_PROXY_HEADER_NAME, "")
        return bool(presented) and secrets.compare_digest(presented, expected)
    return _remote_ip_is_trusted(request)


def require_internal_caller(request: Request) -> None:
    if not is_trusted_proxy_request(request):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")
