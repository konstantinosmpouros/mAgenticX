"""Session-JWT signing keys: who signs a token, and which public keys verify one.

This replaces Vault Transit (plan 29, Part B). Transit kept the RSA private key
inside Vault, which was the right custody model — but minting any token needed
``transit/sign``, and Vault seals itself on every reboot, so after a restart
nobody could log in until a human unsealed it with 2 of 3 keys.

**Production signs with OCI KMS**, using an HSM-protected RSA key. The private
key never exists outside the HSM, so the custody property Transit gave us is
kept, and there is no sealed state to recover from. We hash ``header.payload``
locally and send only the 32-byte SHA-256 digest (``message_type=DIGEST``), so
token claims — user ids, session ids — never leave our infrastructure. Today's
Transit calls sent the whole signing input.

**Local development signs with a file key** (``SESSION_SIGNING_BACKEND=file``).
A laptop cannot reach KMS and must never hold the production API key. The file
backend is refused outside development/test by settings validation, and a test
fails CI if the Dennis compose ever selects it.

**Verification is always local.** Every public key the bridge accepts is loaded
from ``<public_keys_dir>/<kid>.pem`` when the keyring is built, so the request
path never makes a network call, and the bridge boots even if KMS is
unreachable. Signing, by contrast, fails closed per request: a KMS error means
no token is issued, never a fallback.

**Every signature is checked before it leaves the process.** The keyring
verifies what the signer returned against the pinned public key for the active
``kid``. A misconfigured key version, a swapped public key file, or anything
returning the wrong bytes surfaces as a clean signing error at login — not as a
token that every later request would reject.
"""
from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

import oci
import requests
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

from core.logging import get_logger
from core.settings import SigningSettings, settings

logger = get_logger(__name__)

# RS256 is RSASSA-PKCS1-v1_5 over SHA-256 — exactly OCI's SHA_256_RSA_PKCS1_V1_5.
# PSS would produce PS256, which `verify()` (algorithms=["RS256"]) rejects.
KMS_SIGNING_ALGORITHM = "SHA_256_RSA_PKCS1_V1_5"

# Every way the SDK reports "the call never completed". Spelled out because the
# hierarchy does not nest: the SDK wraps a connect timeout in its own
# ConnectTimeout, which is NOT a subclass of its RequestException, and raw
# `requests` errors can surface too. Missing one would let a KMS outage escape
# as an unhandled 500 instead of a clean signing failure.
_KMS_TRANSPORT_ERRORS = (
    oci.exceptions.RequestException,
    oci.exceptions.ConnectTimeout,
    requests.exceptions.RequestException,
)

# Same floor as the Transit key this replaces. A smaller key in the public-key
# directory is refused at boot rather than silently accepted for verification.
MIN_RSA_KEY_BITS = 2048


class SigningError(Exception):
    """A token could not be signed. Callers fail closed: no token is issued."""


class SigningConfigError(Exception):
    """The keyring cannot be built from the configuration. Raised at boot."""


class _Signer(Protocol):
    """Produces a raw RS256 signature over the JWT signing input."""

    async def sign(self, signing_input: bytes) -> bytes: ...


class FileSigner:
    """Signs with an RSA private key held in process memory.

    **Local development only.** This is precisely the custody model plan 29
    rejected for production — a foothold in the process could copy the key and
    mint tokens offline — which is why settings refuse it outside
    development/test and a test pins the Dennis compose to KMS.
    """

    def __init__(self, private_key: rsa.RSAPrivateKey) -> None:
        self._key = private_key

    async def sign(self, signing_input: bytes) -> bytes:
        # ~1ms for RSA-2048; not worth a thread hop.
        return self._key.sign(signing_input, padding.PKCS1v15(), hashes.SHA256())


class KmsSigner:
    """Signs inside an OCI KMS HSM; the private key never reaches this process.

    The SDK is synchronous (``requests`` underneath), so the call runs in a
    worker thread — the same pattern ``core.auth.oidc`` uses for MSAL — with the
    client's explicit connect/read timeouts. The SDK does not retry ``sign`` by
    default and we keep it that way: a login should fail fast and visibly rather
    than stall through a backoff schedule.
    """

    def __init__(self, client: oci.key_management.KmsCryptoClient, *, key_id: str, key_version_id: str) -> None:
        self._client = client
        self._key_id = key_id
        self._key_version_id = key_version_id

    async def sign(self, signing_input: bytes) -> bytes:
        # Only the digest goes over the wire; the claims never leave.
        digest = hashlib.sha256(signing_input).digest()
        details = oci.key_management.models.SignDataDetails(
            message=base64.b64encode(digest).decode("ascii"),
            key_id=self._key_id,
            key_version_id=self._key_version_id,
            signing_algorithm=KMS_SIGNING_ALGORITHM,
            message_type="DIGEST",
        )
        try:
            response = await asyncio.to_thread(self._client.sign, details)
        except oci.exceptions.ServiceError as exc:
            # Status and service code only: the service message can echo request
            # details, and nothing about a signing request belongs in a log line.
            logger.error(
                "session_signing_kms_rejected",
                "OCI KMS refused to sign a session token",
                kms_status=exc.status,
                kms_code=exc.code,
                failure_reason="kms_service_error",
            )
            raise SigningError(f"OCI KMS sign failed with status {exc.status}.") from exc
        except (*_KMS_TRANSPORT_ERRORS, oci.exceptions.ClientError) as exc:
            logger.error(
                "session_signing_kms_unreachable",
                "Could not reach OCI KMS to sign a session token",
                error_type=type(exc).__name__,
                failure_reason="kms_unreachable",
            )
            raise SigningError("OCI KMS could not be reached.") from exc

        encoded = getattr(response.data, "signature", None)
        if not encoded:
            raise SigningError("OCI KMS returned no signature.")
        try:
            return base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise SigningError("OCI KMS returned a malformed signature.") from exc


@dataclass(frozen=True)
class Keyring:
    """The active signer plus every public key the bridge will accept.

    ``public_pems`` is keyed by ``kid``. It holds the active key, any further
    KMS versions still inside their drain window after a rotation, and the
    verify-only legacy keys — including the exported Vault Transit key, which
    keeps pre-migration sessions valid until they age out.
    """

    backend: str
    active_kid: int
    signer: _Signer
    public_pems: dict[int, str]
    _public_keys: dict[int, rsa.RSAPublicKey] = field(repr=False)

    def public_key_pem(self, kid: int) -> str | None:
        """The PEM for ``kid``, or ``None`` if the bridge does not accept it."""
        return self.public_pems.get(kid)

    async def sign(self, signing_input: bytes) -> bytes:
        """Sign with the active key, then prove the signature before returning it."""
        signature = await self.signer.sign(signing_input)
        try:
            self._public_keys[self.active_kid].verify(
                signature, signing_input, padding.PKCS1v15(), hashes.SHA256()
            )
        except InvalidSignature as exc:
            logger.error(
                "session_signing_selfcheck_failed",
                "A freshly signed session token did not verify against the pinned public key",
                active_kid=self.active_kid,
                signing_backend=self.backend,
                failure_reason="signature_selfcheck_failed",
            )
            raise SigningError(
                f"Signature does not verify against the public key for kid {self.active_kid}."
            ) from exc
        return signature


def _load_public_key(pem: bytes, source: str) -> tuple[rsa.RSAPublicKey, str]:
    try:
        key = serialization.load_pem_public_key(pem)
    except ValueError as exc:
        raise SigningConfigError(f"{source} is not a valid PEM public key.") from exc
    if not isinstance(key, rsa.RSAPublicKey):
        raise SigningConfigError(f"{source} is not an RSA public key; RS256 needs RSA.")
    if key.key_size < MIN_RSA_KEY_BITS:
        raise SigningConfigError(f"{source} is a {key.key_size}-bit key; at least {MIN_RSA_KEY_BITS} is required.")
    # Re-serialize so every PEM handed to `jose` is in one canonical form,
    # whatever line endings or headers the file arrived with.
    canonical = key.public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
    ).decode("ascii")
    return key, canonical


def _read_public_key_file(directory: Path, kid: int) -> tuple[rsa.RSAPublicKey, str]:
    path = directory / f"{kid}.pem"
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise SigningConfigError(
            f"No readable public key for kid {kid} at {path}. Every accepted kid needs its .pem."
        ) from exc
    return _load_public_key(raw, str(path))


def _build_file_signer(cfg: SigningSettings) -> tuple[_Signer, rsa.RSAPublicKey]:
    try:
        key = serialization.load_pem_private_key(cfg.private_key.get_secret_value().encode("utf-8"), password=None)
    except (ValueError, TypeError) as exc:
        # TypeError covers a passphrase-protected key: the dev key must be unencrypted.
        raise SigningConfigError("SESSION_SIGNING_PRIVATE_KEY is not an unencrypted PEM private key.") from exc
    if not isinstance(key, rsa.RSAPrivateKey):
        raise SigningConfigError("SESSION_SIGNING_PRIVATE_KEY is not an RSA key; RS256 needs RSA.")
    if key.key_size < MIN_RSA_KEY_BITS:
        raise SigningConfigError(f"SESSION_SIGNING_PRIVATE_KEY must be at least {MIN_RSA_KEY_BITS} bits.")
    return FileSigner(key), key.public_key()


def _build_kms_signer(cfg: SigningSettings) -> _Signer:
    oci_config = {
        "user": cfg.oci_user,
        "tenancy": cfg.oci_tenancy,
        "fingerprint": cfg.oci_fingerprint,
        "region": cfg.oci_region,
        # key_content keeps the API key in memory, read from the Swarm secret;
        # it is never written anywhere the SDK would look for a key file.
        "key_content": cfg.oci_api_key.get_secret_value(),
    }
    try:
        oci.config.validate_config(oci_config)
        client = oci.key_management.KmsCryptoClient(
            oci_config,
            service_endpoint=cfg.kms_crypto_endpoint,
            timeout=(cfg.kms_connect_timeout_seconds, cfg.kms_read_timeout_seconds),
            retry_strategy=oci.retry.NoneRetryStrategy(),
        )
    except oci.exceptions.ClientError as exc:
        # InvalidConfig / InvalidPrivateKey — their text names fields, not values.
        raise SigningConfigError(f"OCI KMS client configuration is invalid: {exc}") from exc
    return KmsSigner(
        client,
        key_id=cfg.kms_key_id,
        key_version_id=cfg.kms_key_versions[cfg.active_kid],
    )


def build_keyring(cfg: SigningSettings) -> Keyring:
    """Build the keyring, failing closed on anything missing or malformed.

    Called once at boot (see ``main.lifespan``) so a bad key file stops the
    container before it serves traffic; Swarm then keeps the healthy old task.
    It deliberately does **not** call KMS: verification must work, and existing
    sessions must stay alive, even while KMS is unreachable.
    """
    directory = Path(cfg.public_keys_dir)
    public_keys: dict[int, rsa.RSAPublicKey] = {}
    public_pems: dict[int, str] = {}

    if cfg.backend == "file":
        signer, active_public = _build_file_signer(cfg)
        # The dev key's public half is derived, not read, so it can never drift
        # from the private key that signs.
        public_keys[cfg.active_kid] = active_public
        public_pems[cfg.active_kid] = active_public.public_bytes(
            serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
        ).decode("ascii")
        verify_kids: tuple[int, ...] = cfg.legacy_kids
    else:
        signer = _build_kms_signer(cfg)
        # Every KMS version still listed (the active one plus any in its drain
        # window after a rotation) and every legacy kid needs a public key file.
        verify_kids = tuple(sorted(cfg.kms_key_versions)) + cfg.legacy_kids

    for kid in verify_kids:
        key, pem = _read_public_key_file(directory, kid)
        public_keys[kid] = key
        public_pems[kid] = pem

    if cfg.active_kid not in public_keys:
        raise SigningConfigError(f"The active kid {cfg.active_kid} has no public key.")

    keyring = Keyring(
        backend=cfg.backend,
        active_kid=cfg.active_kid,
        signer=signer,
        public_pems=public_pems,
        _public_keys=public_keys,
    )
    logger.info(
        "session_signing_keyring_loaded",
        "Session signing keyring loaded",
        signing_backend=cfg.backend,
        active_kid=cfg.active_kid,
        accepted_kids=sorted(public_pems),
    )
    return keyring


_keyring: Keyring | None = None


def get_keyring() -> Keyring:
    """The process-wide keyring, built on first use.

    Lazy so importing this module has no side effects (tests drive the ASGI app
    without its lifespan); ``main.lifespan`` calls it eagerly so production
    fails at boot rather than on the first login. Building is synchronous with
    no awaits, so two coroutines cannot race to build it.
    """
    global _keyring
    if _keyring is None:
        _keyring = build_keyring(settings.signing)
    return _keyring
