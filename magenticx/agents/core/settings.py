from __future__ import annotations

import json
import os
import re
import secrets
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import quote

import httpx
from pydantic import AliasChoices, BaseModel, ConfigDict, Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


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

    # MCP is an opt-in add-on, off by default: with MCP_GATEWAY_URL empty, runs
    # use the agent's own tools only and the tool catalog reports MCP disabled.
    # Set it (e.g. http://mcp_gateway:8005/sse, with docker-compose-mcp.yaml up)
    # to turn MCP on. A configured gateway that cannot be reached within
    # `connect_timeout_seconds` degrades a run the same way (logged) instead of
    # failing it — see utils/mcp_tools.optional_mcp_session.
    mcp_gateway_url: str = Field("", validation_alias="MCP_GATEWAY_URL")
    manifest_cache_enabled: bool = Field(True, validation_alias="MCP_MANIFEST_CACHE_ENABLED")
    connect_timeout_seconds: float = Field(10.0, gt=0, le=120, validation_alias="MCP_CONNECT_TIMEOUT_SECONDS")

    @property
    def enabled(self) -> bool:
        """True when a gateway URL is configured — the one "is MCP on" check."""
        return bool(self.mcp_gateway_url.strip())


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
    # The credential between services (dialogue_bridge, agents, rag_service, the
    # sandbox runner), sent in the header above. The UI's nginx never holds it:
    # it has TRUSTED_PROXY_SECRET, which only the bridge reads.
    internal_service_secret: SecretStr = Field(default_factory=lambda: SecretStr(""))

    @field_validator("internal_service_secret", mode="before")
    @classmethod
    def _load_secret(cls, value: object) -> object:
        if isinstance(value, SecretStr) and value.get_secret_value():
            return value
        if isinstance(value, str) and value:
            return value
        resolved = _resolve_file_backed_secret("INTERNAL_SERVICE_SECRET")
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


#: How hard a reasoning model thinks before it answers, weakest first. A model
#: lists the levels it accepts in ``ModelInfo.efforts``; the user picks one per
#: message and ``harness.models.effort`` sends it with every model call.
EffortLevel = Literal["minimal", "low", "medium", "high", "xhigh"]
EFFORT_LEVELS: tuple[EffortLevel, ...] = ("minimal", "low", "medium", "high", "xhigh")


class ModelInfo(BaseModel):
    """What the platform knows about one model, beside what LangChain knows.

    A fact left unset falls back to the pinned langchain-openai's model table,
    which knows the models older than it; a model newer than it (gpt-6-luna)
    needs its facts stated here.
    """

    model_config = ConfigDict(extra="forbid")

    # A reasoning model (gpt-5, o3, …): it is asked for its reasoning summary.
    # A non-reasoning model would reject that parameter.
    reasoning: bool | None = None
    # Max input tokens: compaction and the composer's context ring need it.
    context_window: int | None = Field(None, gt=0)
    # The reasoning efforts it accepts, weakest first; none means the user is
    # never offered a choice and no effort is ever sent to it.
    efforts: tuple[EffortLevel, ...] = ()
    # What the picker starts on; must be one of ``efforts``.
    default_effort: EffortLevel | None = None

    @model_validator(mode="after")
    def _default_effort_is_offered(self) -> ModelInfo:
        """A default the model does not accept would be sent and refused."""
        if self.default_effort is not None and self.default_effort not in self.efforts:
            raise ValueError("default_effort must be one of efforts")
        return self


class AgentRegistrySettings(BaseSettings):
    model_config = _BASE_MODEL_CONFIG

    disabled_agent_slugs: tuple[str, ...] = Field(
        default=(), validation_alias="DISABLED_AGENT_SLUGS"
    )

    # The platform's models, `provider:model` -> what to know about it (in
    # order: the builder lists them so). A *user-authored* agent and a
    # workflow's LLM node may select only these: a deliberately short curated
    # allowlist rather than the loose `provider:model` shape accepted for
    # built-ins — a user picking a nonexistent model would produce an agent
    # that fails at run time, and an unbounded choice is a cost surface.
    # Built-in agents are reviewed code and are not constrained by it, but
    # their models' facts live here too. JSON in the env; a bare list (or a
    # comma-separated string) of specs is accepted, every fact then unset.
    allowed_agent_models: Annotated[dict[str, ModelInfo], NoDecode] = Field(
        default_factory=lambda: {
            "openai:gpt-6-luna": ModelInfo(
                reasoning=True, context_window=1_050_000,
                efforts=("low", "medium", "high"), default_effort="medium",
            ),
            "openai:gpt-5": ModelInfo(
                reasoning=True, efforts=("low", "medium", "high"), default_effort="medium",
            ),
            "openai:gpt-4o": ModelInfo(reasoning=False),
            "openai:gpt-4o-mini": ModelInfo(reasoning=False),
        },
        validation_alias="ALLOWED_AGENT_MODELS",
    )

    @field_validator("allowed_agent_models", mode="before")
    @classmethod
    def _parse_models(cls, value: object) -> object:
        """A JSON object of ``spec -> facts``, or a list / comma-separated string of specs."""
        if value is None:
            return {}
        if isinstance(value, str):
            text = value.strip()
            if text.startswith(("{", "[")):
                value = json.loads(text)
            else:
                value = text.split(",")
        if isinstance(value, (list, tuple)):
            return {str(item).strip(): {} for item in value if str(item).strip()}
        return value

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

    main_model: str = Field("openai:gpt-6-luna", validation_alias="OMNI_MAIN_MODEL")
    researcher_model: str = Field("openai:gpt-6-luna", validation_alias="OMNI_RESEARCHER_MODEL")
    writer_model: str = Field("openai:gpt-6-luna", validation_alias="OMNI_WRITER_MODEL")


class ModelProfileSettings(BaseSettings):
    model_config = _BASE_MODEL_CONFIG

    # OpenAI never returns a reasoning model's reasoning, only (when asked) its
    # own summary of it: streamed to the chat's CoT as thoughts and traced to
    # Langfuse. auto / concise / detailed pick its length; off asks for none
    # (OpenAI may require a verified organization for summaries). Which models
    # reason: `ALLOWED_AGENT_MODELS`. See harness/models/reasoning_summary.py.
    reasoning_summary: str = Field(
        "auto", pattern=r"^(auto|concise|detailed|off)$", validation_alias="REASONING_SUMMARY"
    )


class DeepAgentsSettings(BaseModel):
    omni: OmniDeepAgentSettings = Field(default_factory=OmniDeepAgentSettings)


class FilesystemSettings(BaseSettings):
    model_config = _BASE_MODEL_CONFIG

    # --- The global plane --------------------------------------------------
    # Platform-owned shared assets (built-in agent definitions + the skills
    # catalogue) on the magenticx_data volume. `harness.filesystem.layout`
    # derives every concrete path from it — nothing else joins path segments
    # by hand. A conversation's files are rows in agent_runtime instead
    # (harness/conversation_files), so nothing per-user lives on the volume.
    global_root: Path = Field(
        Path("/var/magenticx/global"),
        validation_alias="MAGENTICX_GLOBAL_ROOT",
    )

    # Ceiling on an image handed to the model by `view_image`. Unlike the stream
    # preview this is the *model's* copy, so the cap guards context cost and a
    # decode of something pathological — not display size.
    view_image_max_bytes: int = Field(10485760, validation_alias="VIEW_IMAGE_MAX_BYTES")

    # Caps on reading agent-presented deliverables back to the bridge (the
    # present_artifact → generated-attachment snapshot). One run rarely
    # presents many docs; the per-file cap matches the bridge's attachment
    # limit (25 MB), since the snapshot becomes a downloadable attachment.
    # Over-cap files are skipped (logged), not fatal.
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
    # mint a sandbox-capable default backend (see harness/filesystem/
    # workspace.py). Flipping this to True is reserved for the future
    # sandboxed-execution rollout and must never happen before a real
    # isolation kernel (gVisor-class) is in place.
    sandbox_execution_enabled: bool = Field(False, validation_alias="SANDBOX_EXECUTION_ENABLED")

    # The sandbox runner (plan 11) that `execute` calls: an internal service
    # behind mTLS + the trusted-proxy header, never routed through nginx. Empty
    # means no runner — execution stays off whatever the flag says (see
    # `sandbox_execution_active`). Local: http://sandbox_runner:8090 (plaintext,
    # like every local hop); Dennis: https://sandbox_runner:8090 with mTLS.
    sandbox_runner_url: str = Field("", validation_alias="SANDBOX_RUNNER_URL")
    # Read timeout of one /v1/exec call. Must be LONGER than the runner's own
    # wall-clock kill (SANDBOX_MAX_WALL_SECONDS on the runner), so a slow
    # command comes back as the runner's `killed_reason="timeout"` result rather
    # than a client-side timeout that cannot say whether the command ran. 330 =
    # the runner's 300 s maximum + headroom for the files riding in the body.
    sandbox_runner_timeout_seconds: float = Field(
        330.0, gt=0, le=3600, validation_alias="SANDBOX_RUNNER_TIMEOUT_SECONDS"
    )
    sandbox_runner_connect_timeout_seconds: float = Field(
        10.0, gt=0, le=120, validation_alias="SANDBOX_RUNNER_CONNECT_TIMEOUT_SECONDS"
    )

    @field_validator("sandbox_runner_url", mode="before")
    @classmethod
    def _strip_runner_url(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value

    @property
    def sandbox_execution_active(self) -> bool:
        """The one "does this deployment have `execute`" check: the kill switch
        is on AND a runner is configured. Either missing keeps execution off,
        so a half-configured deployment fails closed."""
        return self.sandbox_execution_enabled and bool(self.sandbox_runner_url)


class ConversationFilesSettings(BaseSettings):
    """A conversation's files, stored in ``agent_runtime`` (plan 36).

    Files live exactly as long as their conversation — there is no TTL and no
    quota. The per-file cap is a technical safety limit (one file is held in
    memory while it is encrypted, written or read), not a storage policy.
    """
    model_config = _BASE_MODEL_CONFIG

    max_file_bytes: int = Field(
        100 * 1024 * 1024, ge=1, validation_alias="CONVERSATION_FILE_MAX_BYTES"
    )
    # Process-wide cache of the user's uploads, fetched from the bridge on
    # first read. Keyed by content hash, so an entry can never go stale.
    input_cache_bytes: int = Field(
        128 * 1024 * 1024, ge=0, validation_alias="CONVERSATION_INPUT_CACHE_BYTES"
    )


class RemoteSkillsSettings(BaseSettings):
    """The remote skill sources (plan 30): a daily index sync, content on Add.

    On by default — the remote sources are the whole skill catalogue now that
    the image bundles none. Setting the flag false is the kill switch: no sync
    loop starts, no outbound request is made, search returns nothing and the
    Add route refuses with 503. The *sources* are not
    configurable here on purpose — the allowlist is security policy and lives
    in code (``harness/skill_registry/remote/sources.py``), where a change goes
    through review; an env-editable list would be an SSRF lever.
    """
    model_config = _BASE_MODEL_CONFIG

    enabled: bool = Field(True, validation_alias="REMOTE_SKILLS_ENABLED")
    sync_interval_hours: int = Field(24, validation_alias="REMOTE_SKILLS_SYNC_INTERVAL_HOURS")
    # The first pass waits this long after boot so it never competes with agent
    # discovery and the checkpointer pool coming up.
    initial_delay_seconds: int = Field(120, validation_alias="REMOTE_SKILLS_SYNC_INITIAL_DELAY_SECONDS")
    # Parallel file reads per sync or Add. Measured: 8 turns a 34-file skill
    # from 10.9 s sequential into 0.7 s, with no errors from GitHub.
    fetch_concurrency: int = Field(8, validation_alias="REMOTE_SKILLS_FETCH_CONCURRENCY")
    connect_timeout_seconds: float = Field(10.0, validation_alias="REMOTE_SKILLS_CONNECT_TIMEOUT_SECONDS")
    read_timeout_seconds: float = Field(30.0, validation_alias="REMOTE_SKILLS_READ_TIMEOUT_SECONDS")
    # Wall-clock ceiling on one Add, so a stalled upstream cannot hold the
    # request (and the bridge's connection) open indefinitely.
    add_timeout_seconds: float = Field(60.0, validation_alias="REMOTE_SKILLS_ADD_TIMEOUT_SECONDS")

    @field_validator("sync_interval_hours", mode="after")
    @classmethod
    def _bound_interval(cls, v: int) -> int:
        # Under an hour would spend the anonymous GitHub budget for nothing:
        # sources change daily at most.
        if v < 1 or v > 168:
            raise ValueError("REMOTE_SKILLS_SYNC_INTERVAL_HOURS must be between 1 and 168.")
        return v

    @field_validator("fetch_concurrency", mode="after")
    @classmethod
    def _bound_concurrency(cls, v: int) -> int:
        if v < 1 or v > 16:
            raise ValueError("REMOTE_SKILLS_FETCH_CONCURRENCY must be between 1 and 16.")
        return v


class SummarizationSettings(BaseSettings):
    model_config = _BASE_MODEL_CONFIG

    # Deep-agent context compaction: compact on its own at 95% of the window
    # (plan 34). Automatic and manual compaction cut at the same place — the
    # latest question — so the keep knobs only bound deepagents' overflow
    # clipping. The fraction knobs apply to models that expose a token-window
    # profile (e.g. openai:gpt-6-luna → 1.05M max_input_tokens → 0.95·1.05M); the
    # token/message knobs are the fallback for profile-less models, where a
    # fraction trigger is invalid. The middleware's ContextOverflowError path
    # still force-compacts if a provider rejects an over-budget request, so a
    # high trigger cannot cause a hard failure — only a (cheap) late retry.
    trigger_fraction: float = Field(0.95, validation_alias="SUMMARIZATION_TRIGGER_FRACTION")
    keep_fraction: float = Field(0.30, validation_alias="SUMMARIZATION_KEEP_FRACTION")
    trigger_tokens: int = Field(200000, validation_alias="SUMMARIZATION_TRIGGER_TOKENS")
    keep_messages: int = Field(20, validation_alias="SUMMARIZATION_KEEP_MESSAGES")
    # A MANUAL compaction (the composer's context ring, plan 34): allowed once
    # the context passes `manual_min_fraction` of the window; it summarizes
    # everything before the latest exchange and keeps that exchange whole (the
    # question, its tool calls and the answer). The UI's ring applies the same
    # 5% floor (MANUAL_COMPACTION_MIN_PERCENT).
    manual_min_fraction: float = Field(0.05, ge=0, lt=1, validation_alias="SUMMARIZATION_MANUAL_MIN_FRACTION")


class RateLimitRetrySettings(BaseSettings):
    """Waiting out a provider rate limit (HTTP 429) instead of failing the run.

    The OpenAI client already retries a 429 a couple of times with a short
    backoff. A per-minute token quota needs longer than that to clear, so
    ``RetryOnRateLimitMiddleware`` waits ``delay_seconds`` (or the provider's
    ``Retry-After`` when larger, up to ``max_delay_seconds``) and re-issues the
    call, up to ``max_attempts`` attempts in all. A 429 is refused before any
    token streams, so re-issuing never duplicates output.
    """
    model_config = _BASE_MODEL_CONFIG

    max_attempts: int = Field(4, ge=1, le=10, validation_alias="MODEL_RATE_LIMIT_RETRY_ATTEMPTS")
    delay_seconds: float = Field(15.0, ge=0, validation_alias="MODEL_RATE_LIMIT_RETRY_DELAY_SECONDS")
    max_delay_seconds: float = Field(120.0, ge=0, validation_alias="MODEL_RATE_LIMIT_RETRY_MAX_DELAY_SECONDS")


class AguiSettings(BaseSettings):
    """Bounds on what the AG-UI event stream carries.

    An image tool result is shrunk to a thumbnail before it is emitted, because
    the stream is persisted (Redis event log + the message row) and a raw image
    would put megabytes there per call. The model keeps the full image — the
    emitter only observes the run.
    """
    model_config = _BASE_MODEL_CONFIG

    image_preview_max_edge: int = Field(512, validation_alias="AGUI_IMAGE_PREVIEW_MAX_EDGE")
    # Hard ceiling on the encoded thumbnail. Over it the image is reported as
    # omitted rather than shipped, so one pathological file cannot bloat a run.
    image_preview_max_bytes: int = Field(49152, validation_alias="AGUI_IMAGE_PREVIEW_MAX_BYTES")


class BridgeSettings(BaseSettings):
    """Connection back to the dialogue_bridge for the rare agent → bridge call.

    The bridge owns chat_db (incl. the pgvector message index), so the memory
    tool reads it through the bridge's internal endpoint rather than touching
    the DB directly. mTLS + the trusted-proxy header are applied by the caller.
    """
    model_config = _BASE_MODEL_CONFIG

    base_url: str = Field("https://dialogue_bridge:8002", validation_alias="DIALOGUE_BRIDGE_URL")
    memory_search_path: str = Field("/v1/internal/memory/search", validation_alias="BRIDGE_MEMORY_SEARCH_PATH")
    # The user's uploads behind /conversation/input/ (plan 36).
    conversations_path: str = Field(
        "/v1/internal/conversations", validation_alias="BRIDGE_CONVERSATIONS_PATH"
    )
    request_timeout_seconds: float = Field(20.0, validation_alias="BRIDGE_REQUEST_TIMEOUT_SECONDS")
    connect_timeout_seconds: float = Field(10.0, validation_alias="BRIDGE_CONNECT_TIMEOUT_SECONDS")

    @property
    def memory_search_url(self) -> str:
        return f"{self.base_url.rstrip('/')}{self.memory_search_path}"

    @property
    def conversations_url(self) -> str:
        return f"{self.base_url.rstrip('/')}{self.conversations_path}"


class RedisSettings(BaseSettings):
    """The Redis this service writes its background-task streams to (plan 41).

    Mirrors the bridge's ``RedisSettings``: the same ``REDIS_URL`` and the same
    file-backed ``REDIS_PASSWORD`` secret. ``rediss://`` (Dennis) verifies the
    server against the internal CA; plain ``redis://`` is local dev. The client
    is opened only when async sub-agents are on, so a deployment with the flag
    off never connects.
    """
    model_config = _BASE_MODEL_CONFIG

    url: str = Field("redis://redis:6379/0", validation_alias="REDIS_URL")
    password: SecretStr = Field(default_factory=lambda: SecretStr(""))

    @field_validator("password", mode="before")
    @classmethod
    def _load_password(cls, value: object) -> object:
        if isinstance(value, SecretStr) and value.get_secret_value():
            return value
        if isinstance(value, str) and value:
            return value
        resolved = _resolve_file_backed_secret("REDIS_PASSWORD")
        return resolved if resolved else ""


def _resolve_optional_key(name: str) -> str:
    """A Langfuse key, or ``""`` (tracing off) when its file is missing or unreadable."""
    try:
        return _resolve_file_backed_secret(name) or ""
    except RuntimeError:
        return ""


class LangfuseSettings(BaseSettings):
    """Agent traces to the self-hosted Langfuse (the ../../langfuse sibling).

    An opt-in add-on like MCP and the sandbox: off unless ``LANGFUSE_BASE_URL``
    and both project keys are set, and a run never waits on it — spans leave in
    a background batch, and a Langfuse that is down only costs those traces.
    The base URL is the internal ``http://langfuse-web:3000`` on the
    ``langfuse`` network, never the public hostname. The keys are file-backed
    (``LANGFUSE_PUBLIC_KEY_FILE`` / ``LANGFUSE_SECRET_KEY_FILE``), and unlike
    every other secret here an unreadable key file does not stop the service:
    locally the files come from the Langfuse sibling, which may not be set up,
    and then tracing is simply off.
    """
    model_config = _BASE_MODEL_CONFIG

    base_url: str = Field("", validation_alias="LANGFUSE_BASE_URL")
    public_key: SecretStr = Field(default_factory=lambda: SecretStr(""))
    secret_key: SecretStr = Field(default_factory=lambda: SecretStr(""))
    # Share of runs traced (1.0 = all). Lower it if the volume ever matters.
    sample_rate: float = Field(1.0, ge=0.0, le=1.0, validation_alias="LANGFUSE_SAMPLE_RATE")
    # Per export request; the export runs in a background thread either way.
    timeout_seconds: int = Field(5, ge=1, le=30, validation_alias="LANGFUSE_TIMEOUT_SECONDS")

    @field_validator("public_key", mode="before")
    @classmethod
    def _load_public_key(cls, value: object) -> object:
        if isinstance(value, SecretStr) and value.get_secret_value():
            return value
        if isinstance(value, str) and value.strip():
            return value.strip()
        return _resolve_optional_key("LANGFUSE_PUBLIC_KEY")

    @field_validator("secret_key", mode="before")
    @classmethod
    def _load_secret_key(cls, value: object) -> object:
        if isinstance(value, SecretStr) and value.get_secret_value():
            return value
        if isinstance(value, str) and value.strip():
            return value.strip()
        return _resolve_optional_key("LANGFUSE_SECRET_KEY")

    @property
    def enabled(self) -> bool:
        """True when the URL and both keys are set — the one "is tracing on" check."""
        return bool(
            self.base_url.strip()
            and self.public_key.get_secret_value()
            and self.secret_key.get_secret_value()
        )


class AsyncTasksSettings(BaseSettings):
    """Async sub-agents (plan 41): every sub-agent runs as a background task.

    ``enabled`` is on by default: every sub-agent is an async background task.
    It is not set in any compose file. ``ASYNC_SUBAGENTS_ENABLED=false`` remains
    only as an emergency switch back to the blocking ``task`` tool until the
    cut-over removes that path. The caps fail closed: a refused start is a tool
    error the model reads, never a hang.
    """
    model_config = _BASE_MODEL_CONFIG

    enabled: bool = Field(True, validation_alias="ASYNC_SUBAGENTS_ENABLED")
    # Concurrent unsettled tasks (pending, running, waiting on children) per user.
    max_active_per_user: int = Field(16, ge=1, le=1000, validation_alias="ASYNC_TASKS_MAX_ACTIVE_PER_USER")
    # Unsettled children one parent (the orchestrator's branch, or a task) may have.
    max_children_per_task: int = Field(8, ge=1, le=100, validation_alias="ASYNC_TASKS_MAX_CHILDREN_PER_TASK")
    # The watchdog: one run longer than this is stopped and the task errors.
    run_timeout_seconds: int = Field(1800, ge=10, le=86400, validation_alias="ASYNC_TASKS_RUN_TIMEOUT_SECONDS")
    # Runs one task may have in all (start, updates, resumes, wake-ups).
    max_runs_per_task: int = Field(50, ge=1, le=1000, validation_alias="ASYNC_TASKS_MAX_RUNS_PER_TASK")
    # Lifetime of a task-launch token. A token is minted when an agent is built
    # (per request / per task run), so it must outlive the longest run.
    launch_token_ttl_seconds: int = Field(7200, ge=60, le=86400, validation_alias="ASYNC_TASKS_LAUNCH_TOKEN_TTL_SECONDS")
    # The HMAC key of the launch token. Empty = derived from INTERNAL_SERVICE_SECRET
    # with a domain label (stable across replicas, never the raw secret).
    launch_secret: SecretStr = Field(default_factory=lambda: SecretStr(""))
    # The Agent Protocol base URL the middleware is given. Requests never leave
    # the process (an in-process ASGI transport serves them), so this is only a
    # name; it is what makes deepagents treat the sub-agent as remote (no
    # forwarded context, no parent wake-up of its own).
    self_url: str = Field("http://agents.internal", validation_alias="ASYNC_TASKS_SELF_URL")
    # task:{id}:events — entries kept (approximate), and seconds kept after settle.
    events_maxlen: int = Field(20000, ge=100, validation_alias="ASYNC_TASKS_EVENTS_MAXLEN")
    events_ttl_seconds: int = Field(3600, ge=60, validation_alias="ASYNC_TASKS_EVENTS_TTL_SECONDS")
    # tasks:status / tasks:outbox — entries kept (approximate).
    streams_maxlen: int = Field(10000, ge=100, validation_alias="ASYNC_TASKS_STREAMS_MAXLEN")
    # Characters of a result kept as TaskOut.result_preview (§14.1 caps it at 2000).
    result_preview_chars: int = Field(2000, ge=100, le=2000, validation_alias="ASYNC_TASKS_RESULT_PREVIEW_CHARS")

    @field_validator("launch_secret", mode="before")
    @classmethod
    def _load_launch_secret(cls, value: object) -> object:
        if isinstance(value, SecretStr) and value.get_secret_value():
            return value
        if isinstance(value, str) and value:
            return value
        resolved = _resolve_file_backed_secret("ASYNC_TASKS_LAUNCH_SECRET")
        return resolved or ""


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
    model_profiles: ModelProfileSettings = Field(default_factory=ModelProfileSettings)
    filesystem: FilesystemSettings = Field(default_factory=FilesystemSettings)
    conversation_files: ConversationFilesSettings = Field(default_factory=ConversationFilesSettings)
    remote_skills: RemoteSkillsSettings = Field(default_factory=RemoteSkillsSettings)
    summarization: SummarizationSettings = Field(default_factory=SummarizationSettings)
    rate_limit_retry: RateLimitRetrySettings = Field(default_factory=RateLimitRetrySettings)
    agui: AguiSettings = Field(default_factory=AguiSettings)
    redis: RedisSettings = Field(default_factory=RedisSettings)
    async_tasks: AsyncTasksSettings = Field(default_factory=AsyncTasksSettings)
    langfuse: LangfuseSettings = Field(default_factory=LangfuseSettings)

    @model_validator(mode="after")
    def _require_proxy_secret(self) -> "Settings":
        if not self.proxy.internal_service_secret.get_secret_value():
            raise ValueError(
                "INTERNAL_SERVICE_SECRET must be set. "
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
