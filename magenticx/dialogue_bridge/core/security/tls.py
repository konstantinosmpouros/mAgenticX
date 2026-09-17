"""Shared internal TLS helpers for outbound HTTPS calls.

When ``settings.tls.ca_cert_path`` is set (production), httpx verifies the
server certificate against the internal CA.  When it is ``None`` (local dev),
httpx falls back to the system default trust store.

When the client cert/key are configured (production), outbound calls to internal
services present them so the peer can mutually authenticate this service (mTLS).
``cert`` is only sent when the server requests it during the handshake, so the
pair is harmless on calls to peers that don't require a client cert. In local
dev the paths are unset and ``get_httpx_client_cert`` returns ``None`` (no client
cert), which is httpx's default.
"""
from __future__ import annotations

from core.settings import settings


def get_httpx_verify() -> str | bool:
    """Return a value suitable for the httpx ``verify=`` parameter."""
    return settings.tls.ca_cert_path if settings.tls.ca_cert_path else True


def get_httpx_client_cert() -> tuple[str, str] | None:
    """Return the (cert, key) pair for the httpx ``cert=`` parameter, or None."""
    cert_field = settings.tls.client_cert_path
    key_field = settings.tls.client_key_path
    cert = cert_field.get_secret_value() if cert_field is not None else None
    key = key_field.get_secret_value() if key_field is not None else None
    if cert and key:
        return (cert, key)
    return None
