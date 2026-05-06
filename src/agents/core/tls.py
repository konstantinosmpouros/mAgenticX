"""Shared internal TLS helpers for outbound HTTPS calls.

When ``settings.tls.ca_cert_path`` is set (production), httpx verifies the
server certificate against the internal CA.  When it is ``None`` (local dev),
httpx falls back to the system default trust store.
"""
from __future__ import annotations

from core.settings import settings


def get_httpx_verify() -> str | bool:
    """Return a value suitable for the httpx ``verify=`` parameter."""
    return settings.tls.ca_cert_path if settings.tls.ca_cert_path else True
