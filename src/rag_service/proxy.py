import ipaddress
import os
import secrets
from pathlib import Path

from fastapi import HTTPException, Request, status


def _read_secret(name: str, default: str = "") -> str:
    file_path = os.getenv(f"{name}_FILE")
    if file_path:
        try:
            return Path(file_path).read_text().strip()
        except OSError:
            pass
    return (os.getenv(name) or default).strip()


TRUSTED_PROXY_HEADER_NAME = os.getenv("TRUSTED_PROXY_HEADER_NAME", "X-Internal-Proxy-Secret")
TRUSTED_PROXY_SECRET = _read_secret("TRUSTED_PROXY_SECRET")
_TRUSTED_PROXY_CIDRS = os.getenv("TRUSTED_PROXY_CIDRS", "")


def _parse_trusted_networks() -> tuple:
    networks = []
    for item in _TRUSTED_PROXY_CIDRS.split(","):
        candidate = item.strip()
        if not candidate:
            continue
        try:
            networks.append(ipaddress.ip_network(candidate, strict=False))
        except ValueError:
            continue
    return tuple(networks)


TRUSTED_PROXY_NETWORKS = _parse_trusted_networks()


def _remote_ip_is_trusted(request: Request) -> bool:
    if request.client is None or not TRUSTED_PROXY_NETWORKS:
        return False
    try:
        parsed = ipaddress.ip_address(request.client.host.strip())
        return any(parsed in net for net in TRUSTED_PROXY_NETWORKS)
    except ValueError:
        return False


def is_trusted_proxy_request(request: Request) -> bool:
    if TRUSTED_PROXY_SECRET:
        presented = request.headers.get(TRUSTED_PROXY_HEADER_NAME, "")
        return bool(presented) and secrets.compare_digest(presented, TRUSTED_PROXY_SECRET)
    return _remote_ip_is_trusted(request)


def require_internal_caller(request: Request) -> None:
    if not is_trusted_proxy_request(request):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")
