from __future__ import annotations

import os
import secrets
from pathlib import Path
from typing import Any

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

_BASE_MODEL_CONFIG = SettingsConfigDict(
    env_file=".env",
    env_file_encoding="utf-8",
    extra="ignore",
    case_sensitive=False,
)


def _resolve_file_backed_secret(env_file_var: str, raw: Any) -> str:
    file_path = os.getenv(env_file_var)
    if file_path:
        try:
            return Path(file_path).read_text().strip()
        except OSError as exc:
            raise RuntimeError(f"Cannot read {env_file_var}={file_path!r}: {exc}") from exc
    if raw is None:
        return ""
    return str(raw).strip()


class AppSettings(BaseSettings):
    model_config = _BASE_MODEL_CONFIG

    environment: str = Field("development", validation_alias="ENVIRONMENT")
    log_level: str = Field("INFO", validation_alias="LOG_LEVEL")
    log_format: str = Field("console", validation_alias="LOG_FORMAT")


_DEFAULT_REDACTION_SECRET = "rag-log-redaction"


class LoggingSettings(BaseSettings):
    model_config = _BASE_MODEL_CONFIG

    redaction_secret: SecretStr = Field(default_factory=lambda: SecretStr(""))

    @field_validator("redaction_secret", mode="before")
    @classmethod
    def _load_redaction_secret(cls, value: Any) -> Any:
        if isinstance(value, SecretStr) and value.get_secret_value():
            return value
        if isinstance(value, str) and value:
            return value
        resolved = _resolve_file_backed_secret("LOG_REDACTION_SECRET_FILE", os.getenv("LOG_REDACTION_SECRET"))
        return resolved or _DEFAULT_REDACTION_SECRET


class RagSettings(BaseSettings):
    model_config = _BASE_MODEL_CONFIG

    host: str = Field("vectordb", validation_alias="RAG_HOST")
    port: int = Field(8000, validation_alias="RAG_PORT")


class ApiKeysSettings(BaseSettings):
    model_config = _BASE_MODEL_CONFIG

    openai: SecretStr | None = Field(None, validation_alias="OPENAI_API_KEY")

    @field_validator("openai", mode="before")
    @classmethod
    def _resolve_openai(cls, v: Any) -> Any:
        raw = _resolve_file_backed_secret("OPENAI_API_KEY_FILE", v)
        return raw or None


class ProxySettings(BaseSettings):
    model_config = _BASE_MODEL_CONFIG

    trusted_proxy_header_name: str = Field(
        "X-Internal-Proxy-Secret", validation_alias="TRUSTED_PROXY_HEADER_NAME"
    )
    trusted_proxy_secret: SecretStr = Field(
        default_factory=lambda: SecretStr(""), validation_alias="TRUSTED_PROXY_SECRET"
    )

    @field_validator("trusted_proxy_secret", mode="before")
    @classmethod
    def _resolve_secret(cls, v: Any) -> Any:
        return _resolve_file_backed_secret("TRUSTED_PROXY_SECRET_FILE", v) or ""


class Settings(BaseSettings):
    model_config = _BASE_MODEL_CONFIG

    app: AppSettings = Field(default_factory=AppSettings)
    rag: RagSettings = Field(default_factory=RagSettings)
    api_keys: ApiKeysSettings = Field(default_factory=ApiKeysSettings)
    proxy: ProxySettings = Field(default_factory=ProxySettings)
    logging: LoggingSettings = Field(default_factory=LoggingSettings)

    @model_validator(mode="after")
    def _require_proxy_secret(self) -> "Settings":
        if not self.proxy.trusted_proxy_secret.get_secret_value():
            raise ValueError(
                "TRUSTED_PROXY_SECRET must be set. "
                "Refusing to start without an internal-caller shared secret."
            )
        return self

    @model_validator(mode="after")
    def _harden_redaction_secret(self) -> "Settings":
        # An unconfigured (or default-sentinel) key must never reach a running
        # process: fall back to a random per-process key so pseudonymization
        # stays one-way. Provision the shared magenticx_log_redaction_secret in
        # prod (LOG_REDACTION_SECRET_FILE) so hashes correlate across services
        # and replicas.
        if self.logging.redaction_secret.get_secret_value() in ("", _DEFAULT_REDACTION_SECRET):
            object.__setattr__(self.logging, "redaction_secret", SecretStr(secrets.token_hex(32)))
        return self


settings = Settings()
