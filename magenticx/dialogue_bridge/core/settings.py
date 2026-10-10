from __future__ import annotations

import os
import secrets
from pathlib import Path
from typing import Literal
from urllib.parse import quote

import httpx
from pydantic import AliasChoices, Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


_BASE_MODEL_CONFIG = SettingsConfigDict(
    env_file=".env",
    env_file_encoding="utf-8",
    extra="ignore",
    case_sensitive=False,
)


def _resolve_file_backed_secret(*env_names: str) -> str | None:
    """Resolve a secret from `<NAME>_FILE` indirection or the env var itself.

    Mirrors Docker/K8s file-mounted-secret convention. Raises on unreadable
    `*_FILE` paths instead of silently falling through to the plain env var.
    """
    for name in env_names:
        file_path = os.getenv(f"{name}_FILE")
        if file_path:
            try:
                value = Path(file_path).read_text().strip()
            except OSError as exc:
                raise RuntimeError(
                    f"{name}_FILE points to {file_path!r} but could not be read: {exc}"
                ) from exc
            if value:
                return value
        raw = os.getenv(name)
        if raw and raw.strip():
            return raw.strip()
    return None


def _split_csv(raw: object) -> tuple[str, ...]:
    if raw is None:
        return ()
    if isinstance(raw, (list, tuple)):
        return tuple(str(item).strip() for item in raw if str(item).strip())
    items: list[str] = []
    for part in str(raw).split(","):
        candidate = part.strip()
        if candidate:
            items.append(candidate)
    return tuple(items)


class AppSettings(BaseSettings):
    model_config = _BASE_MODEL_CONFIG

    env: str = Field("development", validation_alias=AliasChoices("APP_ENV", "ENV"))
    version: str = Field("unknown", validation_alias=AliasChoices("APP_VERSION", "IMAGE_TAG"))
    service_name: str = Field("dialogue_bridge", validation_alias="LOG_SERVICE_NAME")


class DatabaseSettings(BaseSettings):
    model_config = _BASE_MODEL_CONFIG

    url: SecretStr = Field(..., validation_alias="DATABASE_URL")
    echo: bool = Field(False, validation_alias="DATABASE_ECHO")
    pool_pre_ping: bool = Field(True, validation_alias="DATABASE_POOL_PRE_PING")
    pool_recycle: int = Field(1800, validation_alias="DATABASE_POOL_RECYCLE")
    pool_size: int = Field(5, validation_alias="DATABASE_POOL_SIZE")
    max_overflow: int = Field(20, validation_alias="DATABASE_MAX_OVERFLOW")

    @field_validator("url", mode="before")
    @classmethod
    def _inject_password(cls, value: object) -> object:
        """Splice a file/env-resolved password into a password-less DATABASE_URL.

        Lets the DB password come from a mounted secret (`DATABASE_PASSWORD_FILE`,
        e.g. a Swarm secret) instead of being inlined in the URL. An inline
        password in the URL always wins, so local dev (`...://admin:admin@...`
        with no `*_FILE` set) is untouched.
        """
        raw = value.get_secret_value() if isinstance(value, SecretStr) else value
        if not isinstance(raw, str) or "://" not in raw:
            return value
        password = _resolve_file_backed_secret("DATABASE_PASSWORD")
        if not password:
            return raw
        scheme, sep, rest = raw.partition("://")
        authority, slash, tail = rest.partition("/")
        if "@" not in authority:
            return raw
        userinfo, at, hostport = authority.rpartition("@")
        if ":" in userinfo:  # inline password already present — leave it
            return raw
        userinfo = f"{userinfo}:{quote(password, safe='')}"
        return f"{scheme}{sep}{userinfo}{at}{hostport}{slash}{tail}"
    # When True (default) the lifespan startup runs ``alembic upgrade head``
    # before the app accepts traffic. Set False to skip migrations on startup —
    # useful as an emergency knob if a buggy migration takes down the API and
    # you need to bring the container up to run a manual ``alembic`` command.
    run_migrations_on_startup: bool = Field(True, validation_alias="RUN_MIGRATIONS_ON_STARTUP")


class SessionSettings(BaseSettings):
    model_config = _BASE_MODEL_CONFIG

    secure: bool = Field(True, validation_alias="SESSION_COOKIE_SECURE")
    samesite: str = Field("lax", validation_alias="SESSION_COOKIE_SAMESITE")
    domain: str | None = Field(None, validation_alias="SESSION_COOKIE_DOMAIN")
    access_cookie_name: str | None = Field(None, validation_alias="SESSION_COOKIE_NAME")
    refresh_cookie_name: str | None = Field(None, validation_alias="SESSION_REFRESH_COOKIE_NAME")
    csrf_cookie_name: str | None = Field(None, validation_alias="SESSION_CSRF_COOKIE_NAME")
    csrf_header_name: str = Field("X-CSRF-Token", validation_alias="SESSION_CSRF_HEADER_NAME")

    # --- multi-account (parked sessions) -------------------------------------
    # On by default. It does keep several live refresh tokens per browser, which
    # widens the blast radius of a stolen session from one account to N — bounded
    # by max_parked_accounts, at-rest encryption and per-switch rotation (see
    # plans/19). Set false to turn the whole surface off; every
    # /v1/auth/accounts* route then 404s.
    multi_account_enabled: bool = Field(True, validation_alias="MULTI_ACCOUNT_ENABLED")
    # Names the browser's parked-session index. Opaque random id, never a user id.
    device_cookie_name: str | None = Field(None, validation_alias="SESSION_DEVICE_COOKIE_NAME")
    # Hard ceiling on concurrently signed-in accounts. Each entry is a live bearer
    # credential, so this is a security bound, not a UI nicety — keep it as low as
    # the product allows. Two covers the common personal + work case; asking for a
    # third surfaces the "log out of one to continue" dialog.
    max_parked_accounts: int = Field(2, ge=1, le=10, validation_alias="MAX_PARKED_ACCOUNTS")
    # AES-GCM key (32 bytes, base64 or hex) encrypting parked refresh tokens at
    # rest. Redis otherwise holds usable credentials; with this, a Redis-only
    # compromise is not enough. Supply it explicitly in production (a Swarm secret
    # via PARKED_TOKEN_KEY_FILE) so it is rotatable independently; when absent it
    # is derived from SESSION_TOKEN_SECRET, which keeps local dev free of an extra
    # ops step without ever falling back to plaintext.
    parked_token_key: SecretStr = Field(default_factory=lambda: SecretStr(""))

    # General-purpose HMAC secret (used e.g. for short-lived DOCX-preview tokens);
    # no longer used for auth sessions, which are now stateless KMS-signed JWTs.
    token_secret: SecretStr = Field(default_factory=lambda: SecretStr(""))

    @field_validator("token_secret", mode="before")
    @classmethod
    def _load_token_secret(cls, value: object) -> object:
        if isinstance(value, SecretStr) and value.get_secret_value():
            return value
        if isinstance(value, str) and value:
            return value
        resolved = _resolve_file_backed_secret("SESSION_TOKEN_SECRET")
        return resolved if resolved else ""

    @field_validator("parked_token_key", mode="before")
    @classmethod
    def _load_parked_token_key(cls, value: object) -> object:
        if isinstance(value, SecretStr) and value.get_secret_value():
            return value
        if isinstance(value, str) and value:
            return value
        resolved = _resolve_file_backed_secret("PARKED_TOKEN_KEY")
        return resolved if resolved else ""

    @model_validator(mode="after")
    def _apply_cookie_name_defaults(self) -> "SessionSettings":
        host_locked = self.secure and self.domain is None
        defaults = {
            "access_cookie_name": "__Host-mx_session" if host_locked else "mx_session",
            "refresh_cookie_name": "__Host-mx_refresh" if host_locked else "mx_refresh",
            "csrf_cookie_name": "__Host-mx_csrf" if host_locked else "mx_csrf",
            "device_cookie_name": "__Host-mx_device" if host_locked else "mx_device",
        }
        for field_name, default in defaults.items():
            if getattr(self, field_name) is None:
                object.__setattr__(self, field_name, default)
        # Fail closed rather than parking credentials in plaintext: with the
        # feature on there must be *something* to derive an at-rest key from.
        if (
            self.multi_account_enabled
            and not self.parked_token_key.get_secret_value()
            and not self.token_secret.get_secret_value()
        ):
            raise ValueError(
                "MULTI_ACCOUNT_ENABLED is true but neither PARKED_TOKEN_KEY nor "
                "SESSION_TOKEN_SECRET is set. Parked refresh tokens must be encrypted "
                "at rest; refusing to start."
            )
        return self


class JWTSettings(BaseSettings):
    model_config = _BASE_MODEL_CONFIG

    issuer: str = Field("magenticx-bridge", validation_alias="JWT_ISSUER")
    audience: str = Field("magenticx", validation_alias="JWT_AUDIENCE")
    access_ttl_seconds: int = Field(28800, validation_alias="JWT_ACCESS_TTL_SECONDS")     # 8 hours
    # Rolling refresh window. A refresh token lives IDLE seconds from issue and
    # slides forward on every refresh, but its expiry never exceeds ABSOLUTE
    # seconds from the original login. Net effect: an active user stays signed in
    # up to ABSOLUTE; being idle longer than IDLE logs them out; ABSOLUTE forces a
    # periodic full re-auth regardless of activity. IDLE should be <= ABSOLUTE; if
    # it isn't, the absolute cap simply dominates (min() below stays correct).
    #
    # Product target: a logged-in user is kept signed in silently for up to 20 days
    # (ABSOLUTE), after which they must re-authenticate; going 12 days (IDLE) without
    # the client managing to refresh (browser closed / device off the whole time)
    # logs them out early. The frontend refreshes proactively and on any 401, so an
    # active session slides toward the 20-day cap without ever prompting for login.
    refresh_idle_ttl_seconds: int = Field(1036800, validation_alias="JWT_REFRESH_IDLE_TTL_SECONDS")           # 12 days
    refresh_absolute_ttl_seconds: int = Field(1728000, validation_alias="JWT_REFRESH_ABSOLUTE_TTL_SECONDS")   # 20 days
    # Grace during which the just-rotated-FROM refresh jti is still accepted, so a
    # legitimate concurrent/retried refresh is not misread as stolen-token reuse.
    refresh_reuse_grace_seconds: int = Field(30, validation_alias="JWT_REFRESH_REUSE_GRACE_SECONDS")
    leeway_seconds: int = Field(30, validation_alias="JWT_LEEWAY_SECONDS")

    @field_validator(
        "leeway_seconds", "access_ttl_seconds",
        "refresh_idle_ttl_seconds", "refresh_absolute_ttl_seconds", "refresh_reuse_grace_seconds",
        mode="after",
    )
    @classmethod
    def _bound_durations(cls, v: int, info) -> int:
        bounds = {
            "leeway_seconds": (0, 300),
            "access_ttl_seconds": (60, 86400),
            "refresh_idle_ttl_seconds": (300, 2592000),           # 5 min .. 30 days
            "refresh_absolute_ttl_seconds": (3600, 15552000),     # 1 h .. 180 days
            "refresh_reuse_grace_seconds": (0, 300),
        }
        lo, hi = bounds[info.field_name]
        if v < lo or v > hi:
            raise ValueError(f"{info.field_name} must be between {lo} and {hi} seconds.")
        return v


# Bounds on a JWT `kid`. Mirrors the check in `core.auth.tokens.verify`, which
# rejects anything outside it before looking a key up — a configured kid that
# verify would refuse is a misconfiguration, so it fails at boot instead.
KID_MIN = 1
KID_MAX = 100_000


def _parse_kid(raw: str, source: str) -> int:
    candidate = raw.strip()
    if not candidate.isdigit():
        raise ValueError(f"{source}: key id {candidate!r} is not a positive integer.")
    kid = int(candidate)
    if not KID_MIN <= kid <= KID_MAX:
        raise ValueError(f"{source}: key id {kid} is outside {KID_MIN}..{KID_MAX}.")
    return kid


class SigningSettings(BaseSettings):
    """How session JWTs are signed, and which public keys verify them.

    Replaces Vault Transit (plan 29, Part B). Vault sealed itself on every
    reboot, and because minting a token needed ``transit/sign``, nobody could log
    in until a human unsealed it.

    **Production signs with OCI KMS**, using an HSM-protected RSA key: the
    private key never exists outside the HSM, the bridge sends only a SHA-256
    digest of ``header.payload``, and gets a signature back. That keeps the one
    property Transit gave us — the private key never enters our process — while
    removing the sealed state.

    **The ``file`` backend is for local development only.** A laptop cannot reach
    KMS and must never hold the production API key. It is refused unless selected
    explicitly, and a test fails CI if the Dennis compose ever selects it.

    **Verification never calls anything.** Every public key the bridge accepts is
    a PEM file loaded at boot (``<public_keys_dir>/<kid>.pem``). Public keys are
    not secret, and holding them locally means the request path stays free of
    network calls — and the bridge boots even while KMS is unreachable.
    """

    model_config = _BASE_MODEL_CONFIG

    backend: Literal["kms", "file"] = Field("kms", validation_alias="SESSION_SIGNING_BACKEND")
    # The kid stamped on newly minted tokens. KMS kids start at 100 so they are
    # distinguishable at a glance from Vault Transit's 1, 2, … in logs.
    active_kid: int = Field(100, validation_alias="SESSION_SIGNING_ACTIVE_KID")
    public_keys_dir: str = Field("/app/signing_keys", validation_alias="SESSION_SIGNING_PUBLIC_KEYS_DIR")
    # "kid:version_ocid,kid:version_ocid" — the KMS key versions the bridge may
    # sign with. Every listed kid also needs its public key file.
    kms_key_versions_raw: str | None = Field(None, validation_alias="SESSION_SIGNING_KEYS")
    # Verify-only kids with no private key behind them anywhere we can reach:
    # used to keep tokens signed by a retired key (including the old Vault
    # Transit key) valid until they age out. Each needs its public key file.
    legacy_kids_raw: str | None = Field(None, validation_alias="SESSION_SIGNING_LEGACY_KIDS")

    # --- file backend (local development) ---
    private_key: SecretStr = Field(default_factory=lambda: SecretStr(""))

    # --- kms backend (production) ---
    kms_crypto_endpoint: str | None = Field(None, validation_alias="OCI_KMS_CRYPTO_ENDPOINT")
    kms_key_id: str | None = Field(None, validation_alias="OCI_KMS_KEY_ID")
    oci_user: str | None = Field(None, validation_alias="OCI_USER_OCID")
    oci_tenancy: str | None = Field(None, validation_alias="OCI_TENANCY_OCID")
    oci_fingerprint: str | None = Field(None, validation_alias="OCI_API_KEY_FINGERPRINT")
    oci_region: str | None = Field(None, validation_alias="OCI_REGION")
    # The API key of a principal whose only permission is `use keys` on the one
    # signing key, and only from Dennis (IAM network source). Swarm secret.
    oci_api_key: SecretStr = Field(default_factory=lambda: SecretStr(""))
    kms_connect_timeout_seconds: float = Field(5.0, validation_alias="OCI_KMS_CONNECT_TIMEOUT_SECONDS")
    kms_read_timeout_seconds: float = Field(10.0, validation_alias="OCI_KMS_READ_TIMEOUT_SECONDS")

    @field_validator("private_key", mode="before")
    @classmethod
    def _load_private_key(cls, value: object) -> object:
        if isinstance(value, SecretStr) and value.get_secret_value():
            return value
        if isinstance(value, str) and value:
            return value
        return _resolve_file_backed_secret("SESSION_SIGNING_PRIVATE_KEY") or ""

    @field_validator("oci_api_key", mode="before")
    @classmethod
    def _load_oci_api_key(cls, value: object) -> object:
        if isinstance(value, SecretStr) and value.get_secret_value():
            return value
        if isinstance(value, str) and value:
            return value
        return _resolve_file_backed_secret("OCI_API_PRIVATE_KEY") or ""

    @field_validator("active_kid", mode="after")
    @classmethod
    def _bound_active_kid(cls, value: int) -> int:
        if not KID_MIN <= value <= KID_MAX:
            raise ValueError(f"SESSION_SIGNING_ACTIVE_KID must be within {KID_MIN}..{KID_MAX}.")
        return value

    @field_validator("kms_connect_timeout_seconds", "kms_read_timeout_seconds", mode="after")
    @classmethod
    def _bound_timeouts(cls, value: float) -> float:
        # A login waits on this call; never let it hang, never make it instant-fail.
        if not 0.5 <= value <= 60.0:
            raise ValueError("OCI KMS timeouts must be between 0.5 and 60 seconds.")
        return value

    @property
    def kms_key_versions(self) -> dict[int, str]:
        """``SESSION_SIGNING_KEYS`` parsed into ``{kid: key_version_ocid}``."""
        versions: dict[int, str] = {}
        for entry in _split_csv(self.kms_key_versions_raw):
            kid_raw, sep, version = entry.partition(":")
            if not sep or not version.strip():
                raise ValueError(f"SESSION_SIGNING_KEYS entry {entry!r} is not 'kid:version_ocid'.")
            kid = _parse_kid(kid_raw, "SESSION_SIGNING_KEYS")
            if kid in versions:
                raise ValueError(f"SESSION_SIGNING_KEYS lists key id {kid} twice.")
            versions[kid] = version.strip()
        return versions

    @property
    def legacy_kids(self) -> tuple[int, ...]:
        """``SESSION_SIGNING_LEGACY_KIDS`` parsed into verify-only key ids."""
        return tuple(_parse_kid(raw, "SESSION_SIGNING_LEGACY_KIDS") for raw in _split_csv(self.legacy_kids_raw))

    @model_validator(mode="after")
    def _require_backend_config(self) -> SigningSettings:
        # Parsing here, not lazily, so a malformed list fails at boot rather
        # than on the first login.
        versions = self.kms_key_versions
        legacy = self.legacy_kids
        if self.active_kid in legacy:
            raise ValueError("SESSION_SIGNING_ACTIVE_KID cannot also be a verify-only legacy kid.")
        overlap = set(versions) & set(legacy)
        if overlap:
            raise ValueError(f"Key ids {sorted(overlap)} are both signing and verify-only.")

        if self.backend == "file":
            if not self.private_key.get_secret_value():
                raise ValueError(
                    "SESSION_SIGNING_BACKEND=file needs SESSION_SIGNING_PRIVATE_KEY_FILE "
                    "(local development only)."
                )
            return self

        missing = [
            name
            for name, present in (
                ("OCI_KMS_CRYPTO_ENDPOINT", bool(self.kms_crypto_endpoint)),
                ("OCI_KMS_KEY_ID", bool(self.kms_key_id)),
                ("OCI_USER_OCID", bool(self.oci_user)),
                ("OCI_TENANCY_OCID", bool(self.oci_tenancy)),
                ("OCI_API_KEY_FINGERPRINT", bool(self.oci_fingerprint)),
                ("OCI_REGION", bool(self.oci_region)),
                ("OCI_API_PRIVATE_KEY_FILE", bool(self.oci_api_key.get_secret_value())),
                ("SESSION_SIGNING_KEYS", bool(versions)),
            )
            if not present
        ]
        if missing:
            raise ValueError(
                "Session signing uses OCI KMS (SESSION_SIGNING_BACKEND=kms) but these are not set: "
                + ", ".join(missing)
                + ". Refusing to start: no token could ever be issued."
            )
        if not self.kms_crypto_endpoint.startswith("https://"):
            raise ValueError("OCI_KMS_CRYPTO_ENDPOINT must be an https:// URL.")
        if self.active_kid not in versions:
            raise ValueError(
                f"SESSION_SIGNING_ACTIVE_KID={self.active_kid} has no KMS key version in SESSION_SIGNING_KEYS."
            )
        return self


class EntraSettings(BaseSettings):
    """Microsoft Entra ID (Azure AD) OIDC — the platform's only way to sign in.

    The bridge acts as an OIDC Relying Party (authorization-code + PKCE via MSAL)
    and, on a successful Entra login, mints its own session JWTs (see
    ``SigningSettings``). Username/password login was removed in plan 29 Part A,
    so ``tenant_id``, ``client_id`` and ``client_secret`` are **mandatory**: the
    root ``Settings`` refuses to start without them, because a bridge with Entra
    unconfigured would serve a login page with no way in at all.
    """

    model_config = _BASE_MODEL_CONFIG

    tenant_id: str | None = Field(None, validation_alias="ENTRA_TENANT_ID")
    client_id: str | None = Field(None, validation_alias="ENTRA_CLIENT_ID")
    client_secret: SecretStr = Field(default_factory=lambda: SecretStr(""))
    # Browser-facing callback URL, registered verbatim in the Entra app. Behind
    # nginx the request URL is the internal host, so this must be configured
    # explicitly (per environment) to exactly match the registered redirect URI.
    redirect_uri: str | None = Field(None, validation_alias="ENTRA_REDIRECT_URI")
    # Comma-separated Entra security-group Object IDs allowed to sign in. Empty =
    # no group restriction. Enforced fail-closed in the callback.
    allowed_group_ids: str | None = Field(None, validation_alias="ENTRA_ALLOWED_GROUP_IDS")
    # SPA path to land on after a successful SSO login.
    post_login_redirect: str = Field("/", validation_alias="ENTRA_POST_LOGIN_REDIRECT")
    # SPA path (with an error query) to bounce to when SSO is denied/fails.
    login_error_redirect: str = Field("/login", validation_alias="ENTRA_LOGIN_ERROR_REDIRECT")
    authority_host: str = Field(
        "https://login.microsoftonline.com", validation_alias="ENTRA_AUTHORITY_HOST"
    )

    @field_validator("client_secret", mode="before")
    @classmethod
    def _load_client_secret(cls, value: object) -> object:
        if isinstance(value, SecretStr) and value.get_secret_value():
            return value
        if isinstance(value, str) and value:
            return value
        return _resolve_file_backed_secret("ENTRA_CLIENT_SECRET") or ""

    @property
    def enabled(self) -> bool:
        return bool(
            self.tenant_id and self.client_id and self.client_secret.get_secret_value()
        )

    @property
    def authority(self) -> str:
        return f"{self.authority_host.rstrip('/')}/{self.tenant_id}"

    @property
    def allowed_groups(self) -> set[str]:
        return {g.strip() for g in (self.allowed_group_ids or "").split(",") if g.strip()}


class TlsSettings(BaseSettings):
    model_config = _BASE_MODEL_CONFIG

    ca_cert_path: str | None = Field(None, validation_alias="INTERNAL_CA_CERT_PATH")
    # Wrapped in SecretStr (the key is private material) so the paths cannot surface
    # in a settings repr/dump; the CA cert is public, so ca_cert_path stays str.
    client_cert_path: SecretStr | None = Field(None, validation_alias="INTERNAL_CLIENT_CERT_PATH")
    client_key_path: SecretStr | None = Field(None, validation_alias="INTERNAL_CLIENT_KEY_PATH")


class UpstreamSettings(BaseSettings):
    model_config = _BASE_MODEL_CONFIG

    agents_service_url: str = Field("https://agents:8003", validation_alias="AGENTS_SERVICE_URL")


class InferenceSettings(BaseSettings):
    model_config = _BASE_MODEL_CONFIG

    # Cap stored TOOL_CALL_RESULT content in the per-run event log; oversized
    # results are cut and flagged with "truncated": true so the UI can say so.
    tool_result_max_chars: int = Field(16000, validation_alias="INFERENCE_TOOL_RESULT_MAX_CHARS")
    ws_subscribe_timeout_seconds: float = Field(10.0, validation_alias="INFERENCE_WS_SUBSCRIBE_TIMEOUT_SECONDS")


class SpeechSettings(BaseSettings):
    model_config = _BASE_MODEL_CONFIG

    dictation_max_bytes: int = Field(25 * 1024 * 1024, validation_alias="SPEECH_DICTATION_MAX_BYTES")
    dictation_read_chunk_bytes: int = Field(1024 * 1024, validation_alias="SPEECH_DICTATION_READ_CHUNK_BYTES")
    read_aloud_max_chars: int = Field(2000, validation_alias="SPEECH_READ_ALOUD_MAX_CHARS")


class AttachmentSettings(BaseSettings):
    model_config = _BASE_MODEL_CONFIG

    max_size_bytes: int = Field(25 * 1024 * 1024, validation_alias="ATTACHMENT_MAX_SIZE_BYTES")
    max_total_bytes: int = Field(25 * 1024 * 1024, validation_alias="ATTACHMENT_MAX_TOTAL_BYTES")
    max_per_message: int = Field(10, validation_alias="ATTACHMENT_MAX_PER_MESSAGE")
    docx_preview_token_ttl_seconds: int = Field(60, validation_alias="ATTACHMENT_DOCX_PREVIEW_TOKEN_TTL_SECONDS")
    inline_cache_max_age_seconds: int = Field(300, validation_alias="ATTACHMENT_INLINE_CACHE_MAX_AGE_SECONDS")
    stream_chunk_bytes: int = Field(512 * 1024, validation_alias="ATTACHMENT_STREAM_CHUNK_BYTES")


class ExportSettings(BaseSettings):
    """"Export my data" (plan 27): one streamed zip of everything a user owns.

    Every bound here exists because the export is the one operation that reads a
    user's whole history, on a box (Dennis) whose memory is shared by every stack.
    The archive is streamed — read a page or a slice, write it, drop it — so its
    size never reaches memory or disk; these numbers bound how much is in flight.
    """
    model_config = _BASE_MODEL_CONFIG

    # Kill switch, on by default: DATA_EXPORT_ENABLED=false stops new exports
    # (status reports it, token minting is refused) without a release.
    enabled: bool = Field(True, validation_alias="DATA_EXPORT_ENABLED")
    # One export per user per week, stored on users.last_export_at so it holds
    # even when Redis is down (rate limiting fails open; this must not). A week,
    # because a full export can be tens of GB of egress and disk reads on a VM
    # every other stack shares; an export that does not finish hands it back.
    cooldown_minutes: int = Field(7 * 24 * 60, validation_alias="EXPORT_COOLDOWN_MINUTES")
    # Exports running at once across the service. Each holds a database
    # connection only for one short query at a time, but runs for minutes.
    max_concurrent: int = Field(2, validation_alias="EXPORT_MAX_CONCURRENT")
    # Rows per keyset page; bounds the rows in memory at any moment.
    page_rows: int = Field(50, validation_alias="EXPORT_PAGE_ROWS")
    # Bytes per attachment slice read from Postgres.
    chunk_bytes: int = Field(1024 * 1024, validation_alias="EXPORT_CHUNK_BYTES")
    # Absolute ceiling on one export's duration. A backstop only: what actually
    # ends a dead download is the stall timeout below. At the rate cap, 6 h
    # covers ~500 GiB.
    max_seconds: int = Field(6 * 3600, validation_alias="EXPORT_MAX_SECONDS")
    # A download whose client accepts nothing for this long is ended, freeing its
    # slot and handing the cooldown back. Checked on every write to the client —
    # a client that stops reading blocks the write, and nothing else would notice.
    stall_seconds: int = Field(300, validation_alias="EXPORT_STALL_SECONDS")
    # Ceiling on one export's speed (~200 Mbit/s): a fast client cannot take most
    # of the uplink and the disk reads of a VM every other stack shares.
    max_bytes_per_second: int = Field(25 * 1024 * 1024, validation_alias="EXPORT_MAX_BYTES_PER_SECOND")
    # Lifetime of the one-time download token minted by the CSRF-protected POST.
    token_ttl_seconds: int = Field(60, validation_alias="EXPORT_TOKEN_TTL_SECONDS")

    @field_validator("page_rows", mode="after")
    @classmethod
    def _bound_page(cls, v: int) -> int:
        if v < 1 or v > 500:
            raise ValueError("EXPORT_PAGE_ROWS must be between 1 and 500.")
        return v

    @field_validator("chunk_bytes", mode="after")
    @classmethod
    def _bound_chunk(cls, v: int) -> int:
        if v < 64 * 1024 or v > 8 * 1024 * 1024:
            raise ValueError("EXPORT_CHUNK_BYTES must be between 64 KiB and 8 MiB.")
        return v

    @field_validator("max_concurrent", mode="after")
    @classmethod
    def _bound_concurrency(cls, v: int) -> int:
        if v < 1 or v > 4:
            raise ValueError("EXPORT_MAX_CONCURRENT must be between 1 and 4.")
        return v

    @field_validator("max_seconds", mode="after")
    @classmethod
    def _bound_duration(cls, v: int) -> int:
        if v < 600 or v > 24 * 3600:
            raise ValueError("EXPORT_MAX_SECONDS must be between 600 and 86400.")
        return v

    @field_validator("stall_seconds", mode="after")
    @classmethod
    def _bound_stall(cls, v: int) -> int:
        if v < 30 or v > 3600:
            raise ValueError("EXPORT_STALL_SECONDS must be between 30 and 3600.")
        return v

    @field_validator("max_bytes_per_second", mode="after")
    @classmethod
    def _bound_rate(cls, v: int) -> int:
        if v < 1024 * 1024 or v > 1024 * 1024 * 1024:
            raise ValueError("EXPORT_MAX_BYTES_PER_SECOND must be between 1 MiB and 1 GiB.")
        return v

    @field_validator("cooldown_minutes", mode="after")
    @classmethod
    def _bound_cooldown(cls, v: int) -> int:
        # Zero would remove the only bound on how often one user can pull their
        # whole history; past 30 days a user could not get their data in time.
        if v < 1 or v > 30 * 24 * 60:
            raise ValueError("EXPORT_COOLDOWN_MINUTES must be between 1 and 43200 (30 days).")
        return v


class ProfileSettings(BaseSettings):
    """Edit profile: the photo a user can upload.

    The upload is read in chunks and refused past ``avatar_max_upload_bytes``
    before it is decoded; the decoder refuses images over
    ``avatar_max_pixels`` (a decompression bomb is a few KB that expands to GBs).
    What is stored is always a fresh ``avatar_size_px`` square WebP.
    """
    model_config = _BASE_MODEL_CONFIG

    avatar_max_upload_bytes: int = Field(5 * 1024 * 1024, ge=1024, validation_alias="AVATAR_MAX_UPLOAD_BYTES")
    avatar_read_chunk_bytes: int = Field(64 * 1024, ge=1024, validation_alias="AVATAR_READ_CHUNK_BYTES")
    avatar_max_pixels: int = Field(40_000_000, ge=65_536, validation_alias="AVATAR_MAX_PIXELS")
    avatar_size_px: int = Field(256, ge=64, le=1024, validation_alias="AVATAR_SIZE_PX")


class AccountDeletionSettings(BaseSettings):
    """"Delete account" (plan 32): a request, a grace period, then a resumable purge.

    The purge removes everything one user holds across chat_db, agent_runtime and
    the volume — up to tens of GB for one account — on a box every other stack
    shares, so it runs in the background in small, separately committed batches.
    These numbers bound one batch; none of them bounds the account's size.
    """
    model_config = _BASE_MODEL_CONFIG

    # Kill switch, on by default: false stops new requests and pauses the purger.
    enabled: bool = Field(True, validation_alias="ACCOUNT_DELETION_ENABLED")
    # Days between the request and the purge; signing in during them can cancel.
    grace_days: int = Field(14, validation_alias="ACCOUNT_DELETION_GRACE_DAYS")
    # A request needs a Microsoft sign-in at most this old (the session's `lat`).
    reauth_max_age_seconds: int = Field(600, validation_alias="ACCOUNT_DELETION_REAUTH_MAX_AGE_SECONDS")
    # How often the purger looks for a deletion whose grace period is over.
    purge_interval_seconds: int = Field(300, validation_alias="ACCOUNT_PURGE_INTERVAL_SECONDS")
    # Conversations taken per purge round; each is emptied, then deleted.
    conversation_batch: int = Field(25, validation_alias="ACCOUNT_PURGE_CONVERSATION_BATCH")
    # Messages deleted per transaction inside one conversation.
    message_batch: int = Field(1000, validation_alias="ACCOUNT_PURGE_MESSAGE_BATCH")
    # Attachment blobs deleted per transaction — at most this many, and at most
    # `blob_batch_bytes` of them (always at least one). Deleting a blob writes
    # roughly its own size to the WAL (full-page images after each checkpoint),
    # so bytes, not rows, are what make a delete transaction long: 20 × 25 MiB
    # measured 15 s each in the 50 GB load test.
    blob_batch: int = Field(20, validation_alias="ACCOUNT_PURGE_BLOB_BATCH")
    blob_batch_bytes: int = Field(64 * 1024 * 1024, validation_alias="ACCOUNT_PURGE_BLOB_BATCH_BYTES")
    # Ceiling on how fast the purge deletes attachment bytes — and so on the WAL
    # it writes. The disk on Dennis is shared by every stack, and the purge is a
    # background job with no deadline: a 50 GB account takes ~27 min at 32 MiB/s.
    max_bytes_per_second: int = Field(32 * 1024 * 1024, validation_alias="ACCOUNT_PURGE_MAX_BYTES_PER_SECOND")
    # Checkpoint thread ids sent to the agents service per call.
    thread_batch: int = Field(200, validation_alias="ACCOUNT_PURGE_THREAD_BATCH")
    # Ceiling for the retry backoff after a failed purge step.
    retry_max_seconds: int = Field(3600, validation_alias="ACCOUNT_PURGE_RETRY_MAX_SECONDS")

    @field_validator("grace_days", mode="after")
    @classmethod
    def _bound_grace(cls, v: int) -> int:
        # The grace period is the safety net (plan 32, decision 5): never zero.
        if v < 1 or v > 30:
            raise ValueError("ACCOUNT_DELETION_GRACE_DAYS must be between 1 and 30.")
        return v

    @field_validator("reauth_max_age_seconds", mode="after")
    @classmethod
    def _bound_reauth(cls, v: int) -> int:
        if v < 60 or v > 3600:
            raise ValueError("ACCOUNT_DELETION_REAUTH_MAX_AGE_SECONDS must be between 60 and 3600.")
        return v

    @field_validator("purge_interval_seconds", "retry_max_seconds", mode="after")
    @classmethod
    def _bound_interval(cls, v: int) -> int:
        if v < 10 or v > 86400:
            raise ValueError("Account purge intervals must be between 10 seconds and one day.")
        return v

    @field_validator("blob_batch_bytes", "max_bytes_per_second", mode="after")
    @classmethod
    def _bound_bytes(cls, v: int) -> int:
        if v < 1024 * 1024 or v > 1024 * 1024 * 1024:
            raise ValueError("Account purge byte limits must be between 1 MiB and 1 GiB.")
        return v

    @field_validator("conversation_batch", "message_batch", "blob_batch", "thread_batch", mode="after")
    @classmethod
    def _bound_batch(cls, v: int) -> int:
        if v < 1 or v > 5000:
            raise ValueError("Account purge batch sizes must be between 1 and 5000.")
        return v


class ShareSettings(BaseSettings):
    model_config = _BASE_MODEL_CONFIG

    default_ttl_days: int = Field(30, validation_alias="SHARE_DEFAULT_TTL_DAYS")
    max_ttl_days: int = Field(365, validation_alias="SHARE_MAX_TTL_DAYS")


class GenerationSettings(BaseSettings):
    model_config = _BASE_MODEL_CONFIG

    title_max_len: int = Field(120, validation_alias="GENERATION_TITLE_MAX_LEN")
    title_min_candidates: int = Field(3, validation_alias="GENERATION_TITLE_MIN_CANDIDATES")
    suggestion_max_len: int = Field(160, validation_alias="GENERATION_SUGGESTION_MAX_LEN")
    suggestion_min_candidates: int = Field(6, validation_alias="GENERATION_SUGGESTION_MIN_CANDIDATES")
    suggestion_count: int = Field(10, validation_alias="GENERATION_SUGGESTION_COUNT")
    suggestion_recent_context_count: int = Field(8, validation_alias="GENERATION_SUGGESTION_RECENT_CONTEXT_COUNT")


class EmbeddingsSettings(BaseSettings):
    """Per-conversation message-embedding pipeline (pgvector).

    Embeddings are generated by the agents service (the bridge holds no OpenAI
    key) and stored locally. A background sweeper fills them in off the request
    path and also backfills history, so nothing here touches the inference flow.
    """
    model_config = _BASE_MODEL_CONFIG

    enabled: bool = Field(True, validation_alias="EMBEDDINGS_ENABLED")
    # Path on the agents service that returns one vector per input text.
    embed_path: str = Field("/embed", validation_alias="EMBEDDINGS_EMBED_PATH")
    # Must match the agents EMBEDDING_DIMENSIONS and migration 0010's column.
    dimensions: int = Field(1536, validation_alias="EMBEDDINGS_DIMENSIONS")
    # Longest content slice (chars) embedded per message — caps cost/latency on
    # very long messages; the head reliably carries the topic.
    max_chars_per_message: int = Field(8000, validation_alias="EMBEDDINGS_MAX_CHARS_PER_MESSAGE")
    # Sweeper: how many unembedded messages to claim + embed per pass.
    sweeper_batch_size: int = Field(64, validation_alias="EMBEDDINGS_SWEEPER_BATCH_SIZE")
    # Pause between passes — short when a pass found work, longer when idle.
    sweeper_active_seconds: float = Field(0.75, validation_alias="EMBEDDINGS_SWEEPER_ACTIVE_SECONDS")
    sweeper_idle_seconds: float = Field(8.0, validation_alias="EMBEDDINGS_SWEEPER_IDLE_SECONDS")
    # Semantic search: default + max conversations returned, and how many
    # nearest messages to scan before rolling up to distinct conversations.
    # Per-message content cap returned to the agent's memory-search tool (chars).
    tool_message_max_chars: int = Field(800, validation_alias="EMBEDDINGS_TOOL_MESSAGE_MAX_CHARS")
    # Max messages the agent's memory-search tool may request in one call.
    tool_max_limit: int = Field(20, validation_alias="EMBEDDINGS_TOOL_MAX_LIMIT")


class HttpTimeoutSettings(BaseSettings):
    model_config = _BASE_MODEL_CONFIG

    agents_connect_seconds: float = Field(10.0, validation_alias="HTTP_AGENTS_CONNECT_SECONDS")
    agents_read_seconds: float = Field(30.0, validation_alias="HTTP_AGENTS_READ_SECONDS")
    agents_write_seconds: float = Field(30.0, validation_alias="HTTP_AGENTS_WRITE_SECONDS")
    agents_pool_seconds: float = Field(10.0, validation_alias="HTTP_AGENTS_POOL_SECONDS")

    generation_connect_seconds: float = Field(10.0, validation_alias="HTTP_GENERATION_CONNECT_SECONDS")
    generation_read_seconds: float = Field(120.0, validation_alias="HTTP_GENERATION_READ_SECONDS")
    generation_write_seconds: float = Field(120.0, validation_alias="HTTP_GENERATION_WRITE_SECONDS")
    generation_pool_seconds: float = Field(10.0, validation_alias="HTTP_GENERATION_POOL_SECONDS")

    skills_connect_seconds: float = Field(10.0, validation_alias="HTTP_SKILLS_CONNECT_SECONDS")
    skills_read_seconds: float = Field(15.0, validation_alias="HTTP_SKILLS_READ_SECONDS")
    skills_write_seconds: float = Field(10.0, validation_alias="HTTP_SKILLS_WRITE_SECONDS")
    skills_pool_seconds: float = Field(10.0, validation_alias="HTTP_SKILLS_POOL_SECONDS")
    # Adding a remote skill may download and verify up to 128 files upstream
    # before it answers (plan 30) — the agents service caps that at 60 s, so
    # this read timeout sits just above it rather than at the 15 s default.
    skills_remote_add_read_seconds: float = Field(75.0, validation_alias="HTTP_SKILLS_REMOTE_ADD_READ_SECONDS")

    voice_connect_seconds: float = Field(15.0, validation_alias="HTTP_VOICE_CONNECT_SECONDS")
    voice_read_seconds: float = Field(75.0, validation_alias="HTTP_VOICE_READ_SECONDS")
    voice_write_seconds: float = Field(75.0, validation_alias="HTTP_VOICE_WRITE_SECONDS")
    voice_pool_seconds: float = Field(15.0, validation_alias="HTTP_VOICE_POOL_SECONDS")

    inference_connect_seconds: float = Field(30.0, validation_alias="HTTP_INFERENCE_CONNECT_SECONDS")
    inference_read_seconds: float = Field(180.0, validation_alias="HTTP_INFERENCE_READ_SECONDS")
    inference_write_seconds: float = Field(180.0, validation_alias="HTTP_INFERENCE_WRITE_SECONDS")
    inference_pool_seconds: float = Field(30.0, validation_alias="HTTP_INFERENCE_POOL_SECONDS")
    # A manual compaction (plan 34) is one summary call over most of the
    # conversation, made while the user waits — bounded below nginx's 300 s on
    # /api/ so the browser always gets the bridge's own answer.
    compaction_read_seconds: float = Field(240.0, validation_alias="HTTP_COMPACTION_READ_SECONDS")

    embeddings_connect_seconds: float = Field(10.0, validation_alias="HTTP_EMBEDDINGS_CONNECT_SECONDS")
    embeddings_read_seconds: float = Field(60.0, validation_alias="HTTP_EMBEDDINGS_READ_SECONDS")
    embeddings_write_seconds: float = Field(30.0, validation_alias="HTTP_EMBEDDINGS_WRITE_SECONDS")
    embeddings_pool_seconds: float = Field(10.0, validation_alias="HTTP_EMBEDDINGS_POOL_SECONDS")

    @property
    def agents_timeout(self) -> httpx.Timeout:
        return httpx.Timeout(
            connect=self.agents_connect_seconds,
            read=self.agents_read_seconds,
            write=self.agents_write_seconds,
            pool=self.agents_pool_seconds,
        )

    @property
    def generation_timeout(self) -> httpx.Timeout:
        return httpx.Timeout(
            connect=self.generation_connect_seconds,
            read=self.generation_read_seconds,
            write=self.generation_write_seconds,
            pool=self.generation_pool_seconds,
        )

    @property
    def skills_timeout(self) -> httpx.Timeout:
        return httpx.Timeout(
            connect=self.skills_connect_seconds,
            read=self.skills_read_seconds,
            write=self.skills_write_seconds,
            pool=self.skills_pool_seconds,
        )

    @property
    def skills_remote_add_timeout(self) -> httpx.Timeout:
        return httpx.Timeout(
            connect=self.skills_connect_seconds,
            read=self.skills_remote_add_read_seconds,
            write=self.skills_write_seconds,
            pool=self.skills_pool_seconds,
        )

    @property
    def voice_timeout(self) -> httpx.Timeout:
        return httpx.Timeout(
            connect=self.voice_connect_seconds,
            read=self.voice_read_seconds,
            write=self.voice_write_seconds,
            pool=self.voice_pool_seconds,
        )

    @property
    def inference_timeout(self) -> httpx.Timeout:
        return httpx.Timeout(
            connect=self.inference_connect_seconds,
            read=self.inference_read_seconds,
            write=self.inference_write_seconds,
            pool=self.inference_pool_seconds,
        )

    @property
    def compaction_timeout(self) -> httpx.Timeout:
        return httpx.Timeout(
            connect=self.inference_connect_seconds,
            read=self.compaction_read_seconds,
            write=self.inference_write_seconds,
            pool=self.inference_pool_seconds,
        )

    @property
    def embeddings_timeout(self) -> httpx.Timeout:
        return httpx.Timeout(
            connect=self.embeddings_connect_seconds,
            read=self.embeddings_read_seconds,
            write=self.embeddings_write_seconds,
            pool=self.embeddings_pool_seconds,
        )


class VoiceSettings(BaseSettings):
    model_config = _BASE_MODEL_CONFIG

    realtime_model: str = Field("gpt-realtime", validation_alias="OPENAI_REALTIME_MODEL")
    default_realtime_voice: str = Field("alloy", validation_alias="REALTIME_DEFAULT_VOICE")
    # Must stay in sync with REALTIME_VOICES in the frontend
    # (agentic_ui/src/shared/lib/consts/voice.ts) — this list also gates the
    # read-aloud voice, so a value the picker cannot display is a value the user
    # can never see or correct.
    #
    # `nova` was previously here: a leftover from when read-aloud had its own TTS
    # catalog. It is a classic TTS voice, not an OpenAI *realtime* voice, and the
    # frontend never offered it — so a `nova` written straight to the DB passed
    # validation here and then silently displayed as the first voice in the
    # picker instead.
    supported_realtime_voices: frozenset[str] = Field(
        default=frozenset(
            {"alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"}
        ),
        validation_alias="REALTIME_SUPPORTED_VOICES",
    )

    @field_validator("default_realtime_voice", mode="after")
    @classmethod
    def _normalize_voice(cls, v: str) -> str:
        normalized = v.strip().lower()
        return normalized or "alloy"

    @field_validator("supported_realtime_voices", mode="before")
    @classmethod
    def _parse_voices(cls, v: object) -> object:
        if isinstance(v, frozenset):
            return v
        items = _split_csv(v)
        return frozenset(items) if items else v

    # The language voice mode OPENS in. It is not a lock: the instruction built
    # from it tells the model to mirror whatever language the user actually
    # speaks, so this only decides the first turn.
    #
    # Widening this list costs nothing but a line — the instruction is one
    # template with the language interpolated, not a hand-written prompt per
    # language, and the Realtime transcription config pins no language either
    # (see agents/router/voice.py: `transcription` carries a model, no locale).
    #
    # It IS an allow-list rather than free text on purpose: the value is
    # interpolated into the model's system instruction, so accepting arbitrary
    # client input here would be a prompt-injection surface.
    #
    # Must stay in sync with VOICE_MODE_LANGUAGES in the frontend
    # (agentic_ui/src/shared/lib/consts/voice.ts) — a value the picker cannot
    # display is a value the user can never see or correct.
    default_voice_mode_language: str = Field("english", validation_alias="VOICE_MODE_DEFAULT_LANGUAGE")
    supported_voice_mode_languages: frozenset[str] = Field(
        default=frozenset(
            {
                "english",
                "greek",
                "spanish",
                "french",
                "german",
                "italian",
                "portuguese",
                "dutch",
                "polish",
                "romanian",
                "turkish",
                "arabic",
                "hindi",
                "russian",
                "ukrainian",
                "chinese",
                "japanese",
                "korean",
            }
        ),
        validation_alias="VOICE_MODE_SUPPORTED_LANGUAGES",
    )

    @field_validator("default_voice_mode_language", mode="after")
    @classmethod
    def _normalize_language(cls, v: str) -> str:
        normalized = v.strip().lower()
        return normalized or "english"

    @field_validator("supported_voice_mode_languages", mode="before")
    @classmethod
    def _parse_languages(cls, v: object) -> object:
        if isinstance(v, frozenset):
            return v
        items = _split_csv(v)
        return frozenset(items) if items else v


class ProxySettings(BaseSettings):
    model_config = _BASE_MODEL_CONFIG

    header_name: str = Field("X-Internal-Proxy-Secret", validation_alias="TRUSTED_PROXY_HEADER_NAME")
    secret: SecretStr = Field(default_factory=lambda: SecretStr(""))

    @field_validator("secret", mode="before")
    @classmethod
    def _load_secret(cls, value: object) -> object:
        if isinstance(value, SecretStr) and value.get_secret_value():
            return value
        if isinstance(value, str) and value:
            return value
        resolved = _resolve_file_backed_secret("TRUSTED_PROXY_SECRET")
        return resolved if resolved else ""


class RedisSettings(BaseSettings):
    model_config = _BASE_MODEL_CONFIG

    url: str = Field("redis://redis:6379/0", validation_alias="REDIS_URL")
    password: SecretStr = Field(default_factory=lambda: SecretStr(""))
    stream_maxlen: int = Field(20000, validation_alias="REDIS_STREAM_MAXLEN")
    terminal_ttl_seconds: int = Field(3600, validation_alias="REDIS_STREAM_TERMINAL_TTL_SECONDS")
    read_block_ms: int = Field(30000, validation_alias="REDIS_STREAM_READ_BLOCK_MS")

    @field_validator("password", mode="before")
    @classmethod
    def _load_password(cls, value: object) -> object:
        if isinstance(value, SecretStr) and value.get_secret_value():
            return value
        if isinstance(value, str) and value:
            return value
        resolved = _resolve_file_backed_secret("REDIS_PASSWORD")
        return resolved if resolved else ""


class RateLimitSettings(BaseSettings):
    model_config = _BASE_MODEL_CONFIG

    # Per resolved client IP, per window, on GET /oidc/login — starting a
    # Microsoft sign-in. Raised from 4 because one sign-in is not one start:
    # "add another account" starts a second, and behind a NAT or corporate proxy
    # several people share the same resolved IP — 4/min locked out legitimate
    # users. Password brute force is no longer ours to throttle (Entra owns the
    # credential); this bounds redirect-flow abuse and Redis flow-state churn.
    auth_max_attempts: int = Field(15, validation_alias="AUTH_RATE_LIMIT_MAX_ATTEMPTS")
    auth_window_seconds: int = Field(60, validation_alias="AUTH_RATE_LIMIT_WINDOW_SECONDS")
    inference_max_attempts: int = Field(10, validation_alias="INFERENCE_RATE_LIMIT_MAX_ATTEMPTS")
    inference_window_seconds: int = Field(60, validation_alias="INFERENCE_RATE_LIMIT_WINDOW_SECONDS")
    # Speech endpoints (dictation, read-aloud, previews) proxy paid OpenAI
    # audio APIs — strict per-user ceiling, distinct from the inference one.
    speech_max_attempts: int = Field(20, validation_alias="SPEECH_RATE_LIMIT_MAX_ATTEMPTS")
    speech_window_seconds: int = Field(60, validation_alias="SPEECH_RATE_LIMIT_WINDOW_SECONDS")
    # Realtime voice session creation opens a paid OpenAI Realtime session —
    # the most expensive single call in the API.
    voice_session_max_attempts: int = Field(15, validation_alias="VOICE_SESSION_RATE_LIMIT_MAX_ATTEMPTS")
    voice_session_window_seconds: int = Field(60, validation_alias="VOICE_SESSION_RATE_LIMIT_WINDOW_SECONDS")
    # PDF export renders a whole conversation server-side (CPU/memory heavy).
    export_pdf_max_attempts: int = Field(10, validation_alias="EXPORT_PDF_RATE_LIMIT_MAX_ATTEMPTS")
    export_pdf_window_seconds: int = Field(60, validation_alias="EXPORT_PDF_RATE_LIMIT_WINDOW_SECONDS")
    # Share-link creation mints public tokens — outward-facing artifacts.
    share_create_max_attempts: int = Field(10, validation_alias="SHARE_CREATE_RATE_LIMIT_MAX_ATTEMPTS")
    share_create_window_seconds: int = Field(60, validation_alias="SHARE_CREATE_RATE_LIMIT_WINDOW_SECONDS")
    # Custom-skill upload writes multi-file folders onto the agents-service disk.
    skill_upload_max_attempts: int = Field(10, validation_alias="SKILL_UPLOAD_RATE_LIMIT_MAX_ATTEMPTS")
    skill_upload_window_seconds: int = Field(60, validation_alias="SKILL_UPLOAD_RATE_LIMIT_WINDOW_SECONDS")
    # Catalogue search runs as the user types (debounced) — generous, but a
    # ceiling, because each call is a full-text query on the agents service.
    skill_catalogue_search_max_attempts: int = Field(60, validation_alias="SKILL_CATALOGUE_SEARCH_RATE_LIMIT_MAX_ATTEMPTS")
    skill_catalogue_search_window_seconds: int = Field(60, validation_alias="SKILL_CATALOGUE_SEARCH_RATE_LIMIT_WINDOW_SECONDS")
    # Adding a remote skill can trigger an outbound download — the tightest
    # skill limit, so the Add route cannot be used as a fetch amplifier.
    skill_remote_add_max_attempts: int = Field(10, validation_alias="SKILL_REMOTE_ADD_RATE_LIMIT_MAX_ATTEMPTS")
    skill_remote_add_window_seconds: int = Field(60, validation_alias="SKILL_REMOTE_ADD_RATE_LIMIT_WINDOW_SECONDS")
    # Minting an export download token. The export itself is bounded by the
    # cooldown column; this only stops a client hammering the token endpoint.
    export_token_max_attempts: int = Field(10, validation_alias="EXPORT_TOKEN_RATE_LIMIT_MAX_ATTEMPTS")
    export_token_window_seconds: int = Field(60, validation_alias="EXPORT_TOKEN_RATE_LIMIT_WINDOW_SECONDS")
    # Requesting or cancelling an account deletion (plan 32): rare by nature.
    account_deletion_max_attempts: int = Field(10, validation_alias="ACCOUNT_DELETION_RATE_LIMIT_MAX_ATTEMPTS")
    account_deletion_window_seconds: int = Field(3600, validation_alias="ACCOUNT_DELETION_RATE_LIMIT_WINDOW_SECONDS")
    profile_update_max_attempts: int = Field(20, validation_alias="PROFILE_UPDATE_RATE_LIMIT_MAX_ATTEMPTS")
    profile_update_window_seconds: int = Field(3600, validation_alias="PROFILE_UPDATE_RATE_LIMIT_WINDOW_SECONDS")
    # Message creation can carry up to the full attachment budget per call —
    # caps blob-storage growth independent of the aggregate budget.
    message_post_max_attempts: int = Field(30, validation_alias="MESSAGE_RATE_LIMIT_MAX_ATTEMPTS")
    message_post_window_seconds: int = Field(60, validation_alias="MESSAGE_RATE_LIMIT_WINDOW_SECONDS")
    # Usage analytics (Settings → Usage, plan 33): read-only aggregates, but a
    # conversation page can count older answers from their event logs, so each
    # page load is real database work — a per-user ceiling, generous for browsing.
    usage_analytics_max_attempts: int = Field(60, validation_alias="USAGE_ANALYTICS_RATE_LIMIT_MAX_ATTEMPTS")
    usage_analytics_window_seconds: int = Field(60, validation_alias="USAGE_ANALYTICS_RATE_LIMIT_WINDOW_SECONDS")
    # Compacting a conversation (plan 34) costs a summary call over most of it;
    # undo shares the budget. Per user — a person compacts a few times a day.
    compaction_max_attempts: int = Field(10, validation_alias="COMPACTION_RATE_LIMIT_MAX_ATTEMPTS")
    compaction_window_seconds: int = Field(600, validation_alias="COMPACTION_RATE_LIMIT_WINDOW_SECONDS")
    # Starter suggestions proxy an LLM generation call on the agents service.
    suggestions_max_attempts: int = Field(10, validation_alias="SUGGESTIONS_RATE_LIMIT_MAX_ATTEMPTS")
    suggestions_window_seconds: int = Field(60, validation_alias="SUGGESTIONS_RATE_LIMIT_WINDOW_SECONDS")
    # Session refresh mints tokens via OCI KMS (a network call each); keyed per client IP
    # (pre-auth path, like login).
    refresh_max_attempts: int = Field(10, validation_alias="REFRESH_RATE_LIMIT_MAX_ATTEMPTS")
    refresh_window_seconds: int = Field(60, validation_alias="REFRESH_RATE_LIMIT_WINDOW_SECONDS")
    # Run-stream WebSocket handshakes — the SDK middleware is HTTP-only, so the
    # socket route enforces this itself (see rate_limit.allow_ws_connect).
    ws_connect_max_attempts: int = Field(20, validation_alias="WS_CONNECT_RATE_LIMIT_MAX_ATTEMPTS")
    ws_connect_window_seconds: int = Field(60, validation_alias="WS_CONNECT_RATE_LIMIT_WINDOW_SECONDS")
    # App-wide per-identity budget (the fastapi-redis-sdk global limiter): one
    # aggregate budget per verified user (per-IP fallback for unauthenticated
    # requests), counted in Redis. Default 300 calls / 60s.
    user_max_calls: int = Field(300, validation_alias="USER_RATE_LIMIT_MAX_CALLS")
    user_window_seconds: int = Field(60, validation_alias="USER_RATE_LIMIT_WINDOW_SECONDS")
    inference_max_active_runs: int = Field(5, validation_alias="INFERENCE_MAX_ACTIVE_RUNS_PER_USER")


class SchedulerSettings(BaseSettings):
    model_config = _BASE_MODEL_CONFIG

    # The in-process scheduler loop (FastAPI lifespan). Disable to run a bridge
    # replica that serves traffic but never fires scheduled tasks.
    enabled: bool = Field(True, validation_alias="SCHEDULER_ENABLED")
    poll_interval_seconds: int = Field(30, validation_alias="SCHEDULER_POLL_INTERVAL_SECONDS")
    # How many due tasks one tick claims (FOR UPDATE SKIP LOCKED) and fires.
    claim_batch_size: int = Field(10, validation_alias="SCHEDULER_CLAIM_BATCH_SIZE")
    # Wall-clock watchdog: a fired run exceeding this is cancelled and the fire
    # marked failed. This is the guard against a headless run hanging forever on
    # a HITL approval gate (the resume signal only ever comes from a live client).
    run_timeout_seconds: int = Field(600, validation_alias="SCHEDULER_RUN_TIMEOUT_SECONDS")
    max_tasks_per_user: int = Field(50, validation_alias="SCHEDULER_MAX_TASKS_PER_USER")
    # Floor on recurring cadence so a task can't hammer the agents service.
    min_interval_seconds: int = Field(300, validation_alias="SCHEDULER_MIN_INTERVAL_SECONDS")


class LoggingSettings(BaseSettings):
    model_config = _BASE_MODEL_CONFIG

    level: str = Field("INFO", validation_alias="LOG_LEVEL")
    format: str = Field("console", validation_alias="LOG_FORMAT")
    timezone: str = Field("Europe/Athens", validation_alias=AliasChoices("LOG_TIMEZONE", "TZ"))
    redaction_secret: SecretStr = Field(default_factory=lambda: SecretStr(""))

    @field_validator("level", mode="after")
    @classmethod
    def _upper(cls, v: str) -> str:
        return v.upper()

    @field_validator("format", mode="after")
    @classmethod
    def _lower(cls, v: str) -> str:
        return v.strip().lower()

    @field_validator("redaction_secret", mode="before")
    @classmethod
    def _load_redaction_secret(cls, value: object) -> object:
        if isinstance(value, SecretStr) and value.get_secret_value():
            return value
        if isinstance(value, str) and value:
            return value
        return _resolve_file_backed_secret("LOG_REDACTION_SECRET") or ""


class CorsSettings(BaseSettings):
    model_config = _BASE_MODEL_CONFIG

    allowed_origins: tuple[str, ...] = Field(
        default=(
            "http://localhost:8080",
            "http://127.0.0.1:8080",
            "http://localhost:8050",
            "http://127.0.0.1:8050",
        ),
        validation_alias="CORS_ALLOWED_ORIGINS",
    )
    allow_credentials: bool = Field(True, validation_alias="CORS_ALLOW_CREDENTIALS")
    allow_methods: tuple[str, ...] = Field(
        default=("GET", "POST", "PUT", "PATCH", "DELETE"),
        validation_alias="CORS_ALLOW_METHODS",
    )
    allow_headers: tuple[str, ...] | None = Field(default=None, validation_alias="CORS_ALLOW_HEADERS")
    expose_headers: tuple[str, ...] = Field(
        default=("Content-Disposition", "Content-Length", "Content-Range", "Accept-Ranges"),
        validation_alias="CORS_EXPOSE_HEADERS",
    )
    max_age_seconds: int = Field(600, validation_alias="CORS_MAX_AGE_SECONDS")
    csrf_header_name: str = Field("X-CSRF-Token", validation_alias="SESSION_CSRF_HEADER_NAME")

    @field_validator("allowed_origins", "allow_methods", "expose_headers", "allow_headers", mode="before")
    @classmethod
    def _parse_csv(cls, v: object) -> object:
        if v is None or isinstance(v, (list, tuple)):
            return v
        return _split_csv(v)

    @model_validator(mode="after")
    def _apply_defaults_and_validate(self) -> "CorsSettings":
        if self.allow_headers is None or not self.allow_headers:
            object.__setattr__(
                self,
                "allow_headers",
                ("Accept", "Content-Type", "Authorization", "Range", "If-Range", self.csrf_header_name),
            )
        if self.allow_credentials and "*" in self.allowed_origins:
            raise ValueError("CORS_ALLOWED_ORIGINS cannot contain '*' when CORS_ALLOW_CREDENTIALS is enabled.")
        return self


class Settings(BaseSettings):
    model_config = _BASE_MODEL_CONFIG

    app: AppSettings = Field(default_factory=AppSettings)
    database: DatabaseSettings = Field(default_factory=DatabaseSettings)
    session: SessionSettings = Field(default_factory=SessionSettings)
    jwt: JWTSettings = Field(default_factory=JWTSettings)
    signing: SigningSettings = Field(default_factory=SigningSettings)
    entra: EntraSettings = Field(default_factory=EntraSettings)
    upstream: UpstreamSettings = Field(default_factory=UpstreamSettings)
    inference: InferenceSettings = Field(default_factory=InferenceSettings)
    voice: VoiceSettings = Field(default_factory=VoiceSettings)
    speech: SpeechSettings = Field(default_factory=SpeechSettings)
    attachments: AttachmentSettings = Field(default_factory=AttachmentSettings)
    share: ShareSettings = Field(default_factory=ShareSettings)
    export: ExportSettings = Field(default_factory=ExportSettings)
    account_deletion: AccountDeletionSettings = Field(default_factory=AccountDeletionSettings)
    profile: ProfileSettings = Field(default_factory=ProfileSettings)
    generation: GenerationSettings = Field(default_factory=GenerationSettings)
    embeddings: EmbeddingsSettings = Field(default_factory=EmbeddingsSettings)
    http: HttpTimeoutSettings = Field(default_factory=HttpTimeoutSettings)
    tls: TlsSettings = Field(default_factory=TlsSettings)
    proxy: ProxySettings = Field(default_factory=ProxySettings)
    redis: RedisSettings = Field(default_factory=RedisSettings)
    rate_limit: RateLimitSettings = Field(default_factory=RateLimitSettings)
    scheduler: SchedulerSettings = Field(default_factory=SchedulerSettings)
    logging: LoggingSettings = Field(default_factory=LoggingSettings)
    cors: CorsSettings = Field(default_factory=CorsSettings)

    @model_validator(mode="after")
    def _finalize_secrets(self) -> "Settings":
        if not self.proxy.secret.get_secret_value():
            raise ValueError(
                "TRUSTED_PROXY_SECRET must be set. "
                "Refusing to start without an internal-caller shared secret."
            )

        # Entra is the only way in (plan 29 Part A). Checked in every
        # environment: with it unconfigured the bridge would boot into a login
        # page with no button and no route that could issue a session — a full
        # outage from one mistyped env var. Crash-looping instead means Swarm
        # keeps the healthy old task.
        if not self.entra.enabled:
            raise ValueError(
                "Microsoft Entra ID is the only login method, but ENTRA_TENANT_ID / "
                "ENTRA_CLIENT_ID / ENTRA_CLIENT_SECRET are not all set. Refusing to start."
            )

        # A usable signer is enforced by SigningSettings itself, in every
        # environment. The file backend is a development tool and is refused
        # anywhere else.
        if self.signing.backend == "file" and self.app.env not in {"development", "test"}:
            raise ValueError(
                "SESSION_SIGNING_BACKEND=file is for local development only; "
                f"APP_ENV={self.app.env!r} must sign with OCI KMS."
            )

        if not self.session.token_secret.get_secret_value():
            if self.app.env not in {"development", "test"}:
                raise ValueError("SESSION_TOKEN_SECRET must be set outside development/test environments.")
            object.__setattr__(self.session, "token_secret", SecretStr(secrets.token_hex(32)))

        if not self.logging.redaction_secret.get_secret_value():
            fallback = self.session.token_secret.get_secret_value() or "dialogue-bridge-log-redaction"
            object.__setattr__(self.logging, "redaction_secret", SecretStr(fallback))
        return self


settings = Settings()
