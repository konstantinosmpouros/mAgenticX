# Dialogue Bridge Service

The `dialogue_bridge` service is the backend-for-frontend layer for the Agentic UI. It sits between the browser and the downstream services and owns:

- user authentication against Vault
- bridge-managed session cookies and CSRF protection
- Postgres persistence for conversations, messages, attachments, blobs, sessions, and user preferences
- agent catalog caching and tool catalog proxying
- inference stream proxying to the `agents` service

This README documents the current implementation under `src/dialogue_bridge`.

## 1. What This Service Owns

The bridge is the main application-facing API. It owns five major areas:

1. Authentication and session lifecycle.
2. User-scoped validation and authorization.
3. Persistence of chat state and binary attachments.
4. Proxying agent capabilities from the `agents` service.
5. Browser-facing safety concerns such as CSRF, CORS, rate limiting, and proxy-aware client IP handling.

It does not:

- run agent logic itself
- execute retrieval or SQL directly
- render UI

## 2. System Position

```mermaid
flowchart LR
    UI[agentic_ui] --> BRIDGE[dialogue_bridge]
    BRIDGE --> VAULT[Vault userpass]
    BRIDGE --> PG[(Postgres)]
    BRIDGE --> AGENTS[agents service]
    AGENTS --> RAG[rag_service]
    AGENTS --> MCP[MCP Gateway]
```

## 3. Service Responsibilities

### 3.1 Authentication

- accepts username/password login requests
- authenticates against Vault `userpass`
- creates bridge-managed access and refresh sessions in Postgres
- issues HTTP-only cookies plus a CSRF cookie

### 3.2 Conversation persistence

- stores conversations, messages, reactions, plans, subagent state, attachments, and blobs
- keeps per-conversation `last_message_preview` and timestamps for fast sidebar rendering
- supports message branching through `parent_message_id`

### 3.3 Capability proxying

- caches active agent manifests from the `agents` service
- proxies MCP tool catalog requests through the bridge
- proxies dictation uploads to the `agents` speech-to-text endpoint
- forwards SSE inference streams from `agents` to the browser

### 3.4 User preferences

- persists disabled tool preferences
- persists `prefersAgenticChat`

## 4. High-Level Architecture

```mermaid
flowchart TD
    A[Browser request] --> B{Bridge router}
    B -->|auth| C[Vault + session tables]
    B -->|catalog| D[Agent cache + agents service]
    B -->|conversations/messages| E[Postgres via SQLAlchemy]
    B -->|inference| F[Prepare history branch]
    F --> G[POST to agents stream endpoint]
    G --> H[Forward SSE back to browser]
    B -->|attachments| I[Blob streaming / image pagination]
```

## 5. Runtime and App Setup

`main.py` wires the service as a FastAPI app with:

- lifespan hook that creates database tables on startup
- CORS middleware
- SlowAPI middleware for rate limiting
- request logging middleware
- pagination support
- router registration under `/v1/*`

### Included routers

| Router | Prefix |
| --- | --- |
| auth | `/v1/auth` |
| inference | `/v1/inference` |
| catalog | `/v1/catalog` |
| preferences | `/v1/preferences` |
| conversations | `/v1/conversations` |
| messages | `/v1/messages` |
| attachments | `/v1/attachments` |

## 6. Authentication and Session Model

The current implementation does not exchange Vault credentials for an OIDC JWT. It authenticates with Vault and then creates its own session records and cookies.

### 6.1 Login flow

```mermaid
sequenceDiagram
    participant Browser
    participant Bridge
    participant Vault
    participant Postgres

    Browser->>Bridge: POST /v1/auth/login
    Bridge->>Vault: userpass login
    Vault-->>Bridge: client_token + entity_id
    Bridge->>Postgres: upsert user
    Bridge->>Postgres: create session row
    Bridge-->>Browser: access cookie + refresh cookie + csrf cookie
```

### 6.2 Session model

Bridge sessions are stored in `SessionTable` with:

- hashed access token
- hashed refresh token
- access expiry
- refresh expiry
- revoked timestamp
- hashed user-agent
- hashed client IP

### 6.3 Cookie and CSRF behavior

Cookies issued by the bridge:

- access cookie
- refresh cookie
- CSRF cookie

State-changing requests require CSRF validation unless the client is using bearer authentication without an access cookie. The bridge compares:

- header: `SESSION_CSRF_HEADER_NAME` default `X-CSRF-Token`
- cookie: `SESSION_CSRF_COOKIE_NAME`

### 6.4 Session lifecycle endpoints

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/v1/auth/login` | `POST` | authenticate and create session |
| `/v1/auth/session` | `GET` | inspect current authenticated session |
| `/v1/auth/session/refresh` | `POST` | rotate session tokens |
| `/v1/auth/logout` | `POST` | revoke session and clear cookies |

### 6.5 Session limits

When a user exceeds `SESSION_MAX_PER_USER`, older active sessions are revoked automatically to make room for the new one.

### 6.6 Authorization model

User-scoped routes are protected in two layers:

1. `require_current_user` validates the session.
2. `require_bound_user_id` ensures the path `user_id` matches the authenticated user.

## 7. Database Model

The bridge persists its own application state in Postgres through SQLAlchemy async ORM.

```mermaid
erDiagram
    UserTable ||--o| UserPreferencesTable : has
    UserTable ||--o{ SessionTable : has
    UserTable ||--o{ ConversationTable : owns
    AgentTable ||--o{ ConversationTable : used_by
    ConversationTable ||--o{ MessageTable : contains
    MessageTable ||--o{ AttachmentTable : contains
    AttachmentTable ||--o| BlobTable : stores
    MessageTable }o--|| MessageTable : parent_message_id
```

### 7.1 Main tables

| Table | Purpose |
| --- | --- |
| `users` | authenticated user records mapped from Vault entity ids |
| `user_preferences` | disabled tools and agentic-chat preference |
| `sessions` | bridge-managed access/refresh sessions |
| `agents` | cached agent manifests from the agents service |
| `conversations` | conversation shell and sidebar metadata |
| `messages` | user and AI messages, reactions, reasoning, plan, subagent state |
| `attachments` | metadata for uploaded files |
| `blobs` | raw binary payload storage |

### 7.2 Important message fields

`MessageTable` stores more than plain text:

- `reasoning_steps`
- `reasoning_time_seconds`
- `raw_events`
- `plan`
- `subagents`
- `is_error`
- `error_message`

That means the bridge is also the persistence layer for agent telemetry needed by the UI.

## 8. Agent Catalog and Tool Catalog

The bridge does not hardcode the agent list. It synchronizes from the `agents` service.

### 8.1 Agent sync flow

```mermaid
flowchart TD
    A[GET /v1/catalog/agents] --> B{In-memory cache primed?}
    B -->|Yes| C[Return cached active agents]
    B -->|No| D[Call agents service /agents]
    D --> E[Upsert manifests into AgentTable]
    E --> F[Deactivate missing agents]
    F --> G[Prime in-memory cache]
    G --> H[Return active agents]
```

### 8.2 Catalog behavior

- Active agent cache is in-memory.
- On cache miss, the bridge synchronizes against `agents`.
- Manifests are upserted by `id`.
- Any DB agent missing from the latest upstream list is marked inactive.

### 8.3 Tool catalog behavior

- `GET /v1/catalog/tools` simply proxies the `agents` service `/tools` endpoint.
- No separate tool cache exists in the bridge.

## 9. Conversation and Message Lifecycle

### 9.1 Conversation creation

`POST /v1/conversations/{user_id}`

Behavior:

- validates the user scope
- validates the target agent from the cached agent list
- generates a title through the `agents` title endpoint when none is provided
- falls back to message preview, agent name, or `"New conversation"` if title generation fails
- creates the conversation and first message atomically

### 9.2 Message creation

`POST /v1/messages/{user_id}/{conversation_id}`

Behavior:

- appends a new message to an existing conversation
- optionally persists attachments and blobs
- updates conversation preview/timestamp when there is meaningful content

### 9.3 AI placeholder update

`PATCH /v1/messages/{user_id}/{conversation_id}/{message_id}`

Used to finalize an existing AI placeholder after streaming completes. Only AI messages can be updated through this route.

### 9.4 Reactions

Routes:

- `POST /v1/messages/{user_id}/{conversation_id}/{message_id}/like`
- `POST /v1/messages/{user_id}/{conversation_id}/{message_id}/dislike`

Behavior:

- toggles nullable `liked`
- `True` means like
- `False` means dislike
- `None` means cleared reaction

## 10. Inference Proxy Flow

The bridge constructs the upstream agent request from stored conversation data instead of blindly forwarding browser payloads.

```mermaid
sequenceDiagram
    participant UI
    participant Bridge
    participant DB as Postgres
    participant Agents

    UI->>Bridge: POST /v1/inference/stream/{user}/{conversation}
    Bridge->>DB: load conversation + messages + attachments
    Bridge->>Bridge: validate messagePath
    Bridge->>Bridge: remove trailing empty AI placeholder
    Bridge->>Bridge: serialize text + inline image data URLs
    Bridge->>Agents: POST /agents/{slug}/stream
    Agents-->>Bridge: SSE AG-UI frames
    Bridge-->>UI: forwarded SSE stream
```

### 10.1 Upstream payload shape

The bridge sends this shape to the `agents` service:

```json
{
  "messages": [...],
  "config": {
    "run_config": {
      "configurable": {
        "thread_id": "<conversation_id>"
      }
    },
    "context": {
      "user_id": "<user_id>",
      "conversation_id": "<conversation_id>"
    },
    "tools": [
      {
        "tool_name": "...",
        "server_id": "..."
      }
    ]
  }
}
```

### 10.2 Branch selection

The inference payload accepts:

- `messagePath`
- `enabledTools`

`messagePath` is validated to ensure:

- every id is a non-empty string
- there are no duplicates
- every referenced message belongs to the current conversation

### 10.3 Message serialization rules

The bridge serializes stored messages for the agent runtime as:

- text content first
- image attachments as inline base64 data URLs
- non-image attachments as textual bullet summaries

Trailing empty AI placeholder messages are removed from the upstream history so the agent does not receive unfinished assistant output back as context.

### 10.4 Streaming behavior

- The upstream stream is proxied as `text/event-stream`.
- `X-Request-ID` is propagated upstream when available.
- `Cache-Control: no-cache`, `Connection: keep-alive`, and `X-Accel-Buffering: no` are set on the response.
- Upstream `httpx` errors are converted into a `RUN_ERROR` SSE frame for the client.

## 11. Attachments and Blob Delivery

### 11.1 Attachment ingestion

Attachments are sent as base64 payloads in `MessageIn.attachments`.

Current constraints from the schemas:

- max attachment size: `25 MB`
- max total attachment payload per message: `25 MB`
- max attachments per message: `10`

### 11.2 Stored representation

- raw bytes are decoded from base64
- a `BlobTable` row stores the binary content
- an `AttachmentTable` row stores metadata and links to the blob

### 11.3 Download endpoints

| Endpoint | Purpose |
| --- | --- |
| `/v1/attachments/download/{user_id}/{conversation_id}/{message_id}/{blob_id}` | stream non-image blobs with byte-range support |
| `/v1/attachments/images/{user_id}` | paginated base64 image retrieval |

### 11.4 Blob download behavior

- only non-image blobs are served by the download endpoint
- images are intentionally blocked there and served via the image pagination route
- byte ranges are supported with `206 Partial Content`
- `Accept-Ranges` and `Content-Range` are set appropriately

## 12. Preferences Model

The preferences surface is:

- `GET /v1/preferences/{user_id}`
- `PUT /v1/preferences/{user_id}`

Current payload fields:

- `tools.disabled`
- `prefersAgenticChat`

Disabled tools are normalized and deduplicated by `server_id + tool_name`.

## 13. Request Models and Limits

### 13.1 Inference payload

```json
{
  "messagePath": ["msg-1", "msg-2"],
  "enabledTools": [
    {
      "serverId": "tavily",
      "toolName": "tavily-search"
    }
  ]
}
```

### 13.2 Conversation creation payload

```json
{
  "agentId": "agent-id",
  "isPrivate": false,
  "title": null,
  "firstMessage": {
    "sender": "user",
    "type": "text",
    "content": "Help me compare discounts by country",
    "attachments": []
  }
}
```

### 13.3 Attachment validation rules

Each attachment requires:

- `name`
- `mime`
- valid base64 `dataB64`

Either `content` or at least one attachment must be present for non-placeholder messages.

## 14. API Surface

### 14.1 Auth

| Endpoint | Method |
| --- | --- |
| `/v1/auth/login` | `POST` |
| `/v1/auth/session` | `GET` |
| `/v1/auth/session/refresh` | `POST` |
| `/v1/auth/logout` | `POST` |

### 14.2 Catalog

| Endpoint | Method |
| --- | --- |
| `/v1/catalog/agents` | `GET` |
| `/v1/catalog/tools` | `GET` |

### 14.3 Preferences

| Endpoint | Method |
| --- | --- |
| `/v1/preferences/{user_id}` | `GET` |
| `/v1/preferences/{user_id}` | `PUT` |

### 14.4 Conversations

| Endpoint | Method |
| --- | --- |
| `/v1/conversations/{user_id}` | `POST` |
| `/v1/conversations/{user_id}` | `GET` |
| `/v1/conversations/{user_id}/{conversation_id}` | `GET` |
| `/v1/conversations/{user_id}/{conversation_id}` | `DELETE` |
| `/v1/conversations/{user_id}/{conversation_id}/title` | `PATCH` |

### 14.5 Messages

| Endpoint | Method |
| --- | --- |
| `/v1/messages/{user_id}/{conversation_id}` | `POST` |
| `/v1/messages/{user_id}/{conversation_id}/{message_id}` | `PATCH` |
| `/v1/messages/{user_id}/{conversation_id}/{message_id}/like` | `POST` |
| `/v1/messages/{user_id}/{conversation_id}/{message_id}/dislike` | `POST` |

### 14.6 Inference

| Endpoint | Method |
| --- | --- |
| `/v1/inference/stream/{user_id}/{conversation_id}` | `POST` |
| `/v1/inference/dictation/{user_id}` | `POST` |

### 14.7 Attachments

| Endpoint | Method |
| --- | --- |
| `/v1/attachments/download/{user_id}/{conversation_id}/{message_id}/{blob_id}` | `GET` |
| `/v1/attachments/images/{user_id}` | `GET` |

## 15. Observability, Security, and Edge Behavior

### 15.1 Observability

The service has a queue-based structured logging stack similar to `agents`.

It logs:

- request lifecycle
- DB operations
- auth outcomes
- agent sync and tool fetch outcomes
- inference stream metrics
- blob download metrics

### 15.2 Stream metrics

Inference and blob streaming are instrumented with:

- chunk count
- forwarded bytes
- first-byte latency
- total stream duration
- SSE event counts where applicable

### 15.3 Proxy awareness

Client IP resolution trusts forwarded headers only when the request comes from:

- a trusted proxy secret header, or
- a trusted proxy CIDR

### 15.4 Rate limiting

Authentication is rate-limited per resolved client IP using SlowAPI.

### 15.5 CORS

CORS settings are configurable through env vars, with defaults aimed at local Agentic UI development.

## 16. Configuration

Configuration is loaded from `core/configs.py`.

### 16.1 Required variables

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | async SQLAlchemy database URL |
| `SESSION_TOKEN_SECRET` | HMAC secret for session token hashing and log redaction fallback |

`VAULT_URL` is effectively required if you want login to work. Without it, the auth router loads but login returns a configuration error.

### 16.2 Upstream and auth variables

| Variable | Default |
| --- | --- |
| `AGENTS_SERVICE_URL` | `http://agents:8003` |
| `VAULT_USERPASS_MOUNT` | `userpass` |
| `VAULT_OIDC_ROLE` | `agenticx` |
| `VAULT_OIDC_PATH` | `identity/oidc/token` |
| `VAULT_HTTP_TIMEOUT` | `10.0` |

Note: `VAULT_OIDC_ROLE` and `VAULT_OIDC_PATH` exist in settings, but the current implementation does not use them during login.

### 16.3 Session variables

| Variable | Default |
| --- | --- |
| `SESSION_COOKIE_SECURE` | `true` |
| `SESSION_COOKIE_SAMESITE` | `lax` |
| `SESSION_ACCESS_TTL_SECONDS` | `900` |
| `SESSION_REFRESH_TTL_SECONDS` | `604800` |
| `SESSION_MAX_PER_USER` | `3` |

### 16.4 Rate limit and proxy variables

| Variable | Default |
| --- | --- |
| `AUTH_RATE_LIMIT_MAX_ATTEMPTS` | `4` |
| `AUTH_RATE_LIMIT_WINDOW_SECONDS` | `60` |
| `TRUSTED_PROXY_HEADER_NAME` | `X-Internal-Proxy-Secret` |
| `TRUSTED_PROXY_SECRET` | empty |
| `TRUSTED_PROXY_CIDRS` | empty |

### 16.5 CORS variables

Defaults allow local origins around ports `8080` and `8050`. See `core/configs.py` for the authoritative list and override behavior.

## 17. Directory Map

```text
src/dialogue_bridge/
├── main.py                        FastAPI app bootstrap and router wiring
├── core/
│   ├── configs.py                 Environment-driven settings
│   ├── database.py                ORM models and session factory
│   ├── auth_client.py             Vault userpass client
│   └── auth_session.py            Session, cookie, CSRF, and auth dependencies
├── router/
│   ├── auth.py                    Login/session/logout
│   ├── catalog.py                 Agents and tools catalog
│   ├── preferences.py             User preferences
│   ├── conversations.py           Conversation CRUD
│   ├── messages.py                Message create/update/reactions
│   ├── inference.py               SSE proxy and dictation proxy
│   └── attachments.py             Blob streaming and image pagination
├── schemas/                       Pydantic request/response models
├── utils/
│   ├── agents.py                  Agent sync and upstream catalog helpers
│   ├── conversations.py           Conversation/message/blob persistence helpers
│   ├── inference.py               Branch resolution and agent payload serialization
│   ├── titles.py                  Upstream title generation helper
│   ├── validators.py              Ownership validators
│   ├── proxy.py                   Trusted proxy IP resolution
│   └── rate_limit.py              SlowAPI setup
├── observability/                 Logging, metrics, middleware, redaction
├── requirements.txt
└── Dockerfile
```

## 18. Local Development

```bash
cd src/dialogue_bridge
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

export DATABASE_URL=postgresql+asyncpg://admin:admin@localhost:5432/chat_db
export AGENTS_SERVICE_URL=http://localhost:8003
export VAULT_URL=http://localhost:8004
export VAULT_USERPASS_MOUNT=userpass
export SESSION_TOKEN_SECRET=change-me

uvicorn main:app --host 0.0.0.0 --port 8002 --reload
```

For meaningful local use, you also need:

- Postgres
- the `agents` service
- Vault if you want login to work

## 19. Docker and Compose

### Dockerfile

The image:

- uses `python:3.10-slim`
- installs `build-essential`
- installs dependencies from `requirements.txt`
- copies the app into `/app`
- starts Uvicorn on port `8002`

### Compose wiring

From `src/docker-compose.yaml`:

- `dialogue_bridge` depends on:
  - `agents`
  - `chat_postgres`
- exposed port:
  - `8002:8002`
- networks:
  - `backend`
  - `frontend`
  - `hashicorp_vault`

Configured environment there includes:

- `DATABASE_URL=postgresql+asyncpg://admin:admin@chat_postgres:5432/chat_db`
- `VAULT_URL=http://vault:8004`
- `SESSION_TOKEN_SECRET=${SESSION_TOKEN_SECRET}`
- `TRUSTED_PROXY_SECRET=${TRUSTED_PROXY_SECRET}`

## 20. Known Behavioral Notes

- Database schema creation happens automatically on startup through `Base.metadata.create_all`.
- Agent manifests are synchronized on demand, not during startup.
- `get_agent_by_id` currently reads only from the in-memory cache, so a cache miss depends on a prior catalog sync path having primed it.
- Login works with Vault userpass only in the current code.
- The bridge stores raw binary blobs in Postgres, not in external object storage.
- Image attachments are returned as base64 in the image pagination endpoint.

## 21. Quick File References

- `main.py`: app setup and route prefixes
- `core/auth_session.py`: sessions, cookies, CSRF, and auth dependencies
- `core/auth_client.py`: Vault authentication
- `core/database.py`: ORM schema
- `router/inference.py`: SSE proxying and dictation proxy
- `utils/inference.py`: branch resolution and multimodal serialization
- `utils/agents.py`: agent cache and tools proxy helpers
