"""Shared internal TLS helpers for outbound HTTPS calls.

**Why an SSLContext instead of ``verify=path`` + ``cert=tuple``:** httpx 0.28
deprecated those arguments and, in 0.28.x, *silently stops applying* a
``cert=(cert, key)`` client certificate. That breaks mTLS to any peer that
requires a client cert (e.g. ``agents -> rag`` and ``agents -> dialogue_bridge``):
the peer, running ``--ssl-cert-reqs CERT_REQUIRED``, drops the connection during
the handshake, surfacing as ``RemoteProtocolError: Server disconnected``.

To be correct across httpx versions we build a single ``ssl.SSLContext`` that
carries BOTH the CA trust (for server verification, with hostname checking) AND
this service's client certificate, and pass it via ``verify=``. Loading the
client cert into the context works on every httpx version; the ``cert=`` tuple
does not. ``get_httpx_client_cert`` therefore returns ``None`` — the client cert
now lives in the context — so existing ``cert=get_httpx_client_cert()`` call
sites stay valid (``cert=None`` is a no-op).

In local dev the cert paths are unset, so ``get_httpx_verify`` falls back to
``True`` (system trust, no client cert), httpx's default.
"""
from __future__ import annotations

import ssl
from functools import lru_cache

from core.settings import settings


@lru_cache(maxsize=1)
def _internal_ssl_context() -> ssl.SSLContext | None:
    """Build (once) an SSLContext that trusts the internal CA and presents this
    service's client certificate, or ``None`` when TLS material is unset (dev).

    Cached because building a context + loading the cert chain is not free and
    the material is process-static; callers create a fresh httpx client per call.
    """
    ca = settings.tls.ca_cert_path
    if not ca:
        return None
    # SERVER_AUTH => check_hostname=True, verify_mode=CERT_REQUIRED, CA loaded.
    ctx = ssl.create_default_context(ssl.Purpose.SERVER_AUTH, cafile=ca)
    cert_field = settings.tls.client_cert_path
    key_field = settings.tls.client_key_path
    cert = cert_field.get_secret_value() if cert_field is not None else None
    key = key_field.get_secret_value() if key_field is not None else None
    if cert and key:
        # Present our client certificate for mutual TLS. Must go through the
        # context — httpx 0.28's cert= argument silently ignores it.
        ctx.load_cert_chain(certfile=cert, keyfile=key)
    return ctx


def get_httpx_verify() -> ssl.SSLContext | bool:
    """Value for the httpx ``verify=`` parameter: an ``SSLContext`` carrying the
    internal CA + this service's client cert in production, or ``True`` (system
    trust, no client cert) in local dev."""
    ctx = _internal_ssl_context()
    return ctx if ctx is not None else True


def get_httpx_client_cert() -> None:
    """Deprecated. The client certificate now lives in the ``SSLContext`` returned
    by :func:`get_httpx_verify`; this returns ``None`` so existing
    ``cert=get_httpx_client_cert()`` call sites remain valid (``cert=None`` is a
    no-op). Passing ``cert=`` to httpx 0.28 would be silently ignored anyway."""
    return None
