from __future__ import annotations

from dataclasses import dataclass
import ipaddress
import os
import re

ProxyNetwork = ipaddress.IPv4Network | ipaddress.IPv6Network


def _env_str(name: str, default: str) -> str:
    value = os.getenv(name)
    if value is None:
        return default
    cleaned = value.strip()
    return cleaned or default


def _env_optional_str(name: str) -> str | None:
    value = os.getenv(name)
    if value is None:
        return None
    cleaned = value.strip()
    return cleaned or None


def _env_int(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        return int(value.strip())
    except (TypeError, ValueError):
        return default


def _env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return default


def _normalize_slug(slug: str) -> str:
    return slug.strip().lower()


def _env_slug_list(name: str) -> tuple[str, ...]:
    raw = os.getenv(name, "")
    if not raw:
        return ()

    items: list[str] = []
    seen: set[str] = set()
    for part in raw.split(","):
        candidate = _normalize_slug(part)
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        items.append(candidate)
    return tuple(items)


def _parse_proxy_networks(raw: str) -> tuple[ProxyNetwork, ...]:
    networks: list[ProxyNetwork] = []
    for item in raw.split(","):
        candidate = item.strip()
        if not candidate:
            continue
        try:
            networks.append(ipaddress.ip_network(candidate, strict=False))
        except ValueError:
            continue
    return tuple(networks)


def _normalize_table_name(value: str) -> str:
    return re.sub(r"\W+", "_", value).strip("_").lower()


@dataclass(frozen=True)
class AppConfig:
    service_name: str
    env: str
    version: str


@dataclass(frozen=True)
class ApiKeysConfig:
    openai: str | None
    anthropic: str | None


@dataclass(frozen=True)
class RagConfig:
    base_url: str
    request_timeout_seconds: int
    connect_timeout_seconds: int

    def retrieve_url(self, collection_name: str) -> str:
        root = self.base_url.rstrip("/")
        return f"{root}/retrieve/{collection_name}"

    def excel_schema_url(self, table_name: str) -> str:
        root = self.base_url.rstrip("/")
        return f"{root}/excel/{table_name}/schema"

    def excel_query_url(self, table_name: str) -> str:
        root = self.base_url.rstrip("/")
        return f"{root}/excel/{table_name}/query/sql"


@dataclass(frozen=True)
class McpConfig:
    mcp_gateway_url: str
    manifest_cache_enabled: bool


@dataclass(frozen=True)
class TlsConfig:
    ca_cert_path: str | None


@dataclass(frozen=True)
class ProxyConfig:
    trusted_proxy_header_name: str
    trusted_proxy_secret: str
    trusted_proxy_networks: tuple[ProxyNetwork, ...]


@dataclass(frozen=True)
class LoggingConfig:
    level: str
    format: str
    timezone: str
    redaction_secret: str


@dataclass(frozen=True)
class AgentRegistryConfig:
    disabled_agent_slugs: tuple[str, ...]


@dataclass(frozen=True)
class RuntimeModelsConfig:
    title: str
    dictation: str


@dataclass(frozen=True)
class HRWorkflowConfig:
    collection_name: str
    retrieve_top_k: int
    analysis_model: str
    simple_generation_model: str
    query_reflective_model: str
    query_no_reflective_model: str
    doc_ranking_model: str
    summarization_model: str
    complex_generation_model: str
    reflection_model: str


@dataclass(frozen=True)
class OrthodoxWorkflowConfig:
    collection_name: str
    retrieve_top_k: int
    analysis_model: str
    simple_generation_model: str
    query_reflective_model: str
    query_no_reflective_model: str
    summarization_model: str
    complex_generation_model: str
    reflection_model: str


@dataclass(frozen=True)
class RetailWorkflowConfig:
    source_table_name: str
    table_name: str
    schema_timeout_seconds: int
    query_connect_timeout_seconds: int
    query_timeout_seconds: int
    analysis_model: str
    simple_generation_model: str
    sql_generation_model: str
    sql_error_generation_model: str
    answer_generation_model: str


@dataclass(frozen=True)
class WorkflowConfigs:
    hr: HRWorkflowConfig
    orthodox: OrthodoxWorkflowConfig
    retail: RetailWorkflowConfig


@dataclass(frozen=True)
class OmniDeepAgentConfig:
    main_model: str
    researcher_model: str
    writer_model: str


@dataclass(frozen=True)
class DeepAgentConfigs:
    omni: OmniDeepAgentConfig


@dataclass(frozen=True)
class AgentsConfigs:
    app: AppConfig
    api_keys: ApiKeysConfig
    rag: RagConfig
    mcp: McpConfig
    tls: TlsConfig
    proxy: ProxyConfig
    logging: LoggingConfig
    registry: AgentRegistryConfig
    runtime_models: RuntimeModelsConfig
    workflows: WorkflowConfigs
    deep_agents: DeepAgentConfigs


def load_configs() -> AgentsConfigs:
    service_name = _env_str("LOG_SERVICE_NAME", "agents")
    app_env = _env_str("APP_ENV", _env_str("ENV", "development"))
    app_version = _env_str("APP_VERSION", _env_str("IMAGE_TAG", "unknown"))
    retail_source_table = _env_str("RETAIL_TABLE_NAME", "Financial Sample")

    return AgentsConfigs(
        app=AppConfig(
            service_name=service_name,
            env=app_env,
            version=app_version,
        ),
        api_keys=ApiKeysConfig(
            openai=_env_optional_str("OPENAI_API_KEY"),
            anthropic=_env_optional_str("ANTHROPIC_API_KEY"),
        ),
        rag=RagConfig(
            base_url=_env_str("RAG_BASE_URL", "https://rag_service:8001"),
            request_timeout_seconds=_env_int("RAG_REQUEST_TIMEOUT_SECONDS", 30),
            connect_timeout_seconds=_env_int("RAG_CONNECT_TIMEOUT_SECONDS", 10),
        ),
        mcp=McpConfig(
            mcp_gateway_url=_env_str("MCP_GATEWAY_URL", "http://mcp_gateway:8005/sse"),
            manifest_cache_enabled=_env_bool("MCP_MANIFEST_CACHE_ENABLED", True),
        ),
        tls=TlsConfig(
            ca_cert_path=_env_optional_str("INTERNAL_CA_CERT_PATH"),
        ),
        proxy=ProxyConfig(
            trusted_proxy_header_name=_env_str("TRUSTED_PROXY_HEADER_NAME", "X-Internal-Proxy-Secret"),
            trusted_proxy_secret=_env_str("TRUSTED_PROXY_SECRET", ""),
            trusted_proxy_networks=_parse_proxy_networks(os.getenv("TRUSTED_PROXY_CIDRS", "")),
        ),
        logging=LoggingConfig(
            level=_env_str("LOG_LEVEL", "INFO").upper(),
            format=_env_str("LOG_FORMAT", "console").lower(),
            timezone=_env_str("LOG_TIMEZONE", _env_str("TZ", "Europe/Athens")),
            redaction_secret=_env_str(
                "LOG_REDACTION_SECRET",
                _env_str("SESSION_TOKEN_SECRET", "agents-log-redaction"),
            ),
        ),
        registry=AgentRegistryConfig(
            disabled_agent_slugs=_env_slug_list("DISABLED_AGENT_SLUGS"),
        ),
        runtime_models=RuntimeModelsConfig(
            title=_env_str("TITLE_MODEL", "openai:gpt-4o-2024-08-06"),
            dictation=_env_str("OPENAI_STT_MODEL", "gpt-4o-transcribe"),
        ),
        workflows=WorkflowConfigs(
            hr=HRWorkflowConfig(
                collection_name=_env_str("HR_COLLECTION_NAME", "hr_policies_v4"),
                retrieve_top_k=_env_int("HR_RETRIEVE_TOP_K", 2),
                analysis_model=_env_str("HR_ANALYSIS_MODEL", "openai:gpt-4o-2024-08-06"),
                simple_generation_model=_env_str("HR_SIMPLE_GENERATION_MODEL", "openai:gpt-5-2025-08-07"),
                query_reflective_model=_env_str("HR_QUERY_REFLECTIVE_MODEL", "openai:o3-mini"),
                query_no_reflective_model=_env_str("HR_QUERY_NO_REFLECTIVE_MODEL", "openai:o3-mini"),
                doc_ranking_model=_env_str("HR_DOC_RANKING_MODEL", "openai:gpt-4.1-2025-04-14"),
                summarization_model=_env_str("HR_SUMMARIZATION_MODEL", "openai:gpt-4o-2024-08-06"),
                complex_generation_model=_env_str("HR_COMPLEX_GENERATION_MODEL", "openai:gpt-5-2025-08-07"),
                reflection_model=_env_str("HR_REFLECTION_MODEL", "openai:gpt-4o-2024-08-06"),
            ),
            orthodox=OrthodoxWorkflowConfig(
                collection_name=_env_str("ORTHODOX_COLLECTION_NAME", "athanasios-muthlinaios"),
                retrieve_top_k=_env_int("ORTHODOX_RETRIEVE_TOP_K", 10),
                analysis_model=_env_str("ORTHODOX_ANALYSIS_MODEL", "openai:gpt-4o-2024-08-06"),
                simple_generation_model=_env_str("ORTHODOX_SIMPLE_GENERATION_MODEL", "openai:o3-mini"),
                query_reflective_model=_env_str("ORTHODOX_QUERY_REFLECTIVE_MODEL", "openai:o3-mini"),
                query_no_reflective_model=_env_str("ORTHODOX_QUERY_NO_REFLECTIVE_MODEL", "openai:o3-mini"),
                summarization_model=_env_str("ORTHODOX_SUMMARIZATION_MODEL", "openai:o4-mini"),
                complex_generation_model=_env_str("ORTHODOX_COMPLEX_GENERATION_MODEL", "openai:gpt-5-2025-08-07"),
                reflection_model=_env_str("ORTHODOX_REFLECTION_MODEL", "openai:o4-mini"),
            ),
            retail=RetailWorkflowConfig(
                source_table_name=retail_source_table,
                table_name=_normalize_table_name(retail_source_table),
                schema_timeout_seconds=_env_int("RETAIL_SCHEMA_TIMEOUT_SECONDS", 30),
                query_connect_timeout_seconds=_env_int("RETAIL_QUERY_CONNECT_TIMEOUT_SECONDS", 10),
                query_timeout_seconds=_env_int("RETAIL_QUERY_TIMEOUT_SECONDS", 30),
                analysis_model=_env_str("RETAIL_ANALYSIS_MODEL", "openai:gpt-4o-2024-08-06"),
                simple_generation_model=_env_str("RETAIL_SIMPLE_GENERATION_MODEL", "openai:gpt-4.1-mini-2025-04-14"),
                sql_generation_model=_env_str("RETAIL_SQL_GENERATION_MODEL", "openai:o4-mini"),
                sql_error_generation_model=_env_str("RETAIL_SQL_ERROR_GENERATION_MODEL", "openai:o4-mini"),
                answer_generation_model=_env_str("RETAIL_ANSWER_GENERATION_MODEL", "openai:gpt-4o-2024-08-06"),
            ),
        ),
        deep_agents=DeepAgentConfigs(
            omni=OmniDeepAgentConfig(
                main_model=_env_str("OMNI_MAIN_MODEL", "openai:gpt-5"),
                researcher_model=_env_str("OMNI_RESEARCHER_MODEL", "openai:gpt-4o"),
                writer_model=_env_str("OMNI_WRITER_MODEL", "openai:gpt-4o"),
            ),
        ),
    )


configs = load_configs()
