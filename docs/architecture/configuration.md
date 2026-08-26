# Configuration — Every Environment Variable, Per Service

Each Python service is configured entirely through environment variables read by **Pydantic `BaseSettings`** classes in its `core/settings.py`; the infrastructure services (Postgres, Redis, Chroma, nginx, Vault, the monitoring stack) are configured by image env vars and command flags. This document is the exhaustive reference for *how much you can tune each service without touching code* — every var, its default, and what it does. For the inverse — the short list of *what each service cannot boot without* — see its companion, [service-startup.md](service-startup.md). Defaults shown are the **in-code defaults**; the production compose overrides only a handful (mostly URLs, TLS paths, `LOG_FORMAT=json`, and `*_FILE` secret pointers). Settings are **case-insensitive**, load from `src/.env` in local dev, and ignore unknown vars (`extra="ignore"`). Anything backed by a secret follows the `<NAME>_FILE` indirection documented in [secrets.md](secrets.md).

---

## Services Involved

```mermaid
flowchart LR
    Env[".env / compose env / Swarm secret files"] --> S1["dialogue_bridge\ncore/settings.py"]
    Env --> S2["agents\ncore/settings.py"]
    Env --> S3["rag_service\ncore/settings.py"]
    Env --> S4["infra: postgres · redis · chroma\nnginx · vault · monitoring"]
    EP["entrypoint-*.sh"] -->|"REQUIRE_TLS / REQUIRE_MTLS"| S1 & S2 & S3 & S4
```

## How to read these tables

- **Env var** is the exact name to set (in `.env`, the compose `environment:` list, or Portainer's env dropdown for non-secrets).
- **Default** is what you get if the var is unset. `—` means required (no default; startup fails if missing). `(secret)` means it resolves via `*_FILE` or the plain var per [secrets.md](secrets.md).
- A few vars accept **alias names** (shown as `A` / `B`) via Pydantic `AliasChoices` — either works.
- **CSV** vars accept a comma-separated string (e.g. `a,b,c`).
- Validated bounds, where they exist, are noted — out-of-range values raise at startup.

---

## dialogue_bridge

The BFF. The richest configuration surface — 19 settings groups.

### App & lifecycle

| Env var | Default | What it does |
| --- | --- | --- |
| `APP_ENV` / `ENV` | `development` | Environment name. **Anything other than `development`/`test` makes Vault (`VAULT_URL`, role id, secret id) and `SESSION_TOKEN_SECRET` mandatory** and disables dev secret fallbacks. Prod leaves this **unset** on purpose (so it is not `development`). |
| `APP_VERSION` / `IMAGE_TAG` | `unknown` | Version string stamped onto every log line. |
| `LOG_SERVICE_NAME` | `dialogue_bridge` | `service` field in logs. |
| `RUN_MIGRATIONS_ON_STARTUP` | `true` | Run `alembic upgrade head` in the lifespan before serving. Set `false` as the emergency knob if a bad migration is keeping the container down. |

### Database (`DatabaseSettings`)

| Env var | Default | What it does |
| --- | --- | --- |
| `DATABASE_URL` | — | `postgresql+asyncpg://…` URL. Password may be omitted and spliced in from the secret. |
| `DATABASE_PASSWORD_FILE` | (secret) | File-backed DB password, spliced into a password-less `DATABASE_URL`. An inline password in the URL always wins (local dev). |
| `DATABASE_ECHO` | `false` | SQLAlchemy statement echo. |
| `DATABASE_POOL_PRE_PING` | `true` | Validate pooled connections before use. |
| `DATABASE_POOL_RECYCLE` | `1800` | Recycle connections older than N seconds. |
| `DATABASE_POOL_SIZE` | `5` | Base async pool size. |
| `DATABASE_MAX_OVERFLOW` | `20` | Extra connections allowed above pool size under load. |

### Session & cookies (`SessionSettings`)

| Env var | Default | What it does |
| --- | --- | --- |
| `SESSION_COOKIE_SECURE` | `true` | `Secure` flag on auth cookies. With this on **and** no domain set, cookie names get the `__Host-` prefix. |
| `SESSION_COOKIE_SAMESITE` | `lax` | `SameSite` policy. |
| `SESSION_COOKIE_DOMAIN` | `None` | Cookie domain; `None` ⇒ host-locked (`__Host-` names). |
| `SESSION_COOKIE_NAME` | auto | Access-cookie name; defaults to `__Host-mx_session` (host-locked) or `mx_session`. |
| `SESSION_REFRESH_COOKIE_NAME` | auto | Refresh-cookie name; `__Host-mx_refresh` / `mx_refresh`. |
| `SESSION_CSRF_COOKIE_NAME` | auto | CSRF-cookie name; `__Host-mx_csrf` / `mx_csrf`. |
| `SESSION_CSRF_HEADER_NAME` | `X-CSRF-Token` | Header the SPA echoes the CSRF token in. |
| `SESSION_TOKEN_SECRET` | (secret) | General-purpose HMAC key (DOCX-preview tokens). Required outside dev/test; dev generates a random one. |

### Vault (`VaultSettings`) — stateless JWT auth

| Env var | Default | What it does |
| --- | --- | --- |
| `VAULT_URL` | `None` | Vault address (prod `https://vault:8004`). Required outside dev/test. |
| `VAULT_USERPASS_MOUNT` | `userpass` | Mount path of the userpass IdP. |
| `VAULT_NAMESPACE` | `None` | Vault Enterprise namespace (unused on OSS). |
| `VAULT_HTTP_TIMEOUT` | `10.0` | Per-call timeout to Vault (seconds). |
| `VAULT_APPROLE_MOUNT` | `approle` | Mount path of the AppRole the bridge logs in with. |
| `VAULT_ROLE_ID` | (secret) | AppRole role id (machine identity). Required outside dev/test. |
| `VAULT_SECRET_ID` | (secret) | AppRole secret id. Required outside dev/test. |
| `VAULT_TRANSIT_MOUNT` | `transit` | Mount path of the Transit engine. |
| `VAULT_TRANSIT_JWT_KEY` | `jwt-rs256` | Transit key name that signs/verifies session JWTs. |

### JWT (`JWTSettings`)

| Env var | Default | What it does | Bounds |
| --- | --- | --- | --- |
| `JWT_ISSUER` | `magenticx-bridge` | `iss` claim. | — |
| `JWT_AUDIENCE` | `magenticx` | `aud` claim. | — |
| `JWT_ACCESS_TTL_SECONDS` | `28800` (8h) | Access-token lifetime. | 60 … 86400 |
| `JWT_REFRESH_IDLE_TTL_SECONDS` | `1036800` (12d) | Rolling idle window — refresh `exp` slides forward by this on each refresh. Being idle longer than this logs the user out. | 300 … 2592000 |
| `JWT_REFRESH_ABSOLUTE_TTL_SECONDS` | `1728000` (20d) | Hard cap from original login — the refresh `exp` never exceeds `lat + this`, forcing a full re-auth. | 3600 … 15552000 |
| `JWT_REFRESH_REUSE_GRACE_SECONDS` | `30` | Grace during which the just-rotated-from refresh `jti` is still accepted (avoids false reuse-detection on a retried/concurrent refresh). | 0 … 300 |
| `JWT_LEEWAY_SECONDS` | `30` | Clock-skew leeway on verification. | 0 … 300 |
| `JWT_SIGN_VERSION_CACHE_SECONDS` | `60` | How long the Transit key version is cached before re-checking. | — |

### Microsoft Entra ID / OIDC (`EntraSettings`)

Federated sign-in alongside username/password. **Inert unless `ENTRA_TENANT_ID` + `ENTRA_CLIENT_ID` + `ENTRA_CLIENT_SECRET` are all set** (`settings.entra.enabled`).

| Env var | Default | What it does |
| --- | --- | --- |
| `ENTRA_TENANT_ID` | `None` | Directory (tenant) id. |
| `ENTRA_CLIENT_ID` | `None` | Application (client) id of the app registration. |
| `ENTRA_CLIENT_SECRET` | (secret) | Client secret (file-backed via `ENTRA_CLIENT_SECRET_FILE` / Swarm secret in prod). |
| `ENTRA_REDIRECT_URI` | `None` | Exact registered callback URL, e.g. `http://localhost:8050/api/v1/auth/oidc/callback`. Falls back to forwarded-origin derivation if unset. |
| `ENTRA_ALLOWED_GROUP_IDS` | `None` | Comma-separated Entra security-group Object IDs allowed to sign in. Empty = no restriction (enforced fail-closed). |
| `ENTRA_POST_LOGIN_REDIRECT` | `/` | SPA path to land on after a successful SSO login. |
| `ENTRA_LOGIN_ERROR_REDIRECT` | `/login` | SPA path (with an `?sso=<reason>` query) to bounce to when SSO is denied/fails. |
| `ENTRA_AUTHORITY_HOST` | `https://login.microsoftonline.com` | Entra authority host (override for sovereign clouds). |

### Internal TLS client (`TlsSettings`)

| Env var | Default | What it does |
| --- | --- | --- |
| `INTERNAL_CA_CERT_PATH` | `None` | CA used to verify peer services (and Postgres `verify-full`). |
| `INTERNAL_CLIENT_CERT_PATH` | `None` | This service's client cert, presented for mTLS to `agents`. (Wrapped in `SecretStr` so the path can't leak in a settings dump.) |
| `INTERNAL_CLIENT_KEY_PATH` | `None` | Matching client key. |

### Upstream, inference, rate limits

| Env var | Default | What it does |
| --- | --- | --- |
| `AGENTS_SERVICE_URL` | `https://agents:8003` | Base URL of the agents service. |
| `INFERENCE_TOOL_RESULT_MAX_CHARS` | `16000` | Cap on stored `TOOL_CALL_RESULT` content in the event log; oversized results are truncated and flagged. |
| `INFERENCE_WS_SUBSCRIBE_TIMEOUT_SECONDS` | `10.0` | Timeout waiting to subscribe to a run's Redis stream. |
| `AUTH_RATE_LIMIT_MAX_ATTEMPTS` | `15` | Login attempts per window (per resolved client IP). Covers `POST /login` (including `?park=true`, the add-account path) and `GET /oidc/login`, so a single user adding an account spends more than one attempt; shared NAT/proxy egress IPs spend several. |
| `AUTH_RATE_LIMIT_WINDOW_SECONDS` | `60` | Auth rate-limit window. |
| `INFERENCE_RATE_LIMIT_MAX_ATTEMPTS` | `10` | Inference starts per window (per user). |
| `INFERENCE_RATE_LIMIT_WINDOW_SECONDS` | `60` | Inference rate-limit window. |
| `SPEECH_RATE_LIMIT_MAX_ATTEMPTS` | `20` | Speech calls (dictation, read-aloud, previews) per window (per user). |
| `SPEECH_RATE_LIMIT_WINDOW_SECONDS` | `60` | Speech rate-limit window. |
| `VOICE_SESSION_RATE_LIMIT_MAX_ATTEMPTS` / `_WINDOW_SECONDS` | `15` / `60` | Realtime voice session creation (paid OpenAI Realtime) per user. |
| `EXPORT_PDF_RATE_LIMIT_MAX_ATTEMPTS` / `_WINDOW_SECONDS` | `10` / `60` | Conversation PDF exports (CPU-heavy render) per user. |
| `SHARE_CREATE_RATE_LIMIT_MAX_ATTEMPTS` / `_WINDOW_SECONDS` | `10` / `60` | Share-link creation (mints public tokens) per user. |
| `SKILL_UPLOAD_RATE_LIMIT_MAX_ATTEMPTS` / `_WINDOW_SECONDS` | `10` / `60` | Custom-skill uploads (agents-service disk writes) per user. |
| `MESSAGE_RATE_LIMIT_MAX_ATTEMPTS` / `_WINDOW_SECONDS` | `30` / `60` | Message creation (attachment/blob growth) per user. |
| `SUGGESTIONS_RATE_LIMIT_MAX_ATTEMPTS` / `_WINDOW_SECONDS` | `10` / `60` | Starter-suggestion generation (LLM-backed) per user. |
| `REFRESH_RATE_LIMIT_MAX_ATTEMPTS` / `_WINDOW_SECONDS` | `10` / `60` | Session refresh (Vault Transit mint) per client IP. |
| `WS_CONNECT_RATE_LIMIT_MAX_ATTEMPTS` / `_WINDOW_SECONDS` | `20` / `60` | Run-stream WebSocket handshakes per user (enforced in-route; close code `4429`). |
| `USER_RATE_LIMIT_MAX_CALLS` | `300` | App-wide aggregate budget per verified user (per-IP fallback) per window. |
| `USER_RATE_LIMIT_WINDOW_SECONDS` | `60` | Budget window. |
| `INFERENCE_MAX_ACTIVE_RUNS_PER_USER` | `5` | Concurrent in-flight runs per user. |

All rate limits are counted in **Redis** via `fastapi-redis-sdk` (they survive restarts and hold across replicas) and **fail open** on a Redis outage. The SDK's own `REDIS_*` env settings are **not** read from the environment — `core/cache/integration.py` primes them programmatically from the values above plus the Redis section below (so the file-backed password and internal CA are honored), then scrubs the password back out of the process env.

### Redis (`RedisSettings`)

| Env var | Default | What it does |
| --- | --- | --- |
| `REDIS_URL` | `redis://redis:6379/0` | Stream backend (prod uses `rediss://`). |
| `REDIS_PASSWORD` | (secret) | Redis AUTH password. |
| `REDIS_STREAM_MAXLEN` | `20000` | Max entries per per-run event stream (approx-trimmed). |
| `REDIS_STREAM_TERMINAL_TTL_SECONDS` | `3600` | TTL on a stream after the run reaches a terminal state. |
| `REDIS_STREAM_READ_BLOCK_MS` | `30000` | Blocking-read timeout when tailing a stream. |
| `REDIS_SKILLS_GLOBAL_TTL_SECONDS` | `86400` | Cache TTL for the global skills catalog. |
| `REDIS_SKILLS_USER_REGISTRY_TTL_SECONDS` | `7200` | Cache TTL for a user's skill registry. |
| `REDIS_SKILLS_USER_AGENT_TTL_SECONDS` | `7200` | Cache TTL for a user's per-agent skill set. |

### Attachments, speech, share, generation

| Env var | Default | What it does |
| --- | --- | --- |
| `ATTACHMENT_MAX_SIZE_BYTES` | `26214400` (25 MB) | Max single-attachment size. |
| `ATTACHMENT_MAX_TOTAL_BYTES` | `26214400` (25 MB) | Max combined size per message. |
| `ATTACHMENT_MAX_PER_MESSAGE` | `10` | Max attachments per message. |
| `ATTACHMENT_DOCX_PREVIEW_TOKEN_TTL_SECONDS` | `60` | Lifetime of a signed DOCX-preview token. |
| `ATTACHMENT_INLINE_CACHE_MAX_AGE_SECONDS` | `300` | `Cache-Control max-age` on inline attachment responses. |
| `ATTACHMENT_STREAM_CHUNK_BYTES` | `524288` (512 KB) | Chunk size when streaming a blob. |
| `SPEECH_DICTATION_MAX_BYTES` | `26214400` (25 MB) | Max dictation upload. |
| `SPEECH_DICTATION_READ_CHUNK_BYTES` | `1048576` (1 MB) | Read-chunk size for dictation. |
| `SPEECH_READ_ALOUD_MAX_CHARS` | `2000` | Max characters per read-aloud request. |
| `SHARE_DEFAULT_TTL_DAYS` | `30` | Default share-link lifetime. |
| `SHARE_MAX_TTL_DAYS` | `365` | Max share-link lifetime. |
| `GENERATION_TITLE_MAX_LEN` | `120` | Max generated title length. |
| `GENERATION_TITLE_MIN_CANDIDATES` | `3` | Min title candidates the bridge expects from agents. |
| `GENERATION_SUGGESTION_MAX_LEN` | `160` | Max suggestion length. |
| `GENERATION_SUGGESTION_MIN_CANDIDATES` | `6` | Min suggestion candidates expected. |
| `GENERATION_SUGGESTION_COUNT` | `10` | Suggestions requested. |
| `GENERATION_SUGGESTION_RECENT_CONTEXT_COUNT` | `8` | Recent messages fed as suggestion context. |

### Voice (`VoiceSettings`)

| Env var | Default | What it does |
| --- | --- | --- |
| `OPENAI_REALTIME_MODEL` | `gpt-realtime` | Realtime model for voice mode. |
| `REALTIME_DEFAULT_VOICE` | `alloy` | Default TTS voice (lowercased). |
| `REALTIME_SUPPORTED_VOICES` | `alloy,ash,ballad,coral,echo,nova,sage,shimmer,verse,marin,cedar` | CSV allow-list of selectable voices. |

### HTTP timeouts (`HttpTimeoutSettings`)

Per-destination `httpx` timeouts, in seconds. Each destination has four knobs: `*_CONNECT_SECONDS`, `*_READ_SECONDS`, `*_WRITE_SECONDS`, `*_POOL_SECONDS`.

| Destination prefix | connect / read / write / pool defaults |
| --- | --- |
| `HTTP_AGENTS_` | 10 / 30 / 30 / 10 |
| `HTTP_GENERATION_` | 10 / 120 / 120 / 10 |
| `HTTP_SKILLS_` | 10 / 15 / 10 / 10 |
| `HTTP_VOICE_` | 15 / 75 / 75 / 15 |
| `HTTP_INFERENCE_` | 30 / 180 / 180 / 30 |

### Proxy trust & logging

| Env var | Default | What it does |
| --- | --- | --- |
| `TRUSTED_PROXY_HEADER_NAME` | `X-Internal-Proxy-Secret` | Header carrying the internal-caller secret. |
| `TRUSTED_PROXY_SECRET` | (secret) | **Required — the service refuses to start without it.** |
| `LOG_LEVEL` | `INFO` | Root log level (uppercased). `uvicorn.access`/`httpx` are pinned to `WARNING`. |
| `LOG_FORMAT` | `console` | `console` (dev) or `json` (prod — set in the production compose so Loki/Alloy can parse). |
| `LOG_TIMEZONE` / `TZ` | `Europe/Athens` | Timestamp timezone. |
| `LOG_REDACTION_SECRET` | (secret) | Shared HMAC key for the `client_ip` hash. Dev falls back to a random per-process key. |

### CORS (`CorsSettings`)

| Env var | Default | What it does |
| --- | --- | --- |
| `CORS_ALLOWED_ORIGINS` | `localhost:8080/8050` + `127.0.0.1:8080/8050` (CSV) | Allowed origins. **Cannot contain `*` while credentials are on** (raises at startup). |
| `CORS_ALLOW_CREDENTIALS` | `true` | Allow cookies on cross-origin requests. |
| `CORS_ALLOW_METHODS` | `GET,POST,PUT,PATCH,DELETE` (CSV) | Allowed methods. |
| `CORS_ALLOW_HEADERS` | auto | Defaults to `Accept, Content-Type, Authorization, Range, If-Range, <csrf header>` if unset. |
| `CORS_EXPOSE_HEADERS` | `Content-Disposition,Content-Length,Content-Range,Accept-Ranges` (CSV) | Headers exposed to the browser (needed for download/range). |
| `CORS_MAX_AGE_SECONDS` | `600` | Preflight cache duration. |

---

## agents

LangGraph + DeepAgents runtime. Configuration splits into runtime infra, the durable checkpointer, per-workflow model selection, and the deep-agent filesystem.

### App, API keys, RAG, MCP

| Env var | Default | What it does |
| --- | --- | --- |
| `LOG_SERVICE_NAME` | `agents` | `service` field in logs. |
| `APP_ENV` / `ENV` | `development` | Environment name. |
| `APP_VERSION` / `IMAGE_TAG` | `unknown` | Version stamped on logs. |
| `OPENAI_API_KEY` | (secret) | OpenAI key for all LLM, STT/TTS, and realtime calls. |
| `ANTHROPIC_API_KEY` | (secret, optional) | Anthropic key; `None` if unset. |
| `RAG_BASE_URL` | `https://rag_service:8001` | rag_service base URL. |
| `RAG_REQUEST_TIMEOUT_SECONDS` | `30` | Read timeout for rag calls. |
| `RAG_CONNECT_TIMEOUT_SECONDS` | `15` | Connect timeout for rag calls. |
| `MCP_GATEWAY_URL` | `http://mcp_gateway:8005/sse` | MCP gateway SSE endpoint (plaintext — the dind gateway can't terminate TLS). |
| `MCP_MANIFEST_CACHE_ENABLED` | `true` | Cache the MCP tool manifest instead of refetching per run. |

### Internal TLS client

| Env var | Default | What it does |
| --- | --- | --- |
| `INTERNAL_CA_CERT_PATH` | `None` | CA to verify rag_service (and to enable Postgres TLS on the checkpointer URL). |
| `INTERNAL_CLIENT_CERT_PATH` | `None` | Client cert presented for mTLS to rag_service. |
| `INTERNAL_CLIENT_KEY_PATH` | `None` | Matching client key. |

### Durable checkpointer (`CheckpointerSettings`)

| Env var | Default | What it does |
| --- | --- | --- |
| `AGENT_RUNTIME_DATABASE_URL` | `postgresql://admin:admin@chat_postgres:5432/agent_runtime` | psycopg3 conninfo for the LangGraph `AsyncPostgresSaver`. **Raw `postgresql://` (not `+asyncpg`).** TLS is auto-appended (`sslmode=verify-full&sslrootcert=…`) when `INTERNAL_CA_CERT_PATH` is set and the URL has no `sslmode`. |
| `AGENT_RUNTIME_DATABASE_PASSWORD_FILE` | (secret) | Password spliced into a password-less conninfo (prod). Inline `admin:admin` (dev) wins. |
| `AGENT_RUNTIME_POOL_MIN_SIZE` | `2` | Min checkpointer pool connections. |
| `AGENT_RUNTIME_POOL_MAX_SIZE` | `20` | Max checkpointer pool connections. |
| `AGENT_RUNTIME_POOL_MAX_IDLE` | `300` | Idle-connection reap (seconds). |
| `AGENT_RUNTIME_POOL_TIMEOUT` | `30.0` | Wait for a pool connection (seconds). |
| `AGENT_RUNTIME_SETUP_ON_STARTUP` | `true` | Run `AsyncPostgresSaver.setup()` (idempotent DDL) on boot. Emergency opt-out, mirrors the bridge's migration knob. |
| `LANGGRAPH_STRICT_MSGPACK` | `true` | Strict msgpack deserialization allow-list — blocks the `JsonPlusSerializer` RCE class (CVE-2025-64439). Exported into the env LangGraph reads. **Leave on.** |
| `LANGGRAPH_AES_KEY` | (secret, optional) | AES key for `EncryptedSerializer` (at-rest checkpoint encryption). Empty ⇒ no encryption. |

### Proxy trust, logging & redaction

| Env var | Default | What it does |
| --- | --- | --- |
| `TRUSTED_PROXY_HEADER_NAME` | `X-Internal-Proxy-Secret` | Header carrying the internal-caller secret. |
| `TRUSTED_PROXY_SECRET` | (secret) | **Required — refuses to start without it.** |
| `LOG_LEVEL` | `INFO` | Root log level. |
| `LOG_FORMAT` | `console` | `console` / `json` (production sets `json`). |
| `LOG_TIMEZONE` / `TZ` | `Europe/Athens` | Timestamp timezone. |
| `LOG_REDACTION_SECRET` | (secret) | `client_ip` hash key. Falls back to `SESSION_TOKEN_SECRET`, then a random per-process key. |

### Agent registry & generation

| Env var | Default | What it does |
| --- | --- | --- |
| `DISABLED_AGENT_SLUGS` | (empty, CSV) | Agent slugs to hide from discovery (normalized lowercase, de-duped). |
| `TITLE_CANDIDATE_COUNT` | `4` | Title candidates generated. |
| `TITLE_MIN_CANDIDATES` | `3` | Min acceptable title candidates. |
| `TITLE_MAX_LEN` | `120` | Max title length. |
| `TITLE_TEMPERATURE` | `1.0` | Title-generation temperature. |
| `TITLE_MAX_TOKENS` | `128` | Title-generation token cap. |
| `SUGGESTION_COUNT` | `10` | Suggestions generated. |
| `SUGGESTION_MAX_LEN` | `160` | Max suggestion length. |
| `SUGGESTION_TEMPERATURE` | `0.8` | Suggestion temperature. |
| `SUGGESTION_MAX_TOKENS` | `320` | Suggestion token cap. |

### Runtime models & realtime voice (`RuntimeModelsSettings`, `RealtimeSettings`)

| Env var | Default | What it does |
| --- | --- | --- |
| `TITLE_MODEL` | `openai:gpt-4o-2024-08-06` | Model for title generation. |
| `SUGGESTIONS_MODEL` | `openai:gpt-4o-2024-08-06` | Model for follow-up suggestions. |
| `OPENAI_STT_MODEL` | `gpt-4o-transcribe` | Dictation (speech-to-text) model. |
| `READ_ALOUD_MODEL` | `gpt-4o-mini-tts` | Read-aloud (TTS) model. |
| `READ_ALOUD_FORMAT` | `mp3` | Read-aloud audio format. |
| `OPENAI_REALTIME_MODEL` | `gpt-realtime` | Realtime voice model. |
| `REALTIME_SUPPORTED_VOICES` | `alloy,ash,ballad,coral,echo,sage,shimmer,verse,marin,cedar` (CSV) | Realtime voice allow-list. |
| `OPENAI_REALTIME_API_URL` | `https://api.openai.com/v1/realtime/calls` | Realtime API endpoint. |
| `REALTIME_CONNECT_TIMEOUT_SECONDS` | `15.0` | Realtime connect timeout. |
| `REALTIME_READ_TIMEOUT_SECONDS` | `60.0` | Realtime read timeout. |
| `REALTIME_WRITE_TIMEOUT_SECONDS` | `60.0` | Realtime write timeout. |
| `REALTIME_POOL_TIMEOUT_SECONDS` | `15.0` | Realtime pool timeout. |
| `REALTIME_ERROR_BODY_MAX_CHARS` | `1000` | Max chars of an upstream error body surfaced. |

### Workflow agents — model & retrieval selection

Each built-in workflow agent picks its models per node. All accept `openai:<model>` (or `anthropic:<model>`) strings.

**HR** (`HR_*`): `HR_COLLECTION_NAME=hr_policies_v4`, `HR_RETRIEVE_TOP_K=2`, plus `HR_ANALYSIS_MODEL`, `HR_SIMPLE_GENERATION_MODEL`, `HR_QUERY_REFLECTIVE_MODEL`, `HR_QUERY_NO_REFLECTIVE_MODEL`, `HR_DOC_RANKING_MODEL`, `HR_SUMMARIZATION_MODEL`, `HR_COMPLEX_GENERATION_MODEL`, `HR_REFLECTION_MODEL` (defaults mix `gpt-4o-2024-08-06`, `gpt-5-2025-08-07`, `o3-mini`, `gpt-4.1-2025-04-14`).

**Orthodox** (`ORTHODOX_*`): `ORTHODOX_COLLECTION_NAME=athanasios-muthlinaios`, `ORTHODOX_RETRIEVE_TOP_K=10`, plus the same model-node set (defaults mix `gpt-4o-2024-08-06`, `o3-mini`, `o4-mini`, `gpt-5-2025-08-07`).

**Retail** (`RETAIL_*`): `RETAIL_TABLE_NAME="Financial Sample"` (the DuckDB source table; the runtime table name is normalized from it), `RETAIL_SCHEMA_TIMEOUT_SECONDS=30`, `RETAIL_QUERY_CONNECT_TIMEOUT_SECONDS=10`, `RETAIL_QUERY_TIMEOUT_SECONDS=30`, plus `RETAIL_ANALYSIS_MODEL`, `RETAIL_SIMPLE_GENERATION_MODEL`, `RETAIL_SQL_GENERATION_MODEL`, `RETAIL_SQL_ERROR_GENERATION_MODEL`, `RETAIL_ANSWER_GENERATION_MODEL`.

**Omni deep agent** (`OMNI_*`): `OMNI_MAIN_MODEL=openai:gpt-5`, `OMNI_RESEARCHER_MODEL=openai:gpt-4o`, `OMNI_WRITER_MODEL=openai:gpt-4o`.

### Deep-agent filesystem & summarization

| Env var | Default | What it does |
| --- | --- | --- |
| `AGENTS_FILESYSTEM_ROOT` | `/var/agents/filesystem` | Per-user filesystem root (volume-backed) for `CompositeBackend` mounts — AGENT.md + enabled skills survive restarts. |
| `SKILLS_REGISTRY_GLOBAL_ROOT` | `/var/agents/skills_registry/global` | Admin-curated global skills catalog (seeded at boot). |
| `SKILLS_REGISTRY_USERS_ROOT` | `/var/agents/skills_registry/users` | Per-user skill registries + manifests. |
| `INPUT_MAX_FILE_BYTES` | `26214400` (25 MB) | Server-side per-file cap on the conversation-input seeding endpoint (defence in depth; mirrors the bridge). |
| `INPUT_MAX_FILES` | `10` | Server-side per-turn file cap. |
| `SANDBOX_EXECUTION_ENABLED` | `false` | Fail-closed kill switch for sandboxed command execution: while false, workspace assembly refuses to mint a sandbox-capable default backend, which is exactly what would make deepagents expose its `execute` tool. Reserved for the future gVisor-class sandbox rollout. |
| `WORKSPACE_INPUT_TTL_HOURS` | `72` | TTL for conversation `input/` cache files (bridge-seeded copies of DB attachment blobs). `0` disables the input sweep. |
| `WORKSPACE_OUTPUT_TTL_HOURS` | `168` | TTL for conversation `output/` cache files (presented artifacts are blob-persisted at run finalize). `0` disables the output sweep. |
| `WORKSPACE_SWEEP_INTERVAL_MINUTES` | `60` | Retention sweeper cadence (jittered ±10%; bounded 5–1440). |
| `SUMMARIZATION_TRIGGER_FRACTION` | `0.92` | Compact when context reaches this fraction of a model's window (profile-aware models). |
| `SUMMARIZATION_KEEP_FRACTION` | `0.30` | Fraction of the window to retain after compaction. |
| `SUMMARIZATION_TRIGGER_TOKENS` | `200000` | Fallback token trigger for profile-less models. |
| `SUMMARIZATION_KEEP_MESSAGES` | `20` | Fallback recent-message retention. |

---

## rag_service

The generic retrieval backend — the smallest surface (5 vars beyond TLS).

| Env var | Default | What it does |
| --- | --- | --- |
| `ENVIRONMENT` | `development` | Environment name (note: this service uses `ENVIRONMENT`, not `APP_ENV`/`ENV`). |
| `LOG_LEVEL` | `INFO` | Log level. |
| `LOG_FORMAT` | `console` | `console` / `json` (production sets `json`). |
| `LOG_REDACTION_SECRET` / `LOG_REDACTION_SECRET_FILE` | (secret) | `client_ip` hash key; random per-process fallback if unset. |
| `RAG_HOST` | `vectordb` | ChromaDB host. |
| `RAG_PORT` | `8000` | ChromaDB port. |
| `OPENAI_API_KEY` / `OPENAI_API_KEY_FILE` | (secret) | Key for embedding queries. |
| `TRUSTED_PROXY_HEADER_NAME` | `X-Internal-Proxy-Secret` | Internal-caller header. |
| `TRUSTED_PROXY_SECRET` / `TRUSTED_PROXY_SECRET_FILE` | (secret) | **Required — refuses to start without it.** |

---

## Infrastructure services

These have no `settings.py`; they are configured by image env vars and command flags in the compose files.

### vectordb (`chromadb/chroma:0.6.3`)

| Env var | Value | What it does |
| --- | --- | --- |
| `IS_PERSISTENT` | `TRUE` | Persist to disk (the `vectorstore` volume). |
| `PERSIST_DIRECTORY` | `/chroma/chroma` | On-disk path. |
| `ANONYMIZED_TELEMETRY` | `FALSE` | Disable Chroma telemetry. |

The `command:` references `CHROMA_WORKERS`, `CHROMA_HOST_ADDR`, `CHROMA_HOST_PORT`, `CHROMA_LOG_CONFIG`, `CHROMA_TIMEOUT_KEEP_ALIVE` — these are **chroma-image env vars defaulted by the image** (passed literally via `$$`), not values we set.

### chat_postgres (`postgres:16.3`)

| Env var | Value | What it does |
| --- | --- | --- |
| `POSTGRES_USER` | `admin` | Superuser created on first init. |
| `POSTGRES_PASSWORD_FILE` | `/run/secrets/postgres_password` | Password (first-init only — see [secrets.md](secrets.md)). |
| `POSTGRES_DB` | `chat_db` | Initial database (the bridge's). The agents `agent_runtime` DB is created out-of-band on the same instance. |

TLS is added by `entrypoint-postgres-tls.sh` (honors `REQUIRE_TLS`).

### redis (`redis:7.4-alpine`)

Configured entirely by **command flags**, no env vars: password from `/run/secrets/redis_password`, `--tls-port 6379` (plain port disabled), `--tls-auth-clients no` (password-over-TLS, not mTLS), `--maxmemory 256mb`, `--maxmemory-policy allkeys-lru`, `--save "" --appendonly no` (ephemeral — streams only). TLS is hardwired in the command, so there is no `REQUIRE_TLS` toggle here.

### agentic_ui (nginx)

| Env var | Default / value | What it does |
| --- | --- | --- |
| `BFF_BASE_URL` | `https://dialogue_bridge:8002` | Upstream the nginx `/api/` proxy forwards to (substituted into `nginx.conf.template`). |
| `TRUSTED_PROXY_SECRET` | (from secret via shim) | Injected as the internal-caller header on proxied requests. |
| `REQUIRE_TLS` | `true` | Fail-closed HTTPS (via `entrypoint-nginx-tls.sh`). |

### vault (`hashicorp/vault:1.21`)

| Env var | Value | What it does |
| --- | --- | --- |
| `SKIP_SETCAP` | `true` | Skip the setcap step (we grant `IPC_LOCK` via `cap_add` and `disable_mlock`). |
| `VAULT_LOCAL_CONFIG` | inline JSON | Full server config: `ui`, raft storage at `/vault/data`, TLS listener on `:8004`, `api_addr`/`cluster_addr`. |

For the CLI, set `VAULT_ADDR=https://vault:8004` (or `https://localhost:8004`) — **not** `127.0.0.1`, which fails cert validation (the cert has no IP SAN).

### Monitoring stack (`docker-compose-denis-monitoring.yml`)

| Service | Key vars / flags |
| --- | --- |
| **grafana** | `GRAFANA_USER` (admin username), `GF_SECURITY_ADMIN_PASSWORD__FILE` (secret), `GF_USERS_ALLOW_SIGN_UP=false`, `GF_SERVER_PROTOCOL=https` + `GF_SERVER_CERT_FILE`/`_KEY`, `GF_SERVER_ROOT_URL=https://monitoring.<your-domain>`. **Env only seeds on first `grafana-data` init.** |
| **prometheus** | command flags: `--storage.tsdb.retention.time=90d`, `--storage.tsdb.retention.size=8GB`, `--config.file`, `--web.enable-lifecycle`, `--log.level=error`. |
| **loki / alloy / alertmanager / cadvisor / node-exporter** | command flags only (config-file paths); no app env vars to tune. SMTP for alerts is configured inside `alertmanager.yml`. |

---

## Deploy-time safety toggles (cross-service)

These flip behavior at boot; all are **fail-closed by default** (secure unless explicitly disabled).

| Env var | Default | Services | Effect when `true` (default) | Set `false` to… |
| --- | --- | --- | --- | --- |
| `REQUIRE_TLS` | `true` | bridge, agents, rag, postgres, nginx | Refuse to start if cert/key (or CA for nginx) is missing/unreadable. | Allow plaintext fallback (emergency only). |
| `REQUIRE_MTLS` | `true` | bridge, agents, rag (uvicorn) | Require + verify a CA-signed **client** cert (`--ssl-cert-reqs 2`). | One-way TLS (server-auth only) — the lever for the zero-downtime mTLS rollout. |
| `RUN_MIGRATIONS_ON_STARTUP` | `true` | bridge | Run `alembic upgrade head` before serving. | Boot without migrating (to run alembic by hand). |
| `AGENT_RUNTIME_SETUP_ON_STARTUP` | `true` | agents | Run checkpointer `setup()` DDL on boot. | Skip DDL (DB already set up / debugging). |
| `LANGGRAPH_STRICT_MSGPACK` | `true` | agents | Block the msgpack RCE deserialization class. | **Don't** — only to debug a serialization issue. |

---

## Sharp Edges and Behavioral Notes

- **Prod leaves `APP_ENV`/`ENV` unset on purpose.** Settings treat "not `development`/`test`" as production, which makes Vault config and `SESSION_TOKEN_SECRET` mandatory and disables the random dev-secret fallbacks. Setting `APP_ENV=production` works too but is redundant.
- **`TRUSTED_PROXY_SECRET` is a hard start gate** on all three Python services — a `model_validator` raises if it's empty. This is the single most common "service won't boot" cause after a secret rename.
- **`*_FILE` unreadable is fail-loud; `*_FILE` unset is a silent fallback.** A set-but-unreadable secret path raises at startup (so a permission slip is loud), but an *unset* `*_FILE` quietly falls back to the plain env var — which is exactly what local `.env` dev relies on.
- **`LOG_FORMAT` defaults to `console`.** Prod must run `json` (the production compose sets it on all three) or Alloy can't extract the `level` label and the Loki dashboards/error alerts break.
- **The redaction secret only affects `client_ip`** now (`user_id`/`session_id` are logged raw to match the DB — see [observability.md](../development/observability.md)). Without the shared secret, `client_ip` correlation degrades to per-process; it never leaks the raw IP.
- **JWT TTLs and CORS are validated.** Out-of-range JWT durations raise; `CORS_ALLOWED_ORIGINS` containing `*` with credentials on raises. These are startup failures, not silent clamps.
- **Cookie names auto-prefix `__Host-`** when `SESSION_COOKIE_SECURE=true` and no `SESSION_COOKIE_DOMAIN` is set. Set a domain only if you genuinely need cross-subdomain cookies — it drops the `__Host-` hardening.
- **agents reads two databases.** `DATABASE_*` (bridge) and `AGENT_RUNTIME_DATABASE_*` (agents checkpointer) are different DBs on the same Postgres instance, and the latter is a **raw psycopg** conninfo (`postgresql://`), not the bridge's `postgresql+asyncpg://`.
- **rag_service is the odd one out** — it uses `ENVIRONMENT` (not `APP_ENV`/`ENV`) and keeps `LOG_LEVEL`/`LOG_FORMAT` on `AppSettings`, while the bridge/agents keep them on a `LoggingSettings` group. Same vars, slightly different internal shape.

---

## File Map

| Concept | File | What to look for |
| --- | --- | --- |
| bridge settings | [src/dialogue_bridge/core/settings.py](../../src/dialogue_bridge/core/settings.py) | every `*Settings` class + `validation_alias` |
| agents settings | [src/agents/core/settings.py](../../src/agents/core/settings.py) | checkpointer, workflows, deep-agents, filesystem |
| rag settings | [src/rag_service/core/settings.py](../../src/rag_service/core/settings.py) | `AppSettings`, `RagSettings`, `ProxySettings` |
| TLS toggles | [src/tls/entrypoint-tls.sh](../../src/tls/entrypoint-tls.sh) | `REQUIRE_TLS`, `REQUIRE_MTLS` |
| nginx env substitution | [src/agentic_ui/nginx.conf.template](../../src/agentic_ui/nginx.conf.template) | `BFF_BASE_URL`, `TRUSTED_PROXY_SECRET` |
| core stack compose | [src/docker-compose-denis.yaml](../../src/docker-compose-denis.yaml) | per-service `environment:` overrides |
| monitoring compose | [src/docker-compose-denis-monitoring.yml](../../src/docker-compose-denis-monitoring.yml) | grafana/prometheus env + flags |
| secret delivery | [docs/architecture/secrets.md](secrets.md) | which var is backed by which secret |

### Multi-account sign-in (dialogue_bridge)

| Variable | Default | Purpose |
| --- | --- | --- |
| `MULTI_ACCOUNT_ENABLED` | `true` | Master switch for several signed-in accounts per browser. Set `false` to remove the surface entirely — every `/v1/auth/accounts*` route then 404s. It does keep more live refresh tokens in one browser (blast radius of a stolen session goes from one account to N), bounded by the cap, at-rest encryption and per-switch rotation. |
| `PARKED_TOKEN_KEY` | *derived* | AES-GCM key encrypting parked refresh tokens at rest — **at least** 32 bytes, base64 or hex (more is fine: `openssl rand -base64 64` is condensed with HKDF; less is refused rather than stretched). Set it explicitly in production — on Dennis as the Swarm secret `magenticx_parked_token_key` via `PARKED_TOKEN_KEY_FILE` — so it rotates independently. When unset it is derived from `SESSION_TOKEN_SECRET` (HKDF, fixed info label), so local dev needs no extra variable. **Never falls back to plaintext:** with neither this nor `SESSION_TOKEN_SECRET` present, boot fails closed. Note the derived path ties the two together — rotating `SESSION_TOKEN_SECRET` signs every parked account out. |
| `MAX_PARKED_ACCOUNTS` | `2` | Hard ceiling on accounts signed in **in total** (the active one plus the parked ones). A security bound, not a UI limit — each parked entry is a live bearer credential. Checked *before* authenticating on the add-account path; asking for one more surfaces the "log out of one to continue" dialog. |
| `SESSION_DEVICE_COOKIE_NAME` | `__Host-mx_device` / `mx_device` | Cookie holding the opaque parked-session index id. Follows the same `__Host-` rule as the session cookies. |

See [authentication-and-session § Phase 10](../flows/authentication-and-session.md) for the flow and threat model.
