"""Request trust — the security boundary.

``internal_trust`` gates internal callers via the trusted-proxy secret (the
rag_service only ever receives calls from the agents service). Mirrors
``dialogue_bridge/core/security`` so the security surface lives in the same
place in every service. Re-exported so callers can use
``from core.security import ...``.
"""
from core.security.internal_trust import (
    TRUSTED_PROXY_HEADER_NAME,
    is_trusted_proxy_request,
    require_internal_caller,
)

__all__ = [
    "TRUSTED_PROXY_HEADER_NAME",
    "is_trusted_proxy_request",
    "require_internal_caller",
]
