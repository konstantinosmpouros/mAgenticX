from __future__ import annotations

import os
import re
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
    # Wrapped in SecretStr (the key is private material) so the paths cannot surface
    # in a settings repr/dump; the CA cert is public, so ca_cert_path stays str.
    client_cert_path: SecretStr | None = Field(None, validation_alias="INTERNAL_CLIENT_CERT_PATH")
    client_key_path: SecretStr | None = Field(None, validation_alias="INTERNAL_CLIENT_KEY_PATH")


class CheckpointerSettings(BaseSettings):
    model_config = _BASE_MODEL_CONFIG

    # psycopg3 conninfo for the durable LangGraph AsyncPostgresSaver. This is a
    # SEPARATE database (`agent_runtime`) on the SAME Postgres instance as the
    # bridge's chat_db. NOTE: this is a raw psycopg conninfo (driver
    # ``postgresql://``), NOT the SQLAlchemy/asyncpg ``postgresql+asyncpg://``
    # form the bridge uses — TLS is expressed as ``sslmode=...&sslrootcert=...``
    # query params, not an ssl SSLContext kwarg. The dev default points at the
    # docker-compose Postgres; prod overrides via env with a password-less URL +
    # AGENT_RUNTIME_DATABASE_PASSWORD_FILE.
    url: SecretStr = Field(
        default=SecretStr("postgresql://admin:admin@chat_postgres:5432/agent_runtime"),
        validation_alias="AGENT_RUNTIME_DATABASE_URL",
    )
    pool_min_size: int = Field(2, validation_alias="AGENT_RUNTIME_POOL_MIN_SIZE")
    pool_max_size: int = Field(20, validation_alias="AGENT_RUNTIME_POOL_MAX_SIZE")
    pool_max_idle: int = Field(300, validation_alias="AGENT_RUNTIME_POOL_MAX_IDLE")
    pool_timeout: float = Field(30.0, validation_alias="AGENT_RUNTIME_POOL_TIMEOUT")
    # Run ``AsyncPostgresSaver.setup()`` (idempotent DDL) on startup. Emergency
    # opt-out mirroring the bridge's RUN_MIGRATIONS_ON_STARTUP knob.
    setup_on_startup: bool = Field(True, validation_alias="AGENT_RUNTIME_SETUP_ON_STARTUP")
    # Strict msgpack deserialization allow-list (blocks the JsonPlusSerializer
    # RCE class, CVE-2025-64439). Exported into the env the langgraph lib reads.
    strict_msgpack: bool = Field(True, validation_alias="LANGGRAPH_STRICT_MSGPACK")
    # Optional AES key for EncryptedSerializer (at-rest encryption of checkpoint
    # blobs). File-backed via LANGGRAPH_AES_KEY_FILE. Empty => no encryption.
    aes_key: SecretStr = Field(default_factory=lambda: SecretStr(""))

    @field_validator("url", mode="before")
    @classmethod
    def _inject_password_and_tls(cls, value: object) -> object:
        """Splice a file/env password into a password-less conninfo and append
        TLS params when an internal CA is configured.

        - Password from ``AGENT_RUNTIME_DATABASE_PASSWORD_FILE`` (Swarm secret)
          is spliced into the userinfo when the URL carries none (prod). An
          inline password (dev ``admin:admin``) always wins.
        - When ``INTERNAL_CA_CERT_PATH`` is set and the URL has no ``sslmode``,
          append ``sslmode=verify-full&sslrootcert=<ca>`` so prod is TLS;
          dev (no CA) stays plaintext.
        """
        raw = value.get_secret_value() if isinstance(value, SecretStr) else value
        if not isinstance(raw, str) or "://" not in raw:
            return value

        password = _resolve_file_backed_secret("AGENT_RUNTIME_DATABASE_PASSWORD")
        if password:
            scheme, sep, rest = raw.partition("://")
            authority, slash, tail = rest.partition("/")
            if "@" in authority:
                userinfo, at, hostport = authority.rpartition("@")
                if ":" not in userinfo:  # no inline password — splice the secret
                    userinfo = f"{userinfo}:{quote(password, safe='')}"
                    raw = f"{scheme}{sep}{userinfo}{at}{hostport}{slash}{tail}"

        ca_path = os.getenv("INTERNAL_CA_CERT_PATH")
        if ca_path and "sslmode" not in raw:
            sep = "&" if "?" in raw else "?"
            raw = f"{raw}{sep}sslmode=verify-full&sslrootcert={ca_path}"
        return raw

    @field_validator("aes_key", mode="before")
    @classmethod
    def _load_aes_key(cls, value: object) -> object:
        if isinstance(value, SecretStr) and value.get_secret_value():
            return value
        if isinstance(value, str) and value:
            return value
        resolved = _resolve_file_backed_secret("LANGGRAPH_AES_KEY")
        return resolved or ""


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


_DEFAULT_REDACTION_SECRET = "agents-log-redaction"


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
        resolved = _resolve_file_backed_secret("LOG_REDACTION_SECRET", "SESSION_TOKEN_SECRET")
        return resolved or _DEFAULT_REDACTION_SECRET


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
    # Conversation-message embeddings for the bridge's pgvector store. 1536 dims
    # keeps vectors within pgvector's HNSW/IVFFlat index limit (2000); changing
    # either value requires re-embedding + a matching bridge migration.
    embedding: str = Field("text-embedding-3-small", validation_alias="EMBEDDING_MODEL")
    embedding_dimensions: int = Field(1536, validation_alias="EMBEDDING_DIMENSIONS")
    realtime: str = Field("gpt-realtime", validation_alias="OPENAI_REALTIME_MODEL")
    realtime_voices: frozenset[str] = Field(
        default=frozenset(
            {"alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"}
        ),
        validation_alias="REALTIME_SUPPORTED_VOICES",
    )

    @field_validator("realtime_voices", mode="before")
    @classmethod
    def _parse_realtime_voices(cls, v: object) -> object:
        if isinstance(v, frozenset):
            return v
        items = _parse_csv(v)
        return frozenset(item.lower() for item in items) if items else v


class RealtimeSettings(BaseSettings):
    model_config = _BASE_MODEL_CONFIG

    api_url: str = Field(
        "https://api.openai.com/v1/realtime/calls", validation_alias="OPENAI_REALTIME_API_URL"
    )
    connect_timeout_seconds: float = Field(15.0, validation_alias="REALTIME_CONNECT_TIMEOUT_SECONDS")
    read_timeout_seconds: float = Field(60.0, validation_alias="REALTIME_READ_TIMEOUT_SECONDS")
    write_timeout_seconds: float = Field(60.0, validation_alias="REALTIME_WRITE_TIMEOUT_SECONDS")
    pool_timeout_seconds: float = Field(15.0, validation_alias="REALTIME_POOL_TIMEOUT_SECONDS")
    error_body_max_chars: int = Field(1000, validation_alias="REALTIME_ERROR_BODY_MAX_CHARS")

    @property
    def timeout(self) -> httpx.Timeout:
        return httpx.Timeout(
            connect=self.connect_timeout_seconds,
            read=self.read_timeout_seconds,
            write=self.write_timeout_seconds,
            pool=self.pool_timeout_seconds,
        )


class GenerationSettings(BaseSettings):
    model_config = _BASE_MODEL_CONFIG

    title_candidate_count: int = Field(4, validation_alias="TITLE_CANDIDATE_COUNT")
    title_min_candidates: int = Field(3, validation_alias="TITLE_MIN_CANDIDATES")
    title_max_len: int = Field(120, validation_alias="TITLE_MAX_LEN")
    title_temperature: float = Field(1.0, validation_alias="TITLE_TEMPERATURE")
    title_max_tokens: int = Field(128, validation_alias="TITLE_MAX_TOKENS")
    suggestion_count: int = Field(10, validation_alias="SUGGESTION_COUNT")
    suggestion_max_len: int = Field(160, validation_alias="SUGGESTION_MAX_LEN")
    suggestion_temperature: float = Field(0.8, validation_alias="SUGGESTION_TEMPERATURE")
    suggestion_max_tokens: int = Field(320, validation_alias="SUGGESTION_MAX_TOKENS")


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

    # --- The two planes -----------------------------------------------------
    # Everything on the agents filesystem hangs off these two roots, both backed
    # by one Docker volume mounted at /var/magenticx. `global_root` holds
    # platform-owned shared assets (built-in agent definitions + the skills
    # catalogue); `workspaces_root` holds one tree per user (their skill pool,
    # their own agent definitions, per-agent memory, tool prefs and every
    # conversation's files). `runtime.filesystem.layout` derives every concrete
    # path from these — nothing else should join path segments by hand.
    global_root: Path = Field(
        Path("/var/magenticx/global"),
        validation_alias="MAGENTICX_GLOBAL_ROOT",
    )
    workspaces_root: Path = Field(
        Path("/var/magenticx/workspaces"),
        validation_alias="MAGENTICX_WORKSPACES_ROOT",
    )

    # Server-side caps for the conversation input/ seeding endpoint (defence in
    # depth — the bridge already enforces these at upload). Mirror the bridge's
    # AttachmentSettings defaults: 25 MB/file, 10 files/turn.
    input_max_file_bytes: int = Field(26214400, validation_alias="INPUT_MAX_FILE_BYTES")
    input_max_files: int = Field(10, validation_alias="INPUT_MAX_FILES")

    # Server-side caps for reading agent-presented deliverables back out of the
    # conversation output/ dir (the present_artifact → generated-attachment
    # path). One run rarely presents many docs, so the count cap is tighter than
    # input; the per-file cap matches input (25 MB) since a report/export can be
    # large. Over-cap files are skipped (logged), not fatal.
    output_max_file_bytes: int = Field(26214400, validation_alias="OUTPUT_MAX_FILE_BYTES")
    output_max_files: int = Field(20, validation_alias="OUTPUT_MAX_FILES")

    # Hard cap on saved memories per (user, agent) — the `remember` tool refuses
    # new entries beyond this (updates to existing ones always go through), so
    # the AGENTS.md index never exceeds this many rows and stays context-cheap.
    memory_max_entries: int = Field(60, validation_alias="MEMORY_MAX_ENTRIES")

    # --- Sandbox-execution kill switch (fail-closed) ------------------------
    # Gates the workspace's ability to run commands at all: deepagents exposes
    # its `execute` tool exactly when the composite default backend implements
    # SandboxBackendProtocol. Today that default is StateBackend (no execution
    # path), but that safety is an accident of defaults — this flag turns it
    # into a verified invariant: while False, workspace assembly REFUSES to
    # mint a sandbox-capable default backend (see runtime/filesystem/
    # workspace.py). Flipping this to True is reserved for the future
    # sandboxed-execution rollout and must never happen before a real
    # isolation kernel (gVisor-class) is in place.
    sandbox_execution_enabled: bool = Field(False, validation_alias="SANDBOX_EXECUTION_ENABLED")

    # --- Workspace retention (input/ and output/ are TTL-erased caches) -----
    # Conversation input/ files are bridge-seeded copies of DB attachment blobs
    # (re-materialized per run), and presented output/ files are read back at
    # run finalize and persisted as generated-attachment blobs — so both dirs
    # are caches of DB-owned data and safe to erase after a TTL. 0 disables
    # that scope's sweep (logged loudly at startup). Sweeper details live in
    # runtime/filesystem/retention.py.
    input_ttl_hours: int = Field(72, validation_alias="WORKSPACE_INPUT_TTL_HOURS")
    output_ttl_hours: int = Field(168, validation_alias="WORKSPACE_OUTPUT_TTL_HOURS")
    retention_sweep_interval_minutes: int = Field(
        60, validation_alias="WORKSPACE_SWEEP_INTERVAL_MINUTES"
    )

    @field_validator("input_ttl_hours", "output_ttl_hours", mode="after")
    @classmethod
    def _bound_ttls(cls, v: int, info) -> int:
        # 0 = disabled; otherwise 1 hour .. 365 days. Negative values are a
        # misconfiguration, not a disable — fail loudly instead of guessing.
        if v < 0 or v > 8760:
            raise ValueError(f"{info.field_name} must be between 0 (disabled) and 8760 hours.")
        return v

    @field_validator("retention_sweep_interval_minutes", mode="after")
    @classmethod
    def _bound_sweep_interval(cls, v: int) -> int:
        if v < 5 or v > 1440:
            raise ValueError("WORKSPACE_SWEEP_INTERVAL_MINUTES must be between 5 and 1440.")
        return v


class SummarizationSettings(BaseSettings):
    model_config = _BASE_MODEL_CONFIG

    # Deep-agent context compaction thresholds. These fire LATER than
    # deepagents' stock defaults (0.85 of the window / 170k tokens) and keep a
    # larger recent window, so summarization stays rare in normal use. The
    # fraction knobs apply to models that expose a token-window profile (e.g.
    # openai:gpt-5 → 272k max_input_tokens → trigger at 0.92·272k ≈ 250k); the
    # token/message knobs are the fallback for profile-less models, where a
    # fraction trigger is invalid. The middleware's ContextOverflowError path
    # still force-compacts if a provider rejects an over-budget request, so a
    # high trigger cannot cause a hard failure — only a (cheap) late retry.
    trigger_fraction: float = Field(0.92, validation_alias="SUMMARIZATION_TRIGGER_FRACTION")
    keep_fraction: float = Field(0.30, validation_alias="SUMMARIZATION_KEEP_FRACTION")
    trigger_tokens: int = Field(200000, validation_alias="SUMMARIZATION_TRIGGER_TOKENS")
    keep_messages: int = Field(20, validation_alias="SUMMARIZATION_KEEP_MESSAGES")


class BridgeSettings(BaseSettings):
    """Connection back to the dialogue_bridge for the rare agent → bridge call.

    The bridge owns chat_db (incl. the pgvector message index), so the memory
    tool reads it through the bridge's internal endpoint rather than touching
    the DB directly. mTLS + the trusted-proxy header are applied by the caller.
    """
    model_config = _BASE_MODEL_CONFIG

    base_url: str = Field("https://dialogue_bridge:8002", validation_alias="DIALOGUE_BRIDGE_URL")
    memory_search_path: str = Field("/v1/internal/memory/search", validation_alias="BRIDGE_MEMORY_SEARCH_PATH")
    request_timeout_seconds: float = Field(20.0, validation_alias="BRIDGE_REQUEST_TIMEOUT_SECONDS")
    connect_timeout_seconds: float = Field(10.0, validation_alias="BRIDGE_CONNECT_TIMEOUT_SECONDS")

    @property
    def memory_search_url(self) -> str:
        return f"{self.base_url.rstrip('/')}{self.memory_search_path}"


# ---------------------------------------------------------------------------
# Top-level settings
# ---------------------------------------------------------------------------
class Settings(BaseSettings):
    model_config = _BASE_MODEL_CONFIG

    app: AppSettings = Field(default_factory=AppSettings)
    api_keys: ApiKeysSettings = Field(default_factory=ApiKeysSettings)
    bridge: BridgeSettings = Field(default_factory=BridgeSettings)
    rag: RagSettings = Field(default_factory=RagSettings)
    mcp: McpSettings = Field(default_factory=McpSettings)
    tls: TlsSettings = Field(default_factory=TlsSettings)
    checkpointer: CheckpointerSettings = Field(default_factory=CheckpointerSettings)
    proxy: ProxySettings = Field(default_factory=ProxySettings)
    logging: LoggingSettings = Field(default_factory=LoggingSettings)
    registry: AgentRegistrySettings = Field(default_factory=AgentRegistrySettings)
    runtime_models: RuntimeModelsSettings = Field(default_factory=RuntimeModelsSettings)
    realtime: RealtimeSettings = Field(default_factory=RealtimeSettings)
    generation: GenerationSettings = Field(default_factory=GenerationSettings)
    workflows: WorkflowsSettings = Field(default_factory=WorkflowsSettings)
    deep_agents: DeepAgentsSettings = Field(default_factory=DeepAgentsSettings)
    filesystem: FilesystemSettings = Field(default_factory=FilesystemSettings)
    summarization: SummarizationSettings = Field(default_factory=SummarizationSettings)

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
        # The shared default is reversible by anyone who reads the source, so it
        # must never reach a running process. When no secret is configured
        # (LOG_REDACTION_SECRET / SESSION_TOKEN_SECRET unset), fall back to a
        # random per-process key — pseudonymization stays one-way, at the cost
        # of cross-restart/replica correlation. Provision a real
        # LOG_REDACTION_SECRET in prod to keep correlation too. Not env-gated on
        # purpose: APP_ENV is unset in prod, so an env check would never fire.
        if self.logging.redaction_secret.get_secret_value() == _DEFAULT_REDACTION_SECRET:
            self.logging.redaction_secret = SecretStr(secrets.token_hex(32))
        return self


settings = Settings()
