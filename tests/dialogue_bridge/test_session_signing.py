"""Session-token signing without Vault (plan 29, Part B).

Plan 29 is held to three requirements, and this file pins the parts of each that
Part B can break:

- **R1 stateless** — verification makes no signing call and no network call.
- **R2 nothing lost** — tokens Vault signed before the cutover keep verifying
  through the legacy kid, so nobody is logged out.
- **R3 no security downgrade** — the HSM only ever sees a digest, a signature
  that does not match the pinned public key is never issued, a KMS failure
  issues nothing, and the in-memory dev signer can never reach production.

KMS itself is replaced by a stand-in that signs exactly as OCI does for
``SHA_256_RSA_PKCS1_V1_5`` over a ``DIGEST`` — PKCS#1 v1.5 over a prehashed
SHA-256 — so the real ``KmsSigner`` request construction, response decoding and
the keyring's self-check all run for real.
"""
from __future__ import annotations

import base64
import dataclasses
import hashlib
import json
import re
from pathlib import Path
from types import SimpleNamespace

import oci
import pytest
import requests
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa, utils
from pydantic import ValidationError

import core.auth.signing as signing
from core.auth.signing import KMS_SIGNING_ALGORITHM, SigningConfigError, build_keyring
from core.auth.tokens import ACCESS_TYPE, REFRESH_TYPE, TokenError, mint_tokens, verify
from core.settings import AppSettings, Settings, SigningSettings

REPO_ROOT = Path(__file__).resolve().parents[2]

# Generated once: RSA key generation is the slow part of this file.
_HSM_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_OTHER_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_TRANSIT_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_API_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)


def _private_pem(key: rsa.RSAPrivateKey) -> str:
    return key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    ).decode("ascii")


def _public_pem(key: rsa.RSAPrivateKey) -> bytes:
    return key.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
    )


def _kms_settings(tmp_path: Path, **overrides) -> SigningSettings:
    values = {
        "SESSION_SIGNING_BACKEND": "kms",
        "SESSION_SIGNING_ACTIVE_KID": 100,
        "SESSION_SIGNING_KEYS": "100:ocid1.keyversion.oc1..active",
        "SESSION_SIGNING_PUBLIC_KEYS_DIR": str(tmp_path),
        "OCI_KMS_CRYPTO_ENDPOINT": "https://test-crypto.kms.eu-frankfurt-1.oraclecloud.com",
        "OCI_KMS_KEY_ID": "ocid1.key.oc1..signing",
        "OCI_USER_OCID": "ocid1.user.oc1..signer",
        "OCI_TENANCY_OCID": "ocid1.tenancy.oc1..tenancy",
        "OCI_API_KEY_FINGERPRINT": ":".join(["ab"] * 16),
        "OCI_REGION": "eu-frankfurt-1",
        "oci_api_key": _private_pem(_API_KEY),
    }
    values.update(overrides)
    return SigningSettings(_env_file=None, **values)


def _file_settings(tmp_path: Path, key: rsa.RSAPrivateKey, **overrides) -> SigningSettings:
    values = {
        "SESSION_SIGNING_BACKEND": "file",
        "SESSION_SIGNING_ACTIVE_KID": 100,
        "SESSION_SIGNING_PUBLIC_KEYS_DIR": str(tmp_path),
        "private_key": _private_pem(key),
    }
    values.update(overrides)
    return SigningSettings(_env_file=None, **values)


class _FakeKms:
    """Stands in for OCI KMS: signs a DIGEST with an HSM stand-in key and
    records every request, so tests can inspect exactly what left the bridge."""

    def __init__(self, key: rsa.RSAPrivateKey) -> None:
        self.key = key
        self.requests: list = []
        self.error: Exception | None = None
        self.client_kwargs: dict = {}

    def client_factory(self, config, service_endpoint, **kwargs):
        self.client_kwargs = {"config": config, "service_endpoint": service_endpoint, **kwargs}
        return self

    def sign(self, details):
        self.requests.append(details)
        if self.error is not None:
            raise self.error
        digest = base64.b64decode(details.message)
        signature = self.key.sign(digest, padding.PKCS1v15(), utils.Prehashed(hashes.SHA256()))
        return SimpleNamespace(data=SimpleNamespace(signature=base64.b64encode(signature).decode("ascii")))


@pytest.fixture
def fake_kms(monkeypatch):
    kms = _FakeKms(_HSM_KEY)
    monkeypatch.setattr(oci.key_management, "KmsCryptoClient", kms.client_factory)
    return kms


@pytest.fixture
def use_keyring(monkeypatch):
    """Install a keyring as the process-wide one for the duration of a test."""

    def install(keyring: signing.Keyring) -> signing.Keyring:
        monkeypatch.setattr(signing, "_keyring", keyring)
        return keyring

    return install


def _kms_keyring(tmp_path: Path) -> signing.Keyring:
    (tmp_path / "100.pem").write_bytes(_public_pem(_HSM_KEY))
    return build_keyring(_kms_settings(tmp_path))


# --------------------------------------------------------------------------
# R3 — what reaches the HSM, and what leaves the process
# --------------------------------------------------------------------------
async def test_kms_receives_only_a_digest_never_the_claims(tmp_path, fake_kms, use_keyring):
    use_keyring(_kms_keyring(tmp_path))

    issued = await mint_tokens("user-with-a-recognisable-id")

    # One signing request per token, both minted concurrently.
    assert len(fake_kms.requests) == 2
    for details in fake_kms.requests:
        assert details.message_type == "DIGEST"
        assert details.signing_algorithm == KMS_SIGNING_ALGORITHM
        assert details.key_version_id == "ocid1.keyversion.oc1..active"
        # 32 bytes of SHA-256, and nothing that decodes back to the claims.
        assert len(base64.b64decode(details.message)) == 32
        assert "user-with-a-recognisable-id" not in details.message
    sent = {base64.b64decode(d.message) for d in fake_kms.requests}
    expected = {
        hashlib.sha256(token.rsplit(".", 1)[0].encode("ascii")).digest()
        for token in (issued.access_token, issued.refresh_token)
    }
    assert sent == expected

    claims = await verify(issued.access_token, ACCESS_TYPE)
    assert claims["sub"] == "user-with-a-recognisable-id"


async def test_kms_client_is_bounded_and_never_retries(tmp_path, fake_kms):
    _kms_keyring(tmp_path)

    assert fake_kms.client_kwargs["timeout"] == (5.0, 10.0)
    assert isinstance(fake_kms.client_kwargs["retry_strategy"], oci.retry.NoneRetryStrategy)
    # The API key travels as key_content — nothing is written to disk for the SDK.
    assert fake_kms.client_kwargs["config"]["key_content"].startswith("-----BEGIN PRIVATE KEY-----")


async def test_a_signature_that_does_not_match_the_pinned_key_is_never_issued(tmp_path, fake_kms, use_keyring):
    # The HSM signs with one key while the public key file says another — a
    # wrong key version, or a swapped .pem. Nothing may be issued.
    use_keyring(_kms_keyring(tmp_path))
    fake_kms.key = _OTHER_KEY

    with pytest.raises(TokenError):
        await mint_tokens("user-1")


@pytest.mark.parametrize(
    "error",
    [
        oci.exceptions.ServiceError(503, "ServiceUnavailable", {}, "kms down"),
        oci.exceptions.ServiceError(404, "NotAuthorizedOrNotFound", {}, "network source refused"),
        oci.exceptions.ConnectTimeout(requests.exceptions.ConnectTimeout("connect timed out")),
        oci.exceptions.RequestException(requests.exceptions.ReadTimeout("read timed out")),
        requests.exceptions.ConnectionError("connection reset"),
    ],
    ids=["503", "refused-by-policy", "connect-timeout", "read-timeout", "raw-requests-error"],
)
async def test_a_kms_failure_issues_no_token(tmp_path, fake_kms, use_keyring, error):
    # Every failure mode — including the connect timeout the SDK does not nest
    # under its own RequestException — must become a clean TokenError, never an
    # unhandled exception and never a fallback signer.
    use_keyring(_kms_keyring(tmp_path))
    fake_kms.error = error

    with pytest.raises(TokenError):
        await mint_tokens("user-1")


# --------------------------------------------------------------------------
# R1 — verification is local
# --------------------------------------------------------------------------
class _SignerThatMustNotRun:
    async def sign(self, signing_input: bytes) -> bytes:
        raise AssertionError("verify() must never reach the signer")


async def test_verification_never_touches_the_signer(tmp_path, fake_kms, use_keyring):
    keyring = use_keyring(_kms_keyring(tmp_path))
    issued = await mint_tokens("user-1")
    calls_after_mint = len(fake_kms.requests)

    use_keyring(dataclasses.replace(keyring, signer=_SignerThatMustNotRun()))
    fake_kms.error = AssertionError("verify() must never call KMS")

    assert (await verify(issued.access_token, ACCESS_TYPE))["sub"] == "user-1"
    assert (await verify(issued.refresh_token, REFRESH_TYPE))["sub"] == "user-1"
    assert len(fake_kms.requests) == calls_after_mint


# --------------------------------------------------------------------------
# R2 — the cutover logs nobody out
# --------------------------------------------------------------------------
async def test_tokens_signed_before_the_cutover_keep_verifying(tmp_path, fake_kms, use_keyring):
    # Before: a bridge signing with the "Vault Transit" key under kid 1.
    use_keyring(build_keyring(_file_settings(tmp_path, _TRANSIT_KEY, SESSION_SIGNING_ACTIVE_KID=1)))
    before = await mint_tokens("user-from-yesterday")

    # After: KMS signs under kid 100, and the exported Transit public key is
    # loaded verify-only under its old kid.
    (tmp_path / "1.pem").write_bytes(_public_pem(_TRANSIT_KEY))
    (tmp_path / "100.pem").write_bytes(_public_pem(_HSM_KEY))
    use_keyring(build_keyring(_kms_settings(tmp_path, SESSION_SIGNING_LEGACY_KIDS="1")))

    assert (await verify(before.access_token, ACCESS_TYPE))["sub"] == "user-from-yesterday"
    assert (await verify(before.refresh_token, REFRESH_TYPE))["sub"] == "user-from-yesterday"
    # And new tokens are minted under the new kid.
    after = await mint_tokens("user-from-today")
    header_seg = after.access_token.split(".")[0]
    header = json.loads(base64.urlsafe_b64decode(header_seg + "=" * (-len(header_seg) % 4)))
    assert header["kid"] == "100"


async def test_a_legacy_kid_is_rejected_once_its_key_is_retired(tmp_path, fake_kms, use_keyring):
    # Day 20: the legacy key is dropped from config. Its tokens stop verifying.
    use_keyring(build_keyring(_file_settings(tmp_path, _TRANSIT_KEY, SESSION_SIGNING_ACTIVE_KID=1)))
    before = await mint_tokens("user-1")

    use_keyring(_kms_keyring(tmp_path))

    with pytest.raises(TokenError, match="not recognised"):
        await verify(before.access_token, ACCESS_TYPE)


async def test_a_known_kid_signed_by_the_wrong_key_is_rejected(tmp_path, use_keyring):
    use_keyring(build_keyring(_file_settings(tmp_path, _OTHER_KEY)))
    forged = await mint_tokens("user-1")

    use_keyring(build_keyring(_file_settings(tmp_path, _HSM_KEY)))

    with pytest.raises(TokenError):
        await verify(forged.access_token, ACCESS_TYPE)


# --------------------------------------------------------------------------
# Boot guards — misconfiguration fails before traffic, never at first login
# --------------------------------------------------------------------------
def test_a_missing_public_key_file_refuses_to_boot(tmp_path, fake_kms):
    with pytest.raises(SigningConfigError, match="kid 100"):
        build_keyring(_kms_settings(tmp_path))


def test_a_missing_legacy_key_file_refuses_to_boot(tmp_path, fake_kms):
    (tmp_path / "100.pem").write_bytes(_public_pem(_HSM_KEY))
    with pytest.raises(SigningConfigError, match="kid 1"):
        build_keyring(_kms_settings(tmp_path, SESSION_SIGNING_LEGACY_KIDS="1"))


def test_a_garbage_public_key_file_refuses_to_boot(tmp_path, fake_kms):
    (tmp_path / "100.pem").write_text("not a key")
    with pytest.raises(SigningConfigError, match="not a valid PEM"):
        build_keyring(_kms_settings(tmp_path))


def test_a_weak_public_key_refuses_to_boot(tmp_path, fake_kms):
    weak = rsa.generate_private_key(public_exponent=65537, key_size=1024)
    (tmp_path / "100.pem").write_bytes(_public_pem(weak))
    with pytest.raises(SigningConfigError, match="1024-bit"):
        build_keyring(_kms_settings(tmp_path))


def test_a_dev_key_that_is_not_a_private_key_refuses_to_boot(tmp_path):
    with pytest.raises(SigningConfigError):
        build_keyring(_file_settings(tmp_path, _HSM_KEY, private_key="-----BEGIN NONSENSE-----"))


def test_kms_boot_does_not_call_kms(tmp_path, fake_kms):
    # An unreachable KMS must not stop the bridge from booting: existing
    # sessions stay alive because verification never needs it.
    fake_kms.error = AssertionError("building the keyring must not call KMS")
    _kms_keyring(tmp_path)
    assert fake_kms.requests == []


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"OCI_KMS_CRYPTO_ENDPOINT": None}, "OCI_KMS_CRYPTO_ENDPOINT"),
        ({"oci_api_key": ""}, "OCI_API_PRIVATE_KEY_FILE"),
        ({"SESSION_SIGNING_KEYS": None}, "SESSION_SIGNING_KEYS"),
        ({"OCI_KMS_CRYPTO_ENDPOINT": "http://plaintext.example"}, "https://"),
        ({"SESSION_SIGNING_ACTIVE_KID": 101}, "no KMS key version"),
        ({"SESSION_SIGNING_LEGACY_KIDS": "100"}, "legacy"),
        ({"SESSION_SIGNING_KEYS": "0:ocid1.keyversion.oc1..x"}, "outside"),
        ({"SESSION_SIGNING_KEYS": "100"}, "kid:version_ocid"),
    ],
    ids=["no-endpoint", "no-api-key", "no-key-versions", "plaintext-endpoint",
         "active-kid-unmapped", "active-kid-also-legacy", "kid-out-of-range", "malformed-entry"],
)
def test_incomplete_kms_config_is_refused(tmp_path, overrides, message):
    with pytest.raises(ValidationError, match=message):
        _kms_settings(tmp_path, **overrides)


# --------------------------------------------------------------------------
# R3 — the in-memory dev signer cannot reach production
# --------------------------------------------------------------------------
def test_kms_is_the_default_backend(tmp_path, monkeypatch):
    # Nothing set means KMS, and KMS with nothing set refuses to start — so
    # forgetting the config can never silently select the dev signer. (The
    # suite itself signs with the file backend, so clear that first.)
    monkeypatch.delenv("SESSION_SIGNING_BACKEND", raising=False)
    with pytest.raises(ValidationError, match="OCI_KMS_CRYPTO_ENDPOINT"):
        SigningSettings(_env_file=None, SESSION_SIGNING_PUBLIC_KEYS_DIR=str(tmp_path))


def test_the_file_backend_is_refused_outside_development(tmp_path):
    with pytest.raises(ValidationError, match="local development only"):
        Settings(
            app=AppSettings(_env_file=None, APP_ENV="production"),
            signing=_file_settings(tmp_path, _HSM_KEY),
        )


def test_dennis_signs_with_kms_and_never_the_file_backend():
    compose = (REPO_ROOT / "magenticx" / "docker-compose-denis.yaml").read_text(encoding="utf-8")
    assert "SESSION_SIGNING_BACKEND=file" not in compose
    assert "SESSION_SIGNING_PRIVATE_KEY" not in compose
    assert "SESSION_SIGNING_BACKEND=kms" in compose
    # Without this the file-backend refusal above never runs on Dennis: APP_ENV
    # defaults to "development".
    assert "APP_ENV=production" in compose


def _dennis_bridge_service() -> str:
    """The dialogue_bridge service block of the Dennis compose, as text."""
    compose = (REPO_ROOT / "magenticx" / "docker-compose-denis.yaml").read_text(encoding="utf-8")
    start = compose.index("\n  dialogue_bridge:")
    end = compose.index("\n  agentic_ui:", start)
    return compose[start:end]


def _dennis_networks_section() -> str:
    """The top-level ``networks:`` section of the Dennis compose, as text."""
    compose = (REPO_ROOT / "magenticx" / "docker-compose-denis.yaml").read_text(encoding="utf-8")
    start = compose.index("\nnetworks:\n")
    end = compose.index("\nsecrets:\n", start)
    return compose[start:end]


def test_dennis_bridge_has_its_own_route_to_the_internet():
    # Signing in needs Microsoft and minting a token needs OCI KMS — both public
    # endpoints. `backend` is internal-only, and before plan 29 the bridge's only
    # way out was, by accident, the Vault overlay. Removing Vault silently
    # removed it; this pins the replacement so it cannot happen again.
    compose = (REPO_ROOT / "magenticx" / "docker-compose-denis.yaml").read_text(encoding="utf-8")
    bridge = _dennis_bridge_service()
    networks = _dennis_networks_section()

    assert "- bridge_egress" in bridge
    assert "\n  bridge_egress:" in networks
    # Up to the next sibling key (exactly two spaces of indent), not the first
    # indented line — that would stop before `internal:` could ever be seen.
    egress_definition = re.split(r"\n  (?=\S)", networks.split("\n  bridge_egress:", 1)[1], maxsplit=1)[0]
    assert "internal: true" not in egress_definition
    # Least privilege: only the bridge rides it.
    assert compose.count("- bridge_egress") == 1
