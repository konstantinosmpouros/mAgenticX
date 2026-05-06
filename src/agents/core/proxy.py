import ipaddress
import secrets

from fastapi import HTTPException, Request, status
from core.settings import settings

ProxyNetwork = ipaddress.IPv4Network | ipaddress.IPv6Network


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


def _remote_ip_is_trusted(request: Request) -> bool:
    remote_ip = _remote_ip(request)
    if not remote_ip or not TRUSTED_PROXY_NETWORKS:
        return False
    parsed_ip = ipaddress.ip_address(remote_ip)
    return any(parsed_ip in network for network in TRUSTED_PROXY_NETWORKS)


def is_trusted_proxy_request(request: Request) -> bool:
    expected = settings.proxy.trusted_proxy_secret.get_secret_value()
    if expected:
        presented = request.headers.get(TRUSTED_PROXY_HEADER_NAME, "")
        return bool(presented) and secrets.compare_digest(presented, expected)
    return _remote_ip_is_trusted(request)


def require_internal_caller(request: Request) -> None:
    if not is_trusted_proxy_request(request):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")


def internal_service_headers(request_id: str | None = None) -> dict[str, str]:
    headers: dict[str, str] = {}
    if request_id:
        headers["X-Request-ID"] = request_id
    secret = settings.proxy.trusted_proxy_secret.get_secret_value()
    if secret:
        headers[TRUSTED_PROXY_HEADER_NAME] = secret
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
