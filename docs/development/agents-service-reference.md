# Agents Service — Complete Reference (Replication Guide)

This is an exhaustive, replicate-from-scratch reference for the **`agents`** service (`src/agents/`) — the inference and orchestration layer of mAgenticX. It is written so you can lift the whole service into another project and modify it with full understanding of every moving part. Everything here reflects the **current shipped code**, not the checked-in `README.md`, which is stale in several places (it claims in-memory checkpointing when the service now runs a durable `AsyncPostgresSaver`; it points at `runtime/protocols/agui/` when the real path is `runtime/agui/`; it lists 4 endpoints when there are 24 across 7 routers; and it describes co-located `AGENT.md`/`skills/` files for deep agents when those are actually runtime *virtual mounts*).

**Stack:** Python 3.12 · FastAPI `0.135.3` · uvicorn `0.32.0` · LangGraph `1.2.5` · LangChain `1.3.9` · deepagents `0.6.10` · port **8003** · runs as non-root `1000:1000`.

---

## Table of contents

1. [What the service is & owns](#1-what-the-service-is--owns)
2. [Directory structure (actual)](#2-directory-structure-actual)
3. [Bootstrap & lifecycle (`main.py`)](#3-bootstrap--lifecycle-mainpy)
4. [Configuration (`core/settings.py`)](#4-configuration-coresettingspy)
5. [HTTP API — all 24 endpoints](#5-http-api--all-24-endpoints)
6. [The streaming inference endpoint in depth](#6-the-streaming-inference-endpoint-in-depth)
7. [Runtime engine — base classes](#7-runtime-engine--base-classes)
8. [AG-UI streaming protocol](#8-ag-ui-streaming-protocol)
9. [Agent registry & discovery](#9-agent-registry--discovery)
10. [The four built-in agents](#10-the-four-built-in-agents)
11. [MCP integration & tool attachment](#11-mcp-integration--tool-attachment)
12. [Checkpointer & threading model](#12-checkpointer--threading-model)
13. [Filesystem / workspace model](#13-filesystem--workspace-model)
14. [Skills & memory systems](#14-skills--memory-systems)
15. [Middlewares](#15-middlewares)
16. [Observability](#16-observability)
17. [Error handling](#17-error-handling)
18. [Security posture](#18-security-posture)
19. [Integration points](#19-integration-points)
20. [Deployment (Docker, TLS, compose)](#20-deployment-docker-tls-compose)
21. [Schemas reference](#21-schemas-reference)
22. [Replication checklist & sharp edges](#22-replication-checklist--sharp-edges)

---

## 1. What the service is & owns

The agents service is an **internal** microservice. The browser never talks to it — only `dialogue_bridge` (the BFF) does, over an mTLS + shared-secret channel. It owns four concerns:

1. **Agent registry & runtime selection** — discovers agent templates at import, instantiates one per request.
2. **Per-request orchestration & SSE streaming** — runs the agent graph and streams AG-UI events.
3. **Tool discovery & MCP session management** — loads MCP tools per run from the gateway.
4. **Adjacent utility inference** — title/suggestion generation, dictation (STT), read-aloud (TTS), realtime voice, embeddings (proxied for the bridge), and the skills/memory management surface.

It does **not** own auth, chat persistence, rate limiting, or CSRF — those live in `dialogue_bridge`.

```mermaid
flowchart LR
    UI[agentic_ui] --> BFF[dialogue_bridge]
    BFF -->|mTLS + proxy secret| AGENTS[agents service :8003]
    AGENTS --> OPENAI[OpenAI models]
    AGENTS -->|plaintext SSE| MCP[MCP Gateway :8005]
    AGENTS -->|mTLS| RAG[rag_service :8001]
    AGENTS -->|durable checkpoints| PG[(agent_runtime DB)]
    AGENTS -->|reverse: memory search| BFF
    RAG --> VDB[(Chroma / DuckDB)]
```

---

## 2. Directory structure (actual)

```text
src/agents/
├── main.py                     App factory, lifespan, durable checkpointer, /health, router registration
├── schemas.py                  ALL Pydantic request/response models + AgentDefinition (flat, single file)
├── Dockerfile                  python:3.12-slim image; plain uvicorn CMD on :8003
├── requirements.txt            Pinned deps
├── .dockerignore               Excludes secrets/TLS; KEEPS *.md + skills_registry (runtime-discovered)
├── load-secrets-and-exec.sh    Secret-loading shim (reads /run/secrets → env → exec)
├── core/
│   ├── settings.py             Pydantic-settings; every env var; two boot validators
│   ├── tls.py                  Outbound mTLS SSLContext helpers
│   ├── proxy.py                Internal-caller trust + client-IP resolution + internal_service_headers
│   ├── error_handling.py       HTTP/provider/stream error handlers (RUN_ERROR frame encoder)
│   └── clients.py              OpenAI client factory
├── runtime/
│   ├── __init__.py             re-exports LangGraphAgent, DeepAgent
│   ├── abstractions/           ★ what an agent IS: base classes + configurable kinds
│   │   ├── base_agent.py       BaseAgent: identity, config validation, tool selection, manifest, error encoding
│   │   ├── langgraph_agent.py  LangGraphAgent(BaseAgent, ABC): StateGraph build/compile/astream (stream_mode="custom")
│   │   ├── deep_agent.py       DeepAgent(BaseAgent, ABC): deepagents lifecycle, filesystem, subagents, HITL
│   │   ├── agent_spec.py       AgentSpec/ModelSpec/SubAgentSpec/ToolRef — the parsed agent.yaml contract
│   │   ├── yaml_agent.py       YamlDeepAgent: one generic deep agent built from an AgentSpec
│   │   ├── user_agents.py      User-authored agent validation + atomic write/read/delete
│   │   └── agent_seed.py       Boot: seed the image's platform agent folders onto the volume
│   ├── agui/                   ★ AG-UI protocol (NOT runtime/protocols/agui)
│   │   ├── emitter.py          AGUIEmitter — encodes every AG-UI event to SSE bytes
│   │   ├── events.py           Custom event Pydantic models + name constants
│   │   └── normalizer.py       AGUIStreamNormalizer — LangGraph chunk → AG-UI SSE
│   ├── middlewares/
│   │   ├── tool_error.py       ToolErrorMiddleware (tool exception → error ToolMessage)
│   │   └── summarization.py    ConfigurableSummarizationMiddleware + factory + stock-exclusion
│   ├── tools/
│   │   ├── charts.py           ⚠ EMPTY placeholder (no code yet)
│   │   ├── memory_search.py    build_memory_search_tool → search_past_conversations
│   │   └── remember.py         build_remember_tool → remember
│   ├── checkpointer/
│   │   ├── store.py            Process-wide AsyncPostgresSaver handle (set/get/has)
│   │   └── fork.py             seed_thread_from_checkpoint (copy-on-fork for branches)
│   ├── filesystem/
│   │   ├── provisioner.py      Framework-free path helpers + on-disk provisioning
│   │   ├── workspace.py        deepagents CompositeBackend factory + WORKSPACE_WRITE_DENY + sandbox-execution guard
│   │   ├── retention.py        TTL sweeper for conversation input/output caches
│   │   ├── memory.py           AGENTS.md index helpers (remember tool backing)
│   │   └── agent_md_template.py  AGENTS_MD_TEMPLATE seed string
│   └── skill_registry/
│       ├── seed_global_registry.py  Boot: copy image seed → global volume
│       ├── global_manifest.py       Boot: scan global registry → manifest.json
│       └── user_registry.py         Per-user skill pool CRUD
├── utils/
│   ├── agents.py               Registry discovery (_discover_agents, AGENT_REGISTRY)
│   ├── mcp_tools.py            MCP gateway SSE catalog + session helpers
│   ├── prompts.py              Chat payload normalization (strips system messages)
│   ├── title.py                Title generation chain
│   ├── suggestions.py          Starter suggestions chain
│   ├── speech.py               Read-aloud TTS + realtime voice normalization
│   ├── skills.py               Skills registry read-side wrappers
│   └── checkpointer.py         release_checkpoint_unless_paused, emit_checkpoint_committed
├── router/
│   ├── catalog.py              GET /agents, GET /tools
│   ├── embeddings.py           POST /embed
│   ├── generation.py           POST /titles/generate, POST /suggestions/generate
│   ├── inference.py            POST /stream, POST /resume, PUT input-files, POST reap  ★ core
│   ├── memories.py             GET/GET/DELETE memories
│   ├── skills.py               10 skill endpoints (global catalog, user pool, per-agent enablement)
│   └── voice.py                POST /dictate/transcribe, /speech/read-aloud, /realtime/session
├── langgraph_agents/
│   ├── __init__.py             re-exports HRPoliciesAgentV1, OrthodoxAgentV1, RetailAgentV1
│   ├── hr_policies_agent_v1/   {__init__, agents, nodes, prompt_templates, structured_outputs}.py
│   ├── orthodox_agent_v1/      (same 5-file layout)
│   └── retail_agent_v1/        (same 5-file layout)
├── deep_agents/
│   ├── __init__.py             re-exports OmniAgent
│   └── omni_agent/             {__init__, system_prompts}.py  (NO AGENT.md / skills/ on disk)
├── observability/              config, context, events, filters, formatters, middleware, redaction, exception_handlers, operations
└── skills_registry/            The in-image seed catalog of skills (markdown SKILL.md + scripts) — large
```

---

## 3. Bootstrap & lifecycle (`main.py`)

`main.py` (229 lines). Import-time `sys.path.append(PACKAGE_ROOT)` (`main.py:6-7`) makes absolute imports (`from core.settings import settings`) resolve under `uvicorn main:app`. Logging is configured **at import** (`configure_logging()`, `main.py:38`).

**Event-loop exception handler** — `_make_loop_exception_handler` (`main.py:42-68`) installs a loop handler that swallows client-disconnect noise (`CancelledError`, `BrokenPipeError`, `ConnectionResetError`) and a specific uvloop+langgraph `TypeError`, logging everything else and chaining to the previous handler.

**Lifespan** — `_lifespan` (`main.py:185-209`), in strict order:
1. Install the loop exception handler.
2. `seed_global_registry()` — copy the in-image skills seed (`/opt/skills_registry_seed`) into the mounted global volume (`cp -rn` semantics; existing folders win).
3. `rebuild_global_manifest()` — scan the global registry → write `manifest.json`.
4. `reconcile_all_user_manifests()` — heal each user's manifest vs disk.
5. `await _init_durable_checkpointer(app)` — **fail fast/loud** if `agent_runtime` is unreachable.
6. Spawn the **workspace-retention task** (`run_workspace_retention_loop`, `runtime/filesystem/retention.py`) — TTL-erases conversation `input/`/`output/` cache files (both are copies of DB attachment blobs: input is bridge-seeded per run, presented outputs are blob-persisted at finalize). Sweeps every `WORKSPACE_SWEEP_INTERVAL_MINUTES` (jittered) in a worker thread with hard per-pass budgets; symlinks are deleted-as-links and logged as security events; a conversation with writes in the last 30 min is skipped (in-flight run protection); best-effort — failures log and retry, never kill the service.
7. `yield`.
8. Shutdown: cancel the retention task → `pool.close()` → restore loop handler → `shutdown_logging()`.

**Durable checkpointer init** — `_init_durable_checkpointer` (`main.py:115-182`), heavy deps imported lazily:
- `_ensure_checkpointer_database(conninfo)` (`main.py:71-112`) — idempotently `CREATE DATABASE agent_runtime` via the `postgres` maintenance DB (returns early for empty/`postgres` target; **10 retries, 2s apart** on `OperationalError`; race-safe against `DuplicateDatabase`). Needed because `POSTGRES_DB` bootstraps only one DB and `setup()` creates tables, not the database.
- Mirrors `LANGGRAPH_STRICT_MSGPACK` into `os.environ` (the lib reads it from env).
- Opens `AsyncConnectionPool(conninfo=…, min/max/idle/timeout from settings, open=False, check=AsyncConnectionPool.check_connection)` with `conn_kwargs={autocommit:True, row_factory:dict_row, prepare_threshold:None, keepalives:1, keepalives_idle:300, keepalives_interval:30, keepalives_count:3}` (pgbouncer-safe), then `pool.open()` + `pool.wait()`. Stored at `app.state.checkpointer_pool`. The `check=` checkout health-check plus TCP keepalives exist because the Swarm overlay on Dennis drops TCP flows idle ~15 min — without them the `min_size` baseline connections go half-dead overnight and the first morning checkpoint op fails once with `SSL SYSCALL error: EOF detected`.
- **AES at-rest encryption**: if `LANGGRAPH_AES_KEY` set → `EncryptedSerializer.from_pycryptodome_aes()`; else `serde=None`.
- **DDL** (gated on `setup_on_startup`): `AsyncPostgresSaver(conn).setup()` under `pg_advisory_lock(hashtext('langgraph_setup'))` (serializes multi-replica `CREATE INDEX CONCURRENTLY`).
- Wires the process-wide saver: `set_checkpointer(AsyncPostgresSaver(pool[, serde]))`.

**App** — `app = FastAPI(lifespan=_lifespan, title="Agents Service")` (`main.py:212`), `register_exception_handlers(app)`, `app.add_middleware(RequestLoggingMiddleware)`.

**Health** — `GET /health` (`main.py:217`), `include_in_schema=False`, **no auth**, `{"status":"ok"}`.

**Routers** (`main.py:222-228`) — 7 routers included **with no prefix and no tags**, so paths in each router file are final: `catalog`, `embeddings`, `generation`, `inference`, `memories`, `skills`, `voice`.

**Checkpointer accessor** — `runtime/checkpointer/store.py` holds the module-global saver; `get_checkpointer()` raises if unset, `has_checkpointer_initialized()` is a cheap probe. Kept separate from `main` so agent classes never import `main` (avoids a cycle); typed `Any` so importing it doesn't pull the heavy libs.

---

## 4. Configuration (`core/settings.py`)

544 lines. Shared config: `SettingsConfigDict(env_file=".env", extra="ignore", case_sensitive=False)`. Singleton `settings = Settings()`.

**Helpers:** `_resolve_file_backed_secret(*names)` reads `<NAME>_FILE` (raises on unreadable) else `<NAME>` env; `_parse_csv`; `_normalize_slug`; `_normalize_table_name` (`\W+`→`_`, lower).

Settings groups (env alias → default):

- **AppSettings** — `LOG_SERVICE_NAME`→`agents`, `APP_ENV`/`ENV`→`development`, `APP_VERSION`/`IMAGE_TAG`→`unknown`.
- **ApiKeysSettings** — `OPENAI_API_KEY` (SecretStr, file-backed), `ANTHROPIC_API_KEY` (optional).
- **RagSettings** — `RAG_BASE_URL`→`https://rag_service:8001`, `RAG_REQUEST_TIMEOUT_SECONDS`→30, `RAG_CONNECT_TIMEOUT_SECONDS`→15; methods `retrieve_url`, `excel_schema_url`, `excel_query_url`.
- **McpSettings** — `MCP_GATEWAY_URL`→`http://mcp_gateway:8005/sse`, `MCP_MANIFEST_CACHE_ENABLED`→True.
- **TlsSettings** — `INTERNAL_CA_CERT_PATH` (str), `INTERNAL_CLIENT_CERT_PATH`/`INTERNAL_CLIENT_KEY_PATH` (**SecretStr** — paths hidden from repr).
- **CheckpointerSettings** — `AGENT_RUNTIME_DATABASE_URL`→`postgresql://admin:admin@chat_postgres:5432/agent_runtime` (**raw psycopg conninfo**, NOT `+asyncpg`), pool min/max/idle/timeout (2/20/300/30.0), `AGENT_RUNTIME_SETUP_ON_STARTUP`→True, `LANGGRAPH_STRICT_MSGPACK`→True (CVE-2025-64439 mitigation — leave on), `LANGGRAPH_AES_KEY` (SecretStr, empty=off). Validator `_inject_password_and_tls` splices a file-backed password into a password-less URL and appends `sslmode=verify-full&sslrootcert=<ca>` when `INTERNAL_CA_CERT_PATH` set.
- **ProxySettings** — `TRUSTED_PROXY_HEADER_NAME`→`X-Internal-Proxy-Secret`, `TRUSTED_PROXY_SECRET` (SecretStr, file-backed).
- **LoggingSettings** — `LOG_LEVEL`→INFO, `LOG_FORMAT`→console, `LOG_TIMEZONE`/`TZ`→Europe/Athens, `LOG_REDACTION_SECRET`/`SESSION_TOKEN_SECRET` (SecretStr).
- **AgentRegistrySettings** — `DISABLED_AGENT_SLUGS`→() (CSV, normalized, deduped).
- **RuntimeModelsSettings** — `TITLE_MODEL`/`SUGGESTIONS_MODEL`→`openai:gpt-4o-2024-08-06`, `OPENAI_STT_MODEL`→`gpt-4o-transcribe`, `READ_ALOUD_MODEL`→`gpt-4o-mini-tts`, `READ_ALOUD_VOICE`→alloy, `READ_ALOUD_FORMAT`→mp3, `EMBEDDING_MODEL`→`text-embedding-3-small`, `EMBEDDING_DIMENSIONS`→1536 (≤2000 pgvector limit; changing needs re-embed + bridge migration), `OPENAI_REALTIME_MODEL`→`gpt-realtime`, `REALTIME_SUPPORTED_VOICES`→frozenset of 10 voices.
- **RealtimeSettings** — `OPENAI_REALTIME_API_URL`, connect/read/write/pool timeouts (15/60/60/15), `REALTIME_ERROR_BODY_MAX_CHARS`→1000; `.timeout` → `httpx.Timeout`.
- **GenerationSettings** — title candidate count/min/max-len/temp/tokens (4/3/120/1.0/128), suggestion count/max-len/temp/tokens (10/160/0.8/320).
- **Workflow settings** — `HRWorkflowSettings` (`HR_COLLECTION_NAME`→`hr_policies_v4`, `HR_RETRIEVE_TOP_K`→2, 8 per-node models), `OrthodoxWorkflowSettings` (`athanasios-muthlinaios`, k=10, 7 models, no doc-ranking), `RetailWorkflowSettings` (`RETAIL_TABLE_NAME`→`Financial Sample` → normalized `financial_sample`, SQL timeouts, 5 models).
- **DeepAgentsSettings** — `OmniDeepAgentSettings`: `OMNI_MAIN_MODEL`→`openai:gpt-5`, `OMNI_RESEARCHER_MODEL`/`OMNI_WRITER_MODEL`→`openai:gpt-4o`.
- **FilesystemSettings** — `AGENTS_FILESYSTEM_ROOT`→`/var/agents/filesystem`, `SKILLS_REGISTRY_GLOBAL_ROOT`, `SKILLS_REGISTRY_USERS_ROOT`, `INPUT_MAX_FILE_BYTES`→25MB, `INPUT_MAX_FILES`→10, `MEMORY_MAX_ENTRIES`→60.
- **SummarizationSettings** — `SUMMARIZATION_TRIGGER_FRACTION`→0.92, `SUMMARIZATION_KEEP_FRACTION`→0.30, `SUMMARIZATION_TRIGGER_TOKENS`→200000, `SUMMARIZATION_KEEP_MESSAGES`→20.
- **BridgeSettings** — `DIALOGUE_BRIDGE_URL`→`https://dialogue_bridge:8002`, `BRIDGE_MEMORY_SEARCH_PATH`→`/v1/internal/memory/search`, timeouts; `.memory_search_url`.

**Two boot validators** on the top-level `Settings`:
- `_require_proxy_secret` — **raises and refuses to start** if `TRUSTED_PROXY_SECRET` is empty.
- `_harden_redaction_secret` — if the redaction secret is still the default sentinel, replaces it with a random per-process key (`secrets.token_hex(32)`).

---

## 5. HTTP API — all 24 endpoints

Every endpoint below carries `dependencies=[Depends(require_internal_caller)]` (validates the `X-Internal-Proxy-Secret` header via `secrets.compare_digest`; 403 otherwise). No rate limiting, auth, or CSRF anywhere — those are the bridge's job. `/health` is the only unauthenticated route.

| # | Method | Path | Router | Request | Response | Code |
|---|--------|------|--------|---------|----------|------|
| 1 | GET | `/agents` | catalog | — | `List[AgentManifest]` | 200 |
| 2 | GET | `/tools` | catalog | — | `List[ToolManifest]` | 200 |
| 3 | POST | `/embed` | embeddings | `EmbedRequest` | `EmbedResponse` | 200 |
| 4 | POST | `/titles/generate` | generation | `TitleRequest` | `ConversationTitle` | 200 |
| 5 | POST | `/suggestions/generate` | generation | `SuggestionsRequest` | `ConversationSuggestions` | 200 |
| 6 | POST | `/agents/{agent_slug}/stream` | inference | `Request` | SSE `text/event-stream` | 200 |
| 7 | POST | `/agents/{agent_slug}/resume` | inference | `AgentResumeRequest` | SSE `text/event-stream` | 200 |
| 8 | PUT | `/agents/{slug}/users/{uid}/conversations/{cid}/input-files` | inference | `SeedInputFilesRequest` | `SeedInputFilesResponse` | 200 |
| 9 | POST | `/agents/{slug}/users/{uid}/conversations/{cid}/reap` | inference | `ReapConversationRequest` | — | 204 |
| 10 | GET | `/agents/{slug}/users/{uid}/memories` | memories | — | `List[MemoryEntry]` | 200 |
| 11 | GET | `/agents/{slug}/users/{uid}/memories/{name}` | memories | — | `MemoryDetail` | 200 |
| 12 | DELETE | `/agents/{slug}/users/{uid}/memories/{name}` | memories | — | — | 204 |
| 13 | GET | `/skills/global` | skills | `bypass_cache` (query) | `List[SkillManifest]` | 200 |
| 14 | GET | `/users/{uid}/skills` | skills | — | `List[SkillManifestEntry]` | 200 |
| 15 | GET | `/users/{uid}/skills/{skill_name}` | skills | — | `UserSkillDetail` | 200 |
| 16 | POST | `/users/{uid}/skills/global/{skill_name}` | skills | — | — | 204 |
| 17 | POST | `/users/{uid}/skills/custom` | skills | `CustomSkillCreate` | `SkillManifestEntry` | 201 |
| 18 | DELETE | `/users/{uid}/skills/{skill_name}` | skills | — | — | 204 |
| 19 | GET | `/agents/{slug}/users/{uid}/skills` | skills | — | `List[str]` | 200 |
| 20 | PUT | `/agents/{slug}/users/{uid}/skills/{skill_name}` | skills | — | — | 204 |
| 21 | DELETE | `/agents/{slug}/users/{uid}/skills/{skill_name}` | skills | — | — | 204 |
| 22 | POST | `/dictate/transcribe` | voice | multipart file | `TranscriptionResponse` | 200 |
| 23 | POST | `/speech/read-aloud` | voice | `ReadAloudRequest` | audio stream | 200 |
| 24 | POST | `/realtime/session` | voice | `RealtimeSessionRequest` | `RealtimeSessionResponse` | 200 |

**Selected behaviors:**
- **`GET /agents`** — reads `definition.manifest` for each `AGENT_REGISTRY` entry (built once at import), sorted by name.
- **`GET /tools`** — returns the warm manifest cache, else fetches live from the gateway (502 on gateway failure).
- **`POST /embed`** — the bridge has no OpenAI key, so it proxies embedding here (used by its pgvector conversation-embedding sweeper). Cached `OpenAIEmbeddings`; order preserved; 503 if no key; 502 on provider failure.
- **`/titles/generate`, `/suggestions/generate`** — LCEL chain: `RunnableLambda(make_merge_with_template) | init_chat_model(...).with_structured_output(...)`; normalize/trim/dedupe/cap; 502 if too few usable candidates.
- **Voice** — dictation (sync OpenAI STT), read-aloud (TTS via `asyncio.to_thread`, streams audio), realtime (POSTs SDP offer + session config to OpenAI Realtime, returns SDP answer; 503 if no key).

---

## 6. The streaming inference endpoint in depth

`POST /agents/{agent_slug}/stream` (`router/inference.py:32-124`). Body `Request` = `{messages: List[Dict], config: Dict}`.

**`config` shape:**
- `config["context"]` = `{user_id, conversation_id, run_id?, use_memory?, search_past_convs?, personalization?}` (`user_id`+`conversation_id` mandatory; `personalization` = `{personality?, custom_instructions?}` and is present only when effective).
- `config["run_config"]["configurable"]["thread_id"]` = the **branch-scoped checkpoint thread id**.
- **No `config["tools"]`** — the retired global tool-enablement model used to pass the client's enabled list here; it is gone. An agent resolves its own tools (a deep agent's declared `agent.yaml` `tools:` set minus the per-(user, agent) disables in `tool_prefs.json`), so the request carries no tool list.
- `config["fork_from"]` = `{thread_id, checkpoint_id}` for edit/retry forks.

**Pre-flight:** `set_context(...)` for logging → `AGENT_REGISTRY.get(slug)` (404 if unknown) → `agent = definition.cls(config=req.config)` (400 on config-validation error).

**Streaming generator `event_stream()`:**
1. `async with mcp_session_context() as session:` opens an SSE MCP client to the gateway, kept open for the whole run.
2. `live_tools = await load_mcp_tools(session)` (langchain-mcp-adapters) → callable LangChain tools.
3. `agent.attach_tools(live_tools)` → filter the live tools down to the agent's resolved set (a deep agent's `agent.yaml`-declared tools minus its `tool_prefs.json` disables — no longer a client-supplied list); DeepAgent additionally strips reserved deepagents tool names.
4. **Fork** (if `fork_from`): `await agent.ensure_built()` then `seed_thread_from_checkpoint(...)` copies the parent branch's state at the fork point into the new thread.
5. `async for chunk in agent.astream(payload={"messages": req.messages}): yield chunk` — each chunk is an AG-UI SSE byte frame (LangGraph agents emit via a `custom` StreamWriter; deep agents' raw chunks pass through `AGUIStreamNormalizer`).
6. **Terminal frame**: `emit_checkpoint_committed(...)` yields a `CHECKPOINT_COMMITTED` custom event carrying `(thread_id, checkpoint_id)` so the bridge can persist the durable head on the assistant message.

**Cancellation & errors:**
- Client disconnect (`CancelledError`) → silent `return`.
- Any other `Exception` → `agent._encode_run_error(exc)` yields **one** frame: `data: {"type":"RUN_ERROR","message":"..."}\n\n`. **HTTP stays 200** — errors ride inside the SSE body.
- `finally`: `release_checkpoint_unless_paused(agent, run_id)` drops the in-RAM sub-agent namespace cache **unless** parked on a HITL interrupt. The durable Postgres checkpoint is **never** deleted here.

**`POST /agents/{agent_slug}/resume`** (`inference.py:130-339`) — HITL approval/rejection. Body `AgentResumeRequest` (`thread_id`, `decision`, `reason?`, `value?`, `interrupt_id?`, `decisions?`). Forces `thread_id` onto `run_config` → `ensure_built()` → reads `snapshot.interrupts`. Guards: 503 if saver not ready, 404 unknown agent, 409 no pending interrupt, 409 stale `interrupt_id`, 422 `decisions` count mismatch. Builds `Command(resume={"decisions":[...]})` (`approve`→`{"type":"approve"}`, `reject`→`{"type":"reject","message":reason}`), then `agent.astream(payload={"messages": []}, command=resume_command)`. Works across a service restart because the checkpoint is durable.

---

## 7. Runtime engine — base classes

Every `/stream` and `/resume` builds a **fresh** agent instance; the only shared state is the process-wide durable saver and two module-level caches.

### `BaseAgent` (`runtime/abstractions/base_agent.py`)
Not abstract; shared plumbing. `AgentType = Literal["deep agent","langgraph agent"]`.

Class identity attributes (overridden by subclasses as plain class attrs): `name` (slug — registry key + URL), `agent_id`, `label`, `version`, `type`, `description`, `icon`.

`__init__(config=...)` computes: `run_config` (random `thread_id` UUID if omitted), **empty `config_tools`/`config_tool_names`** (no longer seeded from a request tool list — that global model is retired; a deep agent resolves its own tools from `agent.yaml` minus `tool_prefs.json` disables), empty `tools`/`tools_names` (filled per-request by `attach_tools`), `context`, `use_memory` (default True), `personalization` (parsed fail-closed from `context.personalization` by `runtime/personalization.py` — unknown preset → `default`, text re-sanitized + re-capped).

- `manifest()` (classmethod) → the registry dict; reads class attrs only (no instantiation).
- `attach_tools(live_tools)` → `_apply_live_tools(_filter_live_tools(...))`. `_filter_live_tools` keeps only live tools whose cache-key is in the agent's resolved set (declared − disabled); logs `agent_tools_missing`/`agent_tools_resolved`.
- Config validation (`_validate_*`) — **`context` must have non-empty `user_id` AND `conversation_id`** (the invariant deep-agent filesystem provisioning relies on).
- `_encode_run_error(exc)` → the `RUN_ERROR` SSE frame (a raw frame, **not** an AG-UI event).

### `LangGraphAgent(BaseAgent, ABC)` (`runtime/abstractions/langgraph_agent.py`)
`stream_mode = "custom"` — nodes push AG-UI bytes directly through the LangGraph StreamWriter. Abstract hooks: `register_agents()` (LLM chains → `self.agents`), `register_nodes()` (callables → `self.nodes`), `register_graph_nodes(graph)`, `register_graph_edges(graph)`.

- `build()` — if no preset saver, `InMemorySaver()`; register agents+nodes; `StateGraph(self.state)` → add nodes → add edges → `compile(checkpointer=self.memory_saver)`. Degenerate case (no state, no nodes) → `self.graph = self.agents` (bare runnable).
- `ensure_built()` — binds the **shared durable saver** (`get_checkpointer()`) when a `thread_id` exists, else the ephemeral `InMemorySaver`.
- `astream(payload, *, command=None)` — `graph.astream(command or payload, config=self.run_config, stream_mode="custom")`; str/bytes chunks pass through, structured chunks → `agui_normalizer.handle_chunk`; disconnect → silent, other exception → `RUN_ERROR` frame.

### `DeepAgent(BaseAgent, ABC)` (`runtime/abstractions/deep_agent.py`)
`stream_mode = ["messages","updates"]`, `type = "deep agent"`. Wraps deepagents' `create_deep_agent`. Concrete agents implement only `register_agent()`.

- `RESERVED_DEEPAGENT_TOOL_NAMES` = `{write_todos, ls, read_file, write_file, edit_file, glob, grep, execute, task, remember}` — stripped from attached MCP tools (`_apply_live_tools` override).
- `_impl_dir` = the concrete subclass's directory (asset discovery root).
- Lifecycle hooks run in order in `ensure_built()`: `load_skills()` → `["/skills/"]`; `load_memory()` → None; `load_agent_md()` → `["/memories/AGENTS.md"]` (or `[]` if memory off); `register_subagents()`; **`register_agent()`** (abstract, last).
- `build_deep_agent(model, system_prompt, subagents, interrupt_on, middleware)` — the base assembler: builds the CompositeBackend factory, composes middleware (`ToolErrorMiddleware` + tuned summarizer; force-guaranteed on main + each subagent; stock summarizer excluded), appends the personalization block (`runtime/personalization.build_personalization_prompt`, empty when no effective personalization) then `_MEMORY_SYSTEM_PROMPT` when memory on — final prompt order: static instructions → personalization → memory — then `create_deep_agent(model, name, tools=self.tools+self._builtin_tools(), system_prompt, subagents, interrupt_on, middleware, memory=self.agent_md_paths, skills=self.skills_paths, backend, permissions=WORKSPACE_WRITE_DENY, context_schema, checkpointer, store=None)`. Personalization applies to the **main agent only**, never sub-agents.
- `_builtin_tools()` — `remember` (when `use_memory`) + `search_past_conversations` (opt-in via `context.search_past_convs`) + `present_artifact` (when a `conversation_id` exists); `[]` if no `user_id`.
- `astream(...)` — `stream_mode=["messages","updates"]`, **`subgraphs=True`** (surfaces nested sub-agent events).

**`use_memory` gates four things together** (desync any one and the agent lies about its mounts): the `/memories/` mount, the `remember` tool, `load_agent_md()`, and the appended `_MEMORY_SYSTEM_PROMPT`.

**End-to-end lifecycle:** instantiate (validate config, build emitter/normalizer keyed on `run_id`) → `attach_tools` (filter, deep-agent reserved-name strip) → *(fork seed)* → `ensure_built` (bind saver; deep agent runs the 5 hooks) → `astream` → AG-UI frames → terminal `CHECKPOINT_COMMITTED` → cleanup (release RAM cache unless paused).

---

## 8. AG-UI streaming protocol

Two halves: the **emitter** (event object → SSE bytes) and the **normalizer** (raw LangGraph chunk → 0..N emitter calls). Built on Anthropic's `ag_ui` library (`ag_ui.core` event models + `EventEncoder`) plus custom events.

**Wire format** — `AGUIEmitter._emit` stamps a ms timestamp, encodes via `EventEncoder` (standard `data: {json}\n\n`), then injects a top-level `"namespace"` field into the JSON (`None` for the orchestrator, a token for sub-agents). In `["messages","updates"]` mode the normalizer passes no writer, so every method **returns bytes** the `astream` loop yields.

**Standard events** (type = `ag_ui` `EventType`):

| Method | Event type | Payload |
|--------|-----------|---------|
| `run_start` / `run_end` | `RUN_STARTED` / `RUN_FINISHED` | `thread_id`, `run_id` |
| `thinking_start` / `thinking_end` | `THINKING_START` / `THINKING_END` | — |
| `thought(content)` | `THINKING_TEXT_MESSAGE_CONTENT` | `delta` |
| `response_start` / `_chunk` / `_content` / `_end` | `TEXT_MESSAGE_START/CHUNK/CONTENT/END` | `message_id`(+`delta`) |
| `tool_call_start` | `TOOL_CALL_START` | `tool_call_id`, `tool_call_name` |
| `tool_call_args` | `TOOL_CALL_ARGS` | `tool_call_id`, `delta`(=json of name+args) |
| `tool_call_result` | `TOOL_CALL_RESULT` | `tool_call_id`, `message_id`, `content`, `error?` |
| `tool_call_end` | `TOOL_CALL_END` | `tool_call_id` |

**Custom events** (`EventType.CUSTOM`, `name` + `value`): `PLAN_SNAPSHOT` (from `write_todos`), `TASK_SUBAGENT` (from `task`), `SUBAGENT_EVENT` (wraps a nested normalized event), `BEFORE_AGENT_EVENT`, `TOKEN_USAGE` (from `usage_metadata`), `HITL_INTERRUPT` (from `__interrupt__`), `CHECKPOINT_COMMITTED` (terminal, namespace forced `None`, emitted by the router not the normalizer).

**`AGUIStreamNormalizer`** (`runtime/agui/normalizer.py`) — contract: `messages` mode → assistant text + tool-result messages only; `updates` mode → tool intent, plans, sub-agents, interrupts. Policies: `__interrupt__`→HITL only; `write_todos`→plan snapshot only; `task`→sub-agent event only; other tools→full `start/args/result/end` (result matched later from the `ToolMessage`). Module-global `_THREAD_NAMESPACE_BINDINGS` (keyed by `run_id`) persists sub-agent namespace↔task bindings across a run's legs so a HITL resume keeps the same UI block; released at run end unless paused. Drops summarization-internal LLM tokens so compaction never renders as a reply.

---

## 9. Agent registry & discovery

`utils/agents.py` (50 lines). `_discover_agents()` iterates `dir(langgraph_agents)` (for `LangGraphAgent` subclasses) and `dir(deep_agents)` (for `DeepAgent` subclasses), skipping the base classes themselves, skipping any class without a non-empty `name`, skipping `DISABLED_AGENT_SLUGS`, and storing `AgentDefinition(slug, cls, manifest)` in `AGENT_REGISTRY` — **built exactly once at import** (no TTL, no refresh; adding an agent needs a process restart).

Discovery relies on the package `__init__.py` **re-exporting** the class (so `dir()` sees it) — there is no literal `__all__`. The registry stores the **class**; a fresh instance is built per request. `manifest()` reads class attrs only, so discovery never instantiates (config/context aren't present at import).

> The "lazy `_AGENT_CACHE`" rule in CLAUDE.md is a **dialogue_bridge** concept (DB-row cache), not this service.

**To add an agent:** create the package, implement it, subclass `LangGraphAgent`/`DeepAgent`, set the identity class attrs, re-export from `langgraph_agents/__init__.py` or `deep_agents/__init__.py`, restart.

---

## 10. The four built-in agents

**Canonical LangGraph 5-file layout:** `__init__.py` (class + identity attrs + the 4 `register_*` overrides + `self.state`, no logic), `agents.py` (`build_*_agents(*, tools)` → frozen dataclass of chains: `template | init_chat_model(model).with_structured_output(Model)` or `create_react_agent`), `nodes.py` (Pydantic state model with `__getitem__` + node callables closing over agents & the `AGUIEmitter`), `prompt_templates.py`, `structured_outputs.py`. The analysis node uses `RunnableLambda(make_merge_with_template(...))` to prepend the system template and strip client system messages.

### `hr-policies-agent-v1` (LangGraph) — reflective RAG with doc-ranking
```mermaid
flowchart TD
    START --> analysis
    analysis -->|query_gen| query_gen
    analysis -->|simple_generation| simple_generation --> END
    query_gen --> retrieval
    retrieval --> doc_ranking
    doc_ranking --> reflectioner
    reflectioner -->|query_gen loop ≤1| query_gen
    reflectioner -->|summarizer| summarizer
    summarizer --> complex_generation --> END
```
Non-HR → one-shot `simple_generation`. HR → query-gen → `retrieval` (parallel `asyncio.gather` POST to `/retrieve/hr_policies_v4`, k=2) → `doc_ranking` (LLM boolean-flags each doc) → `reflectioner` (decides if more retrieval needed) → loop **capped at 1 extra cycle** → summarize → complex ReAct generation.

### `orthodox-agent-v1` (LangGraph) — post-generation reflection
```mermaid
flowchart TD
    START --> analysis
    analysis -->|simple_generation| simple_generation --> END
    analysis -->|query_gen| query_gen
    query_gen --> retrieval --> summarizer --> complex_generation --> reflectioner
    reflectioner -->|query_gen loop ≤1| query_gen
    reflectioner -->|end| END
```
Like HR but **no doc-ranking**, and reflection critiques the **generated answer** (not the docs). `/retrieve/athanasios-muthlinaios`, k=10. Loop capped at 1.

### `retail-agent-v1` (LangGraph) — text-to-SQL over DuckDB
```mermaid
flowchart TD
    START --> analysis
    analysis -->|simple_generation| simple_generation --> END
    analysis -->|query_gen| query_gen
    query_gen --> query_execution
    query_execution -->|query_gen retry <2| query_gen
    query_execution -->|complex_generation| complex_generation --> END
```
`analysis` classifies intent {schema_help, data, other} AND fetches the schema (`GET /excel/financial_sample/schema`) in the same node. Data path: `query_gen` (uses the error-aware SQL prompt on retry) → `query_execution` (`POST /excel/financial_sample/query/sql`; captures errors instead of raising) → retry **capped at 2 SQL attempts** → complex ReAct generation formatting markdown.

### `omni-agent-v1` (DeepAgent) — autonomous research/writing
`register_agent()` calls `build_deep_agent(model=omni.main_model, system_prompt=OMNI_INSTRUCTIONS, subagents=self.sub_agents, interrupt_on=HITL_GATED_TOOLS)`. `HITL_GATED_TOOLS = {write_file, edit_file, execute, task}`. `register_subagents()` → `researcher` + `writer` `SubAgent`s. **No `AGENT.md`/`skills/` on disk** — memory is the per-user `/memories/AGENTS.md` virtual mount (template-seeded), skills are the per-user `/skills/` mount (user-enabled copies).

---

## 11. MCP integration & tool attachment

`utils/mcp_tools.py` talks SSE to the gateway (`settings.mcp.mcp_gateway_url`). **No proxy secret / mTLS on this hop** — the dind gateway can't terminate TLS (accepted plaintext-on-overlay risk).

- `_MCP_TOOL_MANIFEST_CACHE` — process-global, keyed `server_id/tool_name`. `_TOOL_SERVER_OVERRIDES` maps bare tool names → server id (the gateway doesn't prefix names): tavily-* → `tavily`, arxiv tools → `arxiv`.
- Cache-key semantics: `_make_cache_key(server, name)` → `"{server}/{name}"` or bare `name`. `build_tool_cache_key`/`get_tool_cache_key` are what `BaseAgent` uses to match the agent's resolved (declared − disabled) tools against the live ones.
- `_fetch_tools_from_gateway()` — `sse_client` → `mcp.ClientSession` → `initialize()` → `list_tools()`.
- `list_mcp_tools(force_refresh=False)` — **returns `[]` on a cache hit** (only the manifest matters for `/tools`); otherwise fetches + primes the cache + returns raw tools.
- `mcp_session_context()` — yields an open, initialized session for the per-run `/stream`.

**Attachment path:** `/stream` opens the session → `load_mcp_tools(session)` (langchain-mcp-adapters) → `attach_tools` → `_filter_live_tools` keeps only the agent's resolved keys (declared in `agent.yaml` − disabled in `tool_prefs.json`; not a client list) → `_apply_live_tools` (deep agents drop reserved names) → `self.tools` fed into the graph.

> `_extract_tool_identity` returns a **2-tuple** `(server_id, tool_name)` despite the docstring saying 3-tuple.

---

## 12. Checkpointer & threading model

**Two-id split:**
- **`thread_id`** (= `checkpoint_thread_id`) — the durable saver key, **branch-scoped** (shared across all runs on a conversation branch). Bridge sets it = `run.checkpoint_thread_id or str(run.id)`.
- **`run_id`** — per-run identity (assistant message id), carried in `context.run_id`. Used **only** for the in-RAM AG-UI namespace cache, not checkpoint selection.

**Durable saver** — a single process-wide `AsyncPostgresSaver` over a long-lived pool on the separate `agent_runtime` DB, built in the lifespan (§3). Bound per agent in `ensure_built()` when a `thread_id` exists (else an ephemeral in-memory saver); the thread is selected per request via `run_config.configurable.thread_id`. **Threads persist indefinitely (no TTL)** — deleted only via the reap endpoint on conversation delete.

**Copy-on-fork** — `seed_thread_from_checkpoint(graph, source_thread_id, source_checkpoint_id, target_thread_id)` (`runtime/checkpointer/fork.py`): edit/retry makes a new `thread_id`; before running the delta, it reads the parent snapshot (`aget_state`) and seeds the empty target via `aupdate_state` (channel reducers merge → exact single-checkpoint copy). Idempotent; degrades to an empty thread on failure (never crashes). Called from `/stream` only, after `ensure_built()`.

**Release** — `release_checkpoint_unless_paused(agent, run_id)` (in the `finally` of both SSE endpoints): probes `aget_state(...).interrupts`; if parked on a HITL interrupt, keeps the RAM namespace bindings (for a later `/resume`), else `release_namespace_bindings(run_id)`. **Durable checkpoint never deleted here.**

**Commit marker** — `emit_checkpoint_committed(agent, thread_id, ...)` reads the head checkpoint id and emits the terminal `CHECKPOINT_COMMITTED` event; the bridge persists `(thread_id, checkpoint_id)` on the assistant message so the next turn resumes/forks from it.

---

## 13. Filesystem / workspace model

Deep agents get a per-(user, agent, conversation) **virtual** filesystem via a deepagents `CompositeBackend`. On-disk tree under `MAGENTICX_WORKSPACES_ROOT` (all paths come from `runtime/filesystem/layout.py`, the single path authority):
```
<workspaces_root>/users/<user_id>/
├── skills/                      the user's skill pool (not mounted)
├── custom_agents/<slug>/      → mount /reference/     (the user's own agent definitions)
└── agents/<agent_slug>/
    ├── memory/                → mount /memories/      (AGENTS.md + entries/<name>.yml)
    ├── skills/                → mount /skills/        (<skill>/SKILL.md, UI-managed, read-only)
    └── conversations/<conversation_id>/ → mount /conversation/
        ├── input/             → /conversation/input/  (read-only uploads)
        └── output/            → /conversation/output/ (agent artifacts)
```
`build_workspace_backend(...)` returns a **factory** invoked per tool call (so `StateBackend` binds the live `ToolRuntime`). All routes are `FilesystemBackend(virtual_mode=True)` — the agent sees only virtual paths, never the host path, so it cannot escape its root; longer-prefix routes win; the default route is an ephemeral `StateBackend()`. `_safe_segment` rejects `/`, `\`, `..`, leading `.` on every user/agent/conversation/skill/file segment (path-traversal defense).

**`/reference/` — the agent's own definition folder, read-only and optional.** Passed as `reference_dir` and supplied by `DeepAgent.reference_dir` (a policy hook returning `None` by default). `YamlDeepAgent` overrides it with its source directory, so material shipped beside `AGENT.md` — notes, checklists, examples — is readable **on demand** at `/reference/<path>` instead of being inlined into every turn. Agents defined in Python return `None`: their package directory holds source, which must never be readable from a run. Without the mount such a file is *inert* — the path matches no route, falls through to `StateBackend`, and reads "not found" with no error logged anywhere.

**Write-deny stays matched to the mounts.** `workspace_write_deny(include_reference=...)` returns the ladder for a run: the always-on rules (`/skills`, `/large_tool_results`, `/conversation_history`, `/conversation/input`) plus `/reference` only when that route is mounted. A function rather than a constant because deepagents rejects a permission whose path lies outside every mounted route — dormant today (it fires only when the default backend supports execution), a hard failure the day sandbox execute lands. Both the mount and the rule derive from `self.reference_dir is not None`, so they cannot drift. `/reference/` is read-only because the folder is authored through the builder UI (which enforces its own type/size limits) and a run that could rewrite its own definition would be editing its next system prompt. Pinned by `tests/agents/test_workspace_mounts.py`.

**Sandbox-execution guard (fail-closed):** deepagents surfaces its built-in `execute` tool exactly when the composite **default** backend implements `SandboxBackendProtocol` (`StateBackend` does not; `LocalShellBackend` — host-shell execution — does, and its import is test-banned from the whole service). While `SANDBOX_EXECUTION_ENABLED` is false the factory refuses to mint a sandbox-capable default (`RuntimeError`), so a refactor swapping the default class can never silently open a code-execution path. Pinned by `tests/agents/test_execute_lockdown.py`.

**Workspace retention:** `retention.py` TTL-erases `input/` (default 72h) and `output/` (default 168h) cache files — safe because both are copies of DB blobs (input is bridge-seeded per run; presented outputs are persisted as generated attachments at finalize). `memory/`, loose `/conversation/` files, and the offload dirs are out of scope. Symlinks are deleted-as-links and logged as security events; swept dirs must realpath-resolve under the filesystem root; conversations with writes in the last 30 min are skipped.

---

## 14. Skills & memory systems

**Global skills registry** (boot, on-disk, three steps in the lifespan): `seed_global_registry()` copies the in-image seed into the `SKILLS_REGISTRY_GLOBAL_ROOT` volume (existing folders win) → `rebuild_global_manifest()` scans `<category>/<skill>/SKILL.md`, parses frontmatter (`name`, `description`), writes `manifest.json` atomically → `reconcile_all_user_manifests()`.

**Two-tier model:** a global catalog (`GET /skills/global`) → a per-user **pool** (`/users/{uid}/skills`, add-global or create-custom) → per-(user, agent) **enablement** (`/agents/{slug}/users/{uid}/skills` — enabling copies the skill folder into the `/skills/` mount; **the folder's presence *is* the enabled record**, no DB row).

**Memory** — per-(user, agent): the `remember` tool writes `entries/<slug>.yml` (atomic) + upserts a one-line index in `AGENTS.md` (auto-seeded from `AGENTS_MD_TEMPLATE` on first contact, never overwritten). Hard cap `MEMORY_MAX_ENTRIES=60` (new entries refused when full; updates always allowed). `search_past_conversations` reads cross-conversation via the bridge's internal memory endpoint (pgvector), opt-in per run.

---

## 15. Middlewares

- **`ToolErrorMiddleware`** — wraps every tool call (sync + async); on exception returns a `ToolMessage(status="error", content="Tool '<name>' failed: ...")` instead of aborting, so the model can recover and the normalizer surfaces `TOOL_CALL_RESULT` with `error:true`. **Force-guaranteed on the main agent AND every sub-agent** (parent middleware doesn't reach subagents).
- **`ConfigurableSummarizationMiddleware`** — thin subclass of deepagents' `SummarizationMiddleware` with a distinct type so `exclude_stock_summarization` (a `HarnessProfile` with `excluded_middleware={"SummarizationMiddleware"}`) drops the stock one and only the env-tuned one runs. `build_summarization_middleware(model, backend)` uses fraction thresholds for models with a token-window profile, else token/message fallbacks; offloads history to `/conversation_history/`. Fires **later** than deepagents' stock defaults.

---

## 16. Observability (`observability/`)

Structured, async, per-request-context logging.
- **`configure_logging`** — non-blocking `QueueHandler` → `QueueListener` → stdout `StreamHandler`; `ConsoleFormatter` or `JsonFormatter` (per `LOG_FORMAT`); a `RequestContextFilter` injects context fields; `uvicorn.access` and `httpx` pinned to `WARNING`.
- **Context** — a `ContextVar[dict]` (`set_context`/`get_context`/`clear_context`); `None` values pop the key.
- **`RequestLoggingMiddleware`** — sets `request_id` (sanitized), `client_ip` (proxy-resolved), `http_method`/`http_path`, `user_id`/`session_id` (from `X-User-Id`/`X-Session-Id` headers the bridge forwards), plus `conversation_id`/`message_id`/`agent_slug` from path params; logs `http_request_started`/`_completed`/`_failed`; echoes `X-Request-ID`; **`/health` is silent**.
- **Redaction** (`redaction.py`) — `user_id`/`session_id` are logged **RAW** (correlate with the DB); **only `client_ip` is HMAC-SHA256 hashed** → `h:<16hex>` (idempotent passthrough of already-hashed values). Sensitive keys (`password`/`token`/`authorization`/`cookie`/`secret`/`csrf`/`data(_)b64`) → `[REDACTED]`; content/volume keys (`messages`/`content`/`prompt`/`query`/`sql`/`documents`/…) → dropped (`[OMITTED]`); strings truncated at 256; `X-Request-ID` validated against `[A-Za-z0-9._-]{1,128}` (log-injection guard).

---

## 17. Error handling (`core/error_handling.py`)

- **`AgentServiceExceptionHandler`** — `HTTPException` → JSON `{"detail": ...}` (public detail hidden for <500), `RequestValidationError` → 422 generic, unhandled `Exception` → 500 generic. Registered via `register_exception_handlers(app)`.
- **`ProviderErrorHandler`** — `raise_provider_error(...)` logs + raises **502** for OpenAI/model failures (used by voice, embeddings, title, suggestions); `raise_invalid_response(...)` → 502 for malformed provider responses.
- **`AgentStreamErrorHandler.encode_run_error(...)`** — logs the traceback and returns the terminal SSE frame `data: {"type":"RUN_ERROR","message":"The agent could not complete this run. Please try again."}\n\n` (generic message, no internals). This is what `BaseAgent._encode_run_error` emits — a **raw frame, not an AG-UI event**, so the bridge/UI must handle both shapes.

---

## 18. Security posture

- **Single internal-trust gate** — every endpoint uses `require_internal_caller` (`secrets.compare_digest` on `X-Internal-Proxy-Secret`); the service refuses to boot without `TRUSTED_PROXY_SECRET` (`_require_proxy_secret`).
- **mTLS** to rag_service and the bridge via a single cached `ssl.SSLContext` carrying both CA trust and this service's client cert (httpx 0.28 silently ignores the `cert=` tuple, so `get_httpx_client_cert()` returns `None` on purpose and the cert lives in the context).
- **Secrets** are `SecretStr`, file-backed via `*_FILE` (raising on unreadable); cert *paths* are `SecretStr` too.
- **`LANGGRAPH_STRICT_MSGPACK`** on by default (blocks the `JsonPlusSerializer` RCE class, CVE-2025-64439); optional AES-at-rest for checkpoints.
- **Filesystem confinement** — `virtual_mode=True` + structurally disjoint `CompositeBackend` roots + `_safe_segment` traversal defense + write-deny ladder.
- **Redaction** never logs raw secrets/PII content; hardened random redaction key if none provisioned.
- **Deep-agent HITL** gates dangerous tools (`write_file`, `edit_file`, `execute`, `task`) behind human approval.
- **MCP hop is the one plaintext edge** (no secret, no TLS) — accepted because it's overlay-internal and the dind gateway can't terminate TLS.

---

## 19. Integration points

- **agents → rag_service** — only from LangGraph nodes, over mTLS + `internal_service_headers`. HR/Orthodox POST `/retrieve/{collection}` (parallel `asyncio.gather`); Retail GET `/excel/{table}/schema` + POST `/excel/{table}/query/sql`.
- **agents → dialogue_bridge** (reverse) — the `search_past_conversations` tool POSTs to `/v1/internal/memory/search` (mTLS + proxy header); also `POST /embed` lets the bridge proxy embeddings (it has no OpenAI key).
- **dialogue_bridge → agents** — `inference_runs.py` builds `{run_config.configurable.thread_id, context:{user_id, conversation_id, run_id, use_memory, search_past_convs, personalization?}, tools, fork_from?}` and streams `POST /stream` (or `/resume`) over `httpx.AsyncClient(verify=SSLContext, cert=None)` with `internal_service_headers` + `Accept: text/event-stream`, parsing SSE bytes → Redis delta publish. A `RUN_ERROR` frame marks the run failed.

---

## 20. Deployment (Docker, TLS, compose)

- **Dockerfile** — `python:3.12-slim`; installs `build-essential`, `pip install -r requirements.txt`, then **purges** the compiler; `COPY . .`; copies `load-secrets-and-exec.sh` to `/usr/local/bin`; seeds `/opt/skills_registry_seed`; pre-creates `/var/agents/**` owned by `1000:1000`; `EXPOSE 8003`; baked CMD `uvicorn main:app --host 0.0.0.0 --port 8003` (**no TLS in the image**).
- **requirements.txt** — `fastapi==0.135.3`, `uvicorn==0.32.0`, `starlette==0.49.3`, `httpx==0.28.1`, `langchain==1.3.9`, `langgraph==1.2.5`, `langgraph-checkpoint-postgres==3.1.0`, `langchain-openai==1.3.2`, `deepagents==0.6.10`, `psycopg[binary,pool]>=3.2,<3.3`, `pycryptodome>=3.20,<4`, `mcp==1.23.0`, `langchain-mcp-adapters==0.1.13`, `ag-ui-protocol==0.1.14`, `pydantic==2.12.4`.
- **`.dockerignore`** — excludes secrets/TLS/venvs; **keeps** `*.md`, `skills_registry/`, and the shim (all runtime-needed).
- **`load-secrets-and-exec.sh`** — reads each `/run/secrets/*` into an uppercased env var, then `exec "$@"`. Needed because the OpenAI SDK / `init_chat_model` read `OPENAI_API_KEY` from `os.environ` directly, bypassing Pydantic.
- **TLS is a prod-only compose override** (`docker-compose-denis.yaml`): `entrypoint: [load-secrets-and-exec.sh, /bin/sh, /app/tls/entrypoint-tls.sh]` + bind-mounted certs + `INTERNAL_CA/CLIENT_CERT/KEY_PATH` env. `REQUIRE_TLS`/`REQUIRE_MTLS` default `true` (fail-closed). **Local compose runs the baked plain-uvicorn CMD** (plaintext, no certs).
- **Local run:** `uvicorn main:app --host 0.0.0.0 --port 8003 --reload` with `OPENAI_API_KEY`, `RAG_BASE_URL`, `MCP_GATEWAY_URL`, `TRUSTED_PROXY_SECRET`, `AGENT_RUNTIME_DATABASE_URL` set; companions `rag_service` + `mcp_gateway` + a reachable `agent_runtime` Postgres.

> **deepagents version:** requirements pin `0.6.10`; the *host* has `0.4.11`, so `tests/agents/` fail at import on the host — validate via `py_compile` + Docker.

---

## 21. Schemas reference (`schemas.py`, flat single module)

`Request{messages, config}` · `ResumeActionDecision{decision, reason?}` · `AgentResumeRequest{config, thread_id, decision, reason?, value?, interrupt_id?, decisions?}` · `InputFileIn{filename, mime, base64, size}` · `SeedInputFilesRequest{files}` · `SeedInputFilesResponse{written}` · `EmbedRequest{texts}` · `EmbedResponse{embeddings, model, dimensions}` · `ReapConversationRequest{thread_ids}` · `TitleRequest{user_input}` · `ConversationTitle{titles}` · `SuggestionsRequest{user_input}` · `ConversationSuggestions{suggestions}` · `ReadAloudRequest{text, voice?}` · `TranscriptionResponse{text}` · `RealtimeSessionRequest{sdp, model?, voice?, instructions, metadata}` · `RealtimeSessionResponse{sdp, model, voice}` · `AgentManifest{id, slug, name, version?, type, description, icon}` · `ToolManifest{server_id, tool_name, description, parameter_count}` · `SkillManifest{name, description, content, category}` · `SkillManifestEntry{name, type, description, source_path, category}` · `GlobalManifest{version, skills}` · `UserManifest{version, skills}` · `SkillFile{path, content, encoding, size}` · `CustomSkillCreate{name, description, files}` · `UserSkillDetail{…entry + content + files}` · `MemoryEntry{name, summary, created_at?, updated_at?, source_conversation_id?}` · `MemoryDetail{…entry + content}` · `@dataclass(frozen=True) AgentDefinition{slug, cls, manifest}`.

---

## 22. Replication checklist & sharp edges

**To stand up a replica:**
1. Copy the whole `src/agents/` tree.
2. Provision `TRUSTED_PROXY_SECRET` (mandatory — won't boot without it), `OPENAI_API_KEY`, `AGENT_RUNTIME_DATABASE_URL` (a reachable Postgres — the service creates the DB but not the server), and `MCP_GATEWAY_URL`/`RAG_BASE_URL` if you keep those integrations.
3. Keep the `load-secrets-and-exec.sh` shim if secrets are file-mounted (OpenAI SDK reads env directly).
4. For a fresh agent: subclass `LangGraphAgent`/`DeepAgent`, set identity attrs, re-export from the package `__init__.py`, restart.
5. Keep `LANGGRAPH_STRICT_MSGPACK=true`.

**Sharp edges (don't get bitten):**
- **`stream_mode` differs by base class** — `"custom"` (LangGraph, writer-emitted bytes) vs `["messages","updates"]`+`subgraphs=True` (Deep, normalizer-driven). Wrong mode = no UI events.
- **normalizer/message_id keyed on `run_id`**, not the branch-scoped `thread_id`.
- **Two module-level caches assume a single worker**: `checkpointer.store._checkpointer` and `normalizer._THREAD_NAMESPACE_BINDINGS`. Multiple uvicorn workers would each hold their own — fine for the durable saver (shared DB) but the namespace cache is per-process, so pin sticky routing or a single worker for HITL correctness.
- **`ToolErrorMiddleware` must be on the main agent AND every subagent** — a tool exception must degrade to a `ToolMessage`, never abort.
- **Stock deepagents summarizer must be excluded** per model spec or its lower threshold wins.
- **`RESERVED_DEEPAGENT_TOOL_NAMES`** must be stripped from attached MCP tools.
- **`use_memory` gates four things together** — desync one and the agent advertises a mount it lacks.
- **`FilesystemBackend(virtual_mode=True)` + disjoint CompositeBackend roots** are the confinement model; permission rules must target a mounted route, which is why routes + permissions live together in `workspace.py` and why the conditional `/reference/` rule comes from `workspace_write_deny(include_reference=...)` rather than a bare constant. deepagents' own check on this (`_all_paths_scoped_to_routes`) is **dormant** — it runs only when the default backend supports execution — so an unmounted-route rule fails nothing today and everything once sandbox execute lands.
- **`_encode_run_error` emits a raw `RUN_ERROR` frame, not an AG-UI event** — the consumer must handle both.
- **`list_mcp_tools` returns `[]` on a cache hit**, not the tools (only the manifest matters there).
- **The MCP hop is plaintext** (no proxy secret, no mTLS); rag/bridge hops require both.
- **The durable checkpoint is never deleted on run end** — only the RAM namespace cache is released (and only when not paused); deletion happens exclusively via the reap endpoint.
- **`tools/charts.py` and `tools/__init__.py` are empty placeholders** — no chart tooling exists yet.
- **Doc drift** — ignore the checked-in `README.md` where it says in-memory checkpointing, `runtime/protocols/agui/`, 4 endpoints, or co-located deep-agent `AGENT.md`/`skills/` files. This document reflects the shipped code.

---

*Generated from a full read of the current `src/agents/` source. All `file:line` references are accurate as of this writing; verify against the tree before relying on exact line numbers.*
