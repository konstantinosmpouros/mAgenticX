from __future__ import annotations

import os
import re
from pathlib import Path

from pydantic import AliasChoices, BaseModel, Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


_BASE_MODEL_CONFIG = SettingsConfigDict(
    env_file=".env",
    env_file_encoding="utf-8",
    extra="ignore",
    case_sensitive=False,
)


def _resolve_file_backed_secret(*env_names: str) -> str | None:
    """Read a secret from `<NAME>_FILE` indirection or the env var itself.

    Mirrors Docker/K8s file-mounted-secret convention. Raises on unreadable
    `*_FILE` paths instead of silently falling through.
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


def _parse_csv(raw: object) -> tuple[str, ...]:
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


def _normalize_slug(slug: str) -> str:
    return slug.strip().lower()


def _normalize_table_name(value: str) -> str:
    return re.sub(r"\W+", "_", value).strip("_").lower()


# ---------------------------------------------------------------------------
# Sub-settings groups
# ---------------------------------------------------------------------------
class AppSettings(BaseSettings):
    model_config = _BASE_MODEL_CONFIG

    service_name: str = Field("agents", validation_alias="LOG_SERVICE_NAME")
    env: str = Field("development", validation_alias=AliasChoices("APP_ENV", "ENV"))
    version: str = Field("unknown", validation_alias=AliasChoices("APP_VERSION", "IMAGE_TAG"))


class ApiKeysSettings(BaseSettings):
    model_config = _BASE_MODEL_CONFIG

    openai: SecretStr | None = Field(default=None)
    anthropic: SecretStr | None = Field(default=None)

    @field_validator("openai", mode="before")
    @classmethod
    def _load_openai(cls, value: object) -> object:
        if isinstance(value, SecretStr):
            return value if value.get_secret_value() else None
        if isinstance(value, str) and value.strip():
            return value.strip()
        return _resolve_file_backed_secret("OPENAI_API_KEY")

    @field_validator("anthropic", mode="before")
    @classmethod
    def _load_anthropic(cls, value: object) -> object:
        if isinstance(value, SecretStr):
            return value if value.get_secret_value() else None
        if isinstance(value, str) and value.strip():
            return value.strip()
        return _resolve_file_backed_secret("ANTHROPIC_API_KEY")


class RagSettings(BaseSettings):
    model_config = _BASE_MODEL_CONFIG

    base_url: str = Field("https://rag_service:8001", validation_alias="RAG_BASE_URL")
    request_timeout_seconds: int = Field(30, validation_alias="RAG_REQUEST_TIMEOUT_SECONDS")
    connect_timeout_seconds: int = Field(15, validation_alias="RAG_CONNECT_TIMEOUT_SECONDS")

    def retrieve_url(self, collection_name: str) -> str:
        return f"{self.base_url.rstrip('/')}/retrieve/{collection_name}"

    def excel_schema_url(self, table_name: str) -> str:
        return f"{self.base_url.rstrip('/')}/excel/{table_name}/schema"

    def excel_query_url(self, table_name: str) -> str:
        return f"{self.base_url.rstrip('/')}/excel/{table_name}/query/sql"


class McpSettings(BaseSettings):
    model_config = _BASE_MODEL_CONFIG

    mcp_gateway_url: str = Field("http://mcp_gateway:8005/sse", validation_alias="MCP_GATEWAY_URL")
    manifest_cache_enabled: bool = Field(True, validation_alias="MCP_MANIFEST_CACHE_ENABLED")


class TlsSettings(BaseSettings):
    model_config = _BASE_MODEL_CONFIG

    ca_cert_path: str | None = Field(None, validation_alias="INTERNAL_CA_CERT_PATH")


class ProxySettings(BaseSettings):
    model_config = _BASE_MODEL_CONFIG

    trusted_proxy_header_name: str = Field(
        "X-Internal-Proxy-Secret", validation_alias="TRUSTED_PROXY_HEADER_NAME"
    )
    trusted_proxy_secret: SecretStr = Field(default_factory=lambda: SecretStr(""))

    @field_validator("trusted_proxy_secret", mode="before")
    @classmethod
    def _load_secret(cls, value: object) -> object:
        if isinstance(value, SecretStr) and value.get_secret_value():
            return value
        if isinstance(value, str) and value:
            return value
        resolved = _resolve_file_backed_secret("TRUSTED_PROXY_SECRET")
        return resolved if resolved else ""


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
        resolved = (
            _resolve_file_backed_secret("LOG_REDACTION_SECRET", "SESSION_TOKEN_SECRET")
            or "agents-log-redaction"
        )
        return resolved


class AgentRegistrySettings(BaseSettings):
    model_config = _BASE_MODEL_CONFIG

    disabled_agent_slugs: tuple[str, ...] = Field(
        default=(), validation_alias="DISABLED_AGENT_SLUGS"
    )

    @field_validator("disabled_agent_slugs", mode="before")
    @classmethod
    def _parse_slugs(cls, value: object) -> object:
        if isinstance(value, (list, tuple)):
            return tuple(_normalize_slug(str(item)) for item in value if str(item).strip())
        if value is None:
            return ()
        items: list[str] = []
        seen: set[str] = set()
        for part in str(value).split(","):
            candidate = _normalize_slug(part)
            if not candidate or candidate in seen:
                continue
            seen.add(candidate)
            items.append(candidate)
        return tuple(items)


class RuntimeModelsSettings(BaseSettings):
    model_config = _BASE_MODEL_CONFIG

    title: str = Field("openai:gpt-4o-2024-08-06", validation_alias="TITLE_MODEL")
    suggestions: str = Field("openai:gpt-4o-2024-08-06", validation_alias="SUGGESTIONS_MODEL")
    dictation: str = Field("gpt-4o-transcribe", validation_alias="OPENAI_STT_MODEL")
    read_aloud: str = Field("gpt-4o-mini-tts", validation_alias="READ_ALOUD_MODEL")
    read_aloud_voice: str = Field("alloy", validation_alias="READ_ALOUD_VOICE")
    read_aloud_format: str = Field("mp3", validation_alias="READ_ALOUD_FORMAT")
    realtime: str = Field("gpt-realtime", validation_alias="OPENAI_REALTIME_MODEL")


class HRWorkflowSettings(BaseSettings):
    model_config = _BASE_MODEL_CONFIG

    collection_name: str = Field("hr_policies_v4", validation_alias="HR_COLLECTION_NAME")
    retrieve_top_k: int = Field(2, validation_alias="HR_RETRIEVE_TOP_K")
    analysis_model: str = Field("openai:gpt-4o-2024-08-06", validation_alias="HR_ANALYSIS_MODEL")
    simple_generation_model: str = Field("openai:gpt-5-2025-08-07", validation_alias="HR_SIMPLE_GENERATION_MODEL")
    query_reflective_model: str = Field("openai:o3-mini", validation_alias="HR_QUERY_REFLECTIVE_MODEL")
    query_no_reflective_model: str = Field("openai:o3-mini", validation_alias="HR_QUERY_NO_REFLECTIVE_MODEL")
    doc_ranking_model: str = Field("openai:gpt-4.1-2025-04-14", validation_alias="HR_DOC_RANKING_MODEL")
    summarization_model: str = Field("openai:gpt-4o-2024-08-06", validation_alias="HR_SUMMARIZATION_MODEL")
    complex_generation_model: str = Field("openai:gpt-5-2025-08-07", validation_alias="HR_COMPLEX_GENERATION_MODEL")
    reflection_model: str = Field("openai:gpt-4o-2024-08-06", validation_alias="HR_REFLECTION_MODEL")


class OrthodoxWorkflowSettings(BaseSettings):
    model_config = _BASE_MODEL_CONFIG

    collection_name: str = Field("athanasios-muthlinaios", validation_alias="ORTHODOX_COLLECTION_NAME")
    retrieve_top_k: int = Field(10, validation_alias="ORTHODOX_RETRIEVE_TOP_K")
    analysis_model: str = Field("openai:gpt-4o-2024-08-06", validation_alias="ORTHODOX_ANALYSIS_MODEL")
    simple_generation_model: str = Field("openai:o3-mini", validation_alias="ORTHODOX_SIMPLE_GENERATION_MODEL")
    query_reflective_model: str = Field("openai:o3-mini", validation_alias="ORTHODOX_QUERY_REFLECTIVE_MODEL")
    query_no_reflective_model: str = Field("openai:o3-mini", validation_alias="ORTHODOX_QUERY_NO_REFLECTIVE_MODEL")
    summarization_model: str = Field("openai:o4-mini", validation_alias="ORTHODOX_SUMMARIZATION_MODEL")
    complex_generation_model: str = Field("openai:gpt-5-2025-08-07", validation_alias="ORTHODOX_COMPLEX_GENERATION_MODEL")
    reflection_model: str = Field("openai:o4-mini", validation_alias="ORTHODOX_REFLECTION_MODEL")


class RetailWorkflowSettings(BaseSettings):
    model_config = _BASE_MODEL_CONFIG

    source_table_name: str = Field("Financial Sample", validation_alias="RETAIL_TABLE_NAME")
    table_name: str = ""
    schema_timeout_seconds: int = Field(30, validation_alias="RETAIL_SCHEMA_TIMEOUT_SECONDS")
    query_connect_timeout_seconds: int = Field(10, validation_alias="RETAIL_QUERY_CONNECT_TIMEOUT_SECONDS")
    query_timeout_seconds: int = Field(30, validation_alias="RETAIL_QUERY_TIMEOUT_SECONDS")
    analysis_model: str = Field("openai:gpt-4o-2024-08-06", validation_alias="RETAIL_ANALYSIS_MODEL")
    simple_generation_model: str = Field("openai:gpt-4.1-mini-2025-04-14", validation_alias="RETAIL_SIMPLE_GENERATION_MODEL")
    sql_generation_model: str = Field("openai:o4-mini", validation_alias="RETAIL_SQL_GENERATION_MODEL")
    sql_error_generation_model: str = Field("openai:o4-mini", validation_alias="RETAIL_SQL_ERROR_GENERATION_MODEL")
    answer_generation_model: str = Field("openai:gpt-4o-2024-08-06", validation_alias="RETAIL_ANSWER_GENERATION_MODEL")

    @model_validator(mode="after")
    def _derive_table_name(self) -> "RetailWorkflowSettings":
        if not self.table_name:
            object.__setattr__(self, "table_name", _normalize_table_name(self.source_table_name))
        return self


class WorkflowsSettings(BaseModel):
    hr: HRWorkflowSettings = Field(default_factory=HRWorkflowSettings)
    orthodox: OrthodoxWorkflowSettings = Field(default_factory=OrthodoxWorkflowSettings)
    retail: RetailWorkflowSettings = Field(default_factory=RetailWorkflowSettings)


class OmniDeepAgentSettings(BaseSettings):
    model_config = _BASE_MODEL_CONFIG

    main_model: str = Field("openai:gpt-5", validation_alias="OMNI_MAIN_MODEL")
    researcher_model: str = Field("openai:gpt-4o", validation_alias="OMNI_RESEARCHER_MODEL")
    writer_model: str = Field("openai:gpt-4o", validation_alias="OMNI_WRITER_MODEL")


class DeepAgentsSettings(BaseModel):
    omni: OmniDeepAgentSettings = Field(default_factory=OmniDeepAgentSettings)


class FilesystemSettings(BaseSettings):
    model_config = _BASE_MODEL_CONFIG

    # Per-user filesystem root for CompositeBackend mounts. Bind-mounted from
    # the host (or a Docker named volume) so AGENT.md and enabled skills
    # survive container restarts and are shared across this user's agents.
    user_root: Path = Field(
        Path("/var/agents/filesystem"),
        validation_alias="AGENTS_FILESYSTEM_ROOT",
    )

    # Central skills registry shipped inside the image. Read-only at runtime;
    # the user-facing PUT endpoint copies subdirectories of this path into the
    # per-user filesystem when a skill is enabled.
    skills_registry_root: Path = Field(
        Path(__file__).resolve().parent.parent / "skills_registry",
        validation_alias="AGENTS_SKILLS_REGISTRY_ROOT",
    )


# ---------------------------------------------------------------------------
# Top-level settings
# ---------------------------------------------------------------------------
class Settings(BaseSettings):
    model_config = _BASE_MODEL_CONFIG

    app: AppSettings = Field(default_factory=AppSettings)
    api_keys: ApiKeysSettings = Field(default_factory=ApiKeysSettings)
    rag: RagSettings = Field(default_factory=RagSettings)
    mcp: McpSettings = Field(default_factory=McpSettings)
    tls: TlsSettings = Field(default_factory=TlsSettings)
    proxy: ProxySettings = Field(default_factory=ProxySettings)
    logging: LoggingSettings = Field(default_factory=LoggingSettings)
    registry: AgentRegistrySettings = Field(default_factory=AgentRegistrySettings)
    runtime_models: RuntimeModelsSettings = Field(default_factory=RuntimeModelsSettings)
    workflows: WorkflowsSettings = Field(default_factory=WorkflowsSettings)
    deep_agents: DeepAgentsSettings = Field(default_factory=DeepAgentsSettings)
    filesystem: FilesystemSettings = Field(default_factory=FilesystemSettings)

    @model_validator(mode="after")
    def _require_proxy_secret(self) -> "Settings":
        if not self.proxy.trusted_proxy_secret.get_secret_value():
            raise ValueError(
                "TRUSTED_PROXY_SECRET must be set. "
                "Refusing to start without an internal-caller shared secret."
            )
        return self


settings = Settings()
