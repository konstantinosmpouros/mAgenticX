from __future__ import annotations

import os
import secrets
from pathlib import Path

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
    access_ttl_seconds: int = Field(900, validation_alias="SESSION_ACCESS_TTL_SECONDS")
    refresh_ttl_seconds: int = Field(604800, validation_alias="SESSION_REFRESH_TTL_SECONDS")
    max_per_user: int = Field(3, validation_alias="SESSION_MAX_PER_USER")
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
    oidc_role: str = Field("agenticx", validation_alias="VAULT_OIDC_ROLE")
    oidc_path: str = Field("identity/oidc/token", validation_alias="VAULT_OIDC_PATH")
    namespace: str | None = Field(None, validation_alias="VAULT_NAMESPACE")
    timeout: float = Field(10.0, validation_alias="VAULT_HTTP_TIMEOUT")


class TlsSettings(BaseSettings):
    model_config = _BASE_MODEL_CONFIG

    ca_cert_path: str | None = Field(None, validation_alias="INTERNAL_CA_CERT_PATH")


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
    inference_max_active_runs: int = Field(5, validation_alias="INFERENCE_MAX_ACTIVE_RUNS_PER_USER")


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
        return os.getenv("LOG_REDACTION_SECRET", "") or ""


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
    upstream: UpstreamSettings = Field(default_factory=UpstreamSettings)
    inference: InferenceSettings = Field(default_factory=InferenceSettings)
    voice: VoiceSettings = Field(default_factory=VoiceSettings)
    speech: SpeechSettings = Field(default_factory=SpeechSettings)
    attachments: AttachmentSettings = Field(default_factory=AttachmentSettings)
    share: ShareSettings = Field(default_factory=ShareSettings)
    generation: GenerationSettings = Field(default_factory=GenerationSettings)
    http: HttpTimeoutSettings = Field(default_factory=HttpTimeoutSettings)
    tls: TlsSettings = Field(default_factory=TlsSettings)
    proxy: ProxySettings = Field(default_factory=ProxySettings)
    redis: RedisSettings = Field(default_factory=RedisSettings)
    rate_limit: RateLimitSettings = Field(default_factory=RateLimitSettings)
    logging: LoggingSettings = Field(default_factory=LoggingSettings)
    cors: CorsSettings = Field(default_factory=CorsSettings)

    @model_validator(mode="after")
    def _finalize_secrets(self) -> "Settings":
        if not self.proxy.secret.get_secret_value():
            raise ValueError(
                "TRUSTED_PROXY_SECRET must be set. "
                "Refusing to start without an internal-caller shared secret."
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
