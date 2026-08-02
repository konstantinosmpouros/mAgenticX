from __future__ import annotations

import os
import secrets
from pathlib import Path
from urllib.parse import quote

import httpx
from pydantic import AliasChoices, BaseModel, Field, SecretStr, field_validator, model_validator
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
    # General-purpose HMAC secret (used e.g. for short-lived DOCX-preview tokens);
    # no longer used for auth sessions, which are now stateless Vault-signed JWTs.
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

    @model_validator(mode="after")
    def _apply_cookie_name_defaults(self) -> "SessionSettings":
        host_locked = self.secure and self.domain is None
        defaults = {
            "access_cookie_name": "__Host-mx_session" if host_locked else "mx_session",
            "refresh_cookie_name": "__Host-mx_refresh" if host_locked else "mx_refresh",
            "csrf_cookie_name": "__Host-mx_csrf" if host_locked else "mx_csrf",
        }
        for field_name, default in defaults.items():
            if getattr(self, field_name) is None:
                object.__setattr__(self, field_name, default)
        return self


class VaultSettings(BaseSettings):
    model_config = _BASE_MODEL_CONFIG

    addr: str | None = Field(None, validation_alias="VAULT_URL")
    userpass_mount: str = Field("userpass", validation_alias="VAULT_USERPASS_MOUNT")
    namespace: str | None = Field(None, validation_alias="VAULT_NAMESPACE")
    timeout: float = Field(10.0, validation_alias="VAULT_HTTP_TIMEOUT")

    # AppRole machine identity the bridge uses to sign session JWTs (and read the
    # public keys) via the Transit engine. role_id/secret_id come from mounted
    # secrets in prod (VAULT_ROLE_ID_FILE / VAULT_SECRET_ID_FILE).
    approle_mount: str = Field("approle", validation_alias="VAULT_APPROLE_MOUNT")
    role_id: SecretStr = Field(default_factory=lambda: SecretStr(""))
    secret_id: SecretStr = Field(default_factory=lambda: SecretStr(""))

    # Transit engine + key that signs the JWTs; the RSA private key never leaves Vault.
    transit_mount: str = Field("transit", validation_alias="VAULT_TRANSIT_MOUNT")
    transit_jwt_key: str = Field("jwt-rs256", validation_alias="VAULT_TRANSIT_JWT_KEY")

    @field_validator("role_id", mode="before")
    @classmethod
    def _load_role_id(cls, value: object) -> object:
        if isinstance(value, SecretStr) and value.get_secret_value():
            return value
        if isinstance(value, str) and value:
            return value
        return _resolve_file_backed_secret("VAULT_ROLE_ID") or ""

    @field_validator("secret_id", mode="before")
    @classmethod
    def _load_secret_id(cls, value: object) -> object:
        if isinstance(value, SecretStr) and value.get_secret_value():
            return value
        if isinstance(value, str) and value:
            return value
        return _resolve_file_backed_secret("VAULT_SECRET_ID") or ""


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
    sign_version_cache_seconds: int = Field(60, validation_alias="JWT_SIGN_VERSION_CACHE_SECONDS")

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


class EntraSettings(BaseSettings):
    """Microsoft Entra ID (Azure AD) OIDC provider config.

    The bridge acts as an OIDC Relying Party (authorization-code + PKCE via MSAL)
    and, on a successful Entra login, mints the SAME session JWTs as the userpass
    path — Entra only replaces *how identity is proven*. The whole provider stays
    INERT unless ``tenant_id``, ``client_id`` and ``client_secret`` are all set
    (see ``enabled``), so shipping it default-off changes nothing until configured.
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

    voice_connect_seconds: float = Field(15.0, validation_alias="HTTP_VOICE_CONNECT_SECONDS")
    voice_read_seconds: float = Field(75.0, validation_alias="HTTP_VOICE_READ_SECONDS")
    voice_write_seconds: float = Field(75.0, validation_alias="HTTP_VOICE_WRITE_SECONDS")
    voice_pool_seconds: float = Field(15.0, validation_alias="HTTP_VOICE_POOL_SECONDS")

    inference_connect_seconds: float = Field(30.0, validation_alias="HTTP_INFERENCE_CONNECT_SECONDS")
    inference_read_seconds: float = Field(180.0, validation_alias="HTTP_INFERENCE_READ_SECONDS")
    inference_write_seconds: float = Field(180.0, validation_alias="HTTP_INFERENCE_WRITE_SECONDS")
    inference_pool_seconds: float = Field(30.0, validation_alias="HTTP_INFERENCE_POOL_SECONDS")

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
    supported_realtime_voices: frozenset[str] = Field(
        default=frozenset({"alloy", "ash", "ballad", "coral", "echo", "nova", "sage", "shimmer", "verse", "marin", "cedar"}),
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
    skills_global_ttl_seconds: int = Field(86400, validation_alias="REDIS_SKILLS_GLOBAL_TTL_SECONDS")
    skills_user_registry_ttl_seconds: int = Field(7200, validation_alias="REDIS_SKILLS_USER_REGISTRY_TTL_SECONDS")
    skills_user_agent_ttl_seconds: int = Field(7200, validation_alias="REDIS_SKILLS_USER_AGENT_TTL_SECONDS")

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

    auth_max_attempts: int = Field(4, validation_alias="AUTH_RATE_LIMIT_MAX_ATTEMPTS")
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
    # Message creation can carry up to the full attachment budget per call —
    # caps blob-storage growth independent of the aggregate budget.
    message_post_max_attempts: int = Field(30, validation_alias="MESSAGE_RATE_LIMIT_MAX_ATTEMPTS")
    message_post_window_seconds: int = Field(60, validation_alias="MESSAGE_RATE_LIMIT_WINDOW_SECONDS")
    # Starter suggestions proxy an LLM generation call on the agents service.
    suggestions_max_attempts: int = Field(10, validation_alias="SUGGESTIONS_RATE_LIMIT_MAX_ATTEMPTS")
    suggestions_window_seconds: int = Field(60, validation_alias="SUGGESTIONS_RATE_LIMIT_WINDOW_SECONDS")
    # Session refresh mints tokens via Vault Transit; keyed per client IP
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
    vault: VaultSettings = Field(default_factory=VaultSettings)
    jwt: JWTSettings = Field(default_factory=JWTSettings)
    entra: EntraSettings = Field(default_factory=EntraSettings)
    upstream: UpstreamSettings = Field(default_factory=UpstreamSettings)
    inference: InferenceSettings = Field(default_factory=InferenceSettings)
    voice: VoiceSettings = Field(default_factory=VoiceSettings)
    speech: SpeechSettings = Field(default_factory=SpeechSettings)
    attachments: AttachmentSettings = Field(default_factory=AttachmentSettings)
    share: ShareSettings = Field(default_factory=ShareSettings)
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

        if self.app.env not in {"development", "test"}:
            missing = [
                name
                for name, present in (
                    ("VAULT_URL", bool(self.vault.addr)),
                    ("VAULT_ROLE_ID", bool(self.vault.role_id.get_secret_value())),
                    ("VAULT_SECRET_ID", bool(self.vault.secret_id.get_secret_value())),
                )
                if not present
            ]
            if missing:
                raise ValueError(
                    "Stateless JWT auth requires Vault AppRole + Transit configuration; missing: "
                    + ", ".join(missing)
                    + "."
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
