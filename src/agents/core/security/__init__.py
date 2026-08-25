"""Request trust and outbound TLS verification — the security boundary.

``internal_trust`` gates internal callers (the trusted-proxy secret), resolves
the real client IP behind the proxy chain, and builds the headers for outbound
internal calls; ``tls`` supplies the httpx SSLContext for outbound mTLS.
Mirrors ``dialogue_bridge/core/security`` so the security surface lives in the
same place in every service. Re-exported so callers can use
``from core.security import ...``.
"""
from core.security.internal_trust import (
    TRUSTED_PROXY_HEADER_NAME,
    internal_service_headers,
    is_trusted_proxy_request,
    require_internal_caller,
    resolve_client_ip,
)
from core.security.tls import get_httpx_client_cert, get_httpx_verify

__all__ = [
    "TRUSTED_PROXY_HEADER_NAME",
    "get_httpx_client_cert",
    "get_httpx_verify",
    "internal_service_headers",
    "is_trusted_proxy_request",
    "require_internal_caller",
    "resolve_client_ip",
]
