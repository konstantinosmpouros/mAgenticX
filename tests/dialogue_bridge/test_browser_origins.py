"""Which browser origins the bridge trusts: CORS in production, and the
``Origin`` check on every WebSocket handshake (cross-site WebSocket hijacking)."""

from __future__ import annotations

from pathlib import Path

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from pydantic import ValidationError
from starlette.websockets import WebSocketDisconnect

import core.settings as settings_module
from core.auth.session import websocket_origin_allowed
from core.settings import (
    AppSettings,
    CorsSettings,
    Settings,
    SigningSettings,
    _is_public_https_origin,
    settings,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
EVIL = "https://evil.magenticx.com"
SOCKETS = [
    "/v1/tasks/{user}/task-1/ws",
    "/v1/conversations/{user}/conv-1/ws",
    "/v1/inference/runs/{user}/run-1/ws",
]


# --- the WebSocket Origin check ---------------------------------------------------

@pytest.mark.parametrize("headers, allowed", [
    ({}, True),                                   # no browser: the session check decides
    ({"origin": "http://localhost:8050"}, True),  # a configured origin
    ({"origin": "HTTP://LOCALHOST:8050/"}, True),  # case and a trailing slash don't matter
    ({"origin": EVIL}, False),                    # a sibling subdomain
    ({"origin": "null"}, False),                  # a sandboxed frame or a file
])
def test_websocket_origin_allowed(headers, allowed):
    assert "http://localhost:8050" in settings.cors.allowed_origins
    assert websocket_origin_allowed(headers) is allowed


@pytest.mark.parametrize("path", SOCKETS)
def test_every_socket_refuses_a_foreign_origin_before_anything_else(app, seeded_user, path):
    # No `with`: the app's lifespan (migrations, loops) must not run here.
    client = TestClient(app)
    with (
        pytest.raises(WebSocketDisconnect) as refused,
        client.websocket_connect(path.format(user=seeded_user.id), headers={"origin": EVIL}),
    ):
        pass
    assert refused.value.code == 4403


@pytest.mark.parametrize("path", SOCKETS)
def test_an_allowed_origin_still_needs_a_session(app, seeded_user, path):
    client = TestClient(app)
    with (
        pytest.raises(WebSocketDisconnect) as refused,
        client.websocket_connect(path.format(user=seeded_user.id), headers={"origin": "http://localhost:8050"}),
    ):
        pass
    assert refused.value.code == 4401


# --- production CORS ----------------------------------------------------------------

@pytest.mark.parametrize("origin, public", [
    ("https://agents.magenticx.com", True),
    ("https://agents.magenticx.com:8443", True),
    ("http://agents.magenticx.com", False),
    ("http://localhost:8050", False),
    ("https://localhost", False),
    ("https://127.0.0.1:8050", False),
    ("not-an-origin", False),
])
def test_public_https_origin(origin, public):
    assert _is_public_https_origin(origin) is public


def _kms_signing(tmp_path: Path) -> SigningSettings:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    ).decode("ascii")
    return SigningSettings(
        _env_file=None,
        SESSION_SIGNING_BACKEND="kms",
        SESSION_SIGNING_ACTIVE_KID=100,
        SESSION_SIGNING_KEYS="100:ocid1.keyversion.oc1..active",
        SESSION_SIGNING_PUBLIC_KEYS_DIR=str(tmp_path),
        OCI_KMS_CRYPTO_ENDPOINT="https://test-crypto.kms.eu-frankfurt-1.oraclecloud.com",
        OCI_KMS_KEY_ID="ocid1.key.oc1..signing",
        OCI_USER_OCID="ocid1.user.oc1..signer",
        OCI_TENANCY_OCID="ocid1.tenancy.oc1..tenancy",
        OCI_API_KEY_FINGERPRINT=":".join(["ab"] * 16),
        OCI_REGION="eu-frankfurt-1",
        oci_api_key=pem,
    )


def test_production_refuses_the_localhost_defaults(tmp_path):
    with pytest.raises(ValidationError, match="CORS_ALLOWED_ORIGINS must list only https origins"):
        Settings(
            app=AppSettings(_env_file=None, APP_ENV="production"),
            signing=_kms_signing(tmp_path),
            cors=CorsSettings(_env_file=None),
        )


def test_development_keeps_the_localhost_defaults():
    assert settings_module.settings.app.env in {"development", "test"}
    assert "http://localhost:8050" in CorsSettings(_env_file=None).allowed_origins


def test_dennis_trusts_only_the_app_origin():
    compose = (REPO_ROOT / "magenticx" / "docker-compose-denis.yaml").read_text(encoding="utf-8")
    start = compose.index("\n  dialogue_bridge:")
    bridge = compose[start:compose.index("\n  agentic_ui:", start)]
    assert "- CORS_ALLOWED_ORIGINS=https://agents.magenticx.com\n" in bridge
