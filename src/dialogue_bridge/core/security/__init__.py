"""Request trust, throttling, and outbound TLS verification — the security boundary.

``internal_trust`` gates internal callers and resolves the real client IP,
``rate_limit`` throttles abuse, and ``tls`` supplies the httpx verify/cert pair
for outbound mTLS. Re-exported so callers can use ``from core.security import ...``.
"""
from core.security.internal_trust import (
    TRUSTED_PROXY_HEADER_NAME,
    internal_service_headers,
    is_trusted_proxy_request,
    resolve_client_ip,
)
from core.security.rate_limit import (
    AUTHENTICATE_LIMIT,
    INFERENCE_RATE_LIMIT,
    client_identifier,
    inference_user_key,
    limiter,
)
from core.security.tls import get_httpx_client_cert, get_httpx_verify
