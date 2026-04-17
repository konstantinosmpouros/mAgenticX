"""Shared internal TLS helpers for outbound HTTPS calls.

When ``configs.tls.ca_cert_path`` is set (production), httpx verifies the
server certificate against the internal CA.  When it is ``None`` (local dev),
httpx falls back to the system default trust store.
"""
from __future__ import annotations

from core.configs import configs


def get_httpx_verify() -> str | bool:
    """Return a value suitable for the httpx ``verify=`` parameter."""
    return configs.tls.ca_cert_path if configs.tls.ca_cert_path else True
