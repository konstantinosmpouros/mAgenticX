from __future__ import annotations

import ipaddress
import os
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
    trusted_proxy_cidrs: str = Field("", validation_alias="TRUSTED_PROXY_CIDRS")
    trusted_proxy_secret: SecretStr = Field(
        default_factory=lambda: SecretStr(""), validation_alias="TRUSTED_PROXY_SECRET"
    )
    trusted_proxy_networks: tuple = Field(default_factory=tuple)

    @field_validator("trusted_proxy_secret", mode="before")
    @classmethod
    def _resolve_secret(cls, v: Any) -> Any:
        return _resolve_file_backed_secret("TRUSTED_PROXY_SECRET_FILE", v) or ""

    @model_validator(mode="after")
    def _parse_networks(self) -> "ProxySettings":
        networks = []
        for item in self.trusted_proxy_cidrs.split(","):
            candidate = item.strip()
            if not candidate:
                continue
            try:
                networks.append(ipaddress.ip_network(candidate, strict=False))
            except ValueError:
                continue
        object.__setattr__(self, "trusted_proxy_networks", tuple(networks))
        return self


class Settings(BaseSettings):
    model_config = _BASE_MODEL_CONFIG

    app: AppSettings = Field(default_factory=AppSettings)
    rag: RagSettings = Field(default_factory=RagSettings)
    api_keys: ApiKeysSettings = Field(default_factory=ApiKeysSettings)
    proxy: ProxySettings = Field(default_factory=ProxySettings)


settings = Settings()
