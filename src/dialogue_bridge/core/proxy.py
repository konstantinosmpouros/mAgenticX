import ipaddress
import secrets

from fastapi import Request
from core.settings import settings


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


def internal_service_headers(request_id: str | None = None) -> dict[str, str]:
    headers: dict[str, str] = {
        TRUSTED_PROXY_HEADER_NAME: settings.proxy.secret.get_secret_value(),
    }
    if request_id:
        headers["X-Request-ID"] = request_id
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
