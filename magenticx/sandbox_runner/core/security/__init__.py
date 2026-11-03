"""Request trust for the runner (the internal-caller gate)."""
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
