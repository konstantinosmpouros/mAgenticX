# Dialogue Bridge Service

The `dialogue_bridge` service is the backend-for-frontend layer for the Agentic UI. It sits between the browser and the downstream services and owns:

- user authentication against Vault
- bridge-managed session cookies and CSRF protection
- Postgres persistence for conversations, messages, attachments, blobs, sessions, and user preferences
- agent catalog caching and tool catalog proxying
- detached inference run lifecycle — server-owned asyncio tasks with WebSocket observers backed by per-run Redis Streams

This README documents the current implementation under `src/dialogue_bridge`.

## 1. What This Service Owns

The bridge is the main application-facing API. It owns six major areas:

1. Authentication and session lifecycle.
2. User-scoped validation and authorization.
3. Persistence of chat state and binary attachments.
4. Proxying agent capabilities from the `agents` service.
5. Browser-facing safety concerns such as CSRF, CORS, rate limiting, and proxy-aware client IP handling.
6. Detached inference run lifecycle — spawning server-owned asyncio tasks, appending AG-UI events to per-run Redis Streams, serving WebSocket observers with cursor-based replay, and writing the terminal snapshot to Postgres on completion.

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
- owns detached inference runs and exposes WebSocket observer streams to the browser (with a deprecated SSE endpoint kept for one release cycle)

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
    B -->|inference| F[Start run + AI placeholder]
    F --> G[Detached task posts to agents stream]
    G --> H[WebSocket observer fan-out via Redis Stream]
    B -->|attachments| I[Blob streaming / image pagination]
```

## 5. Runtime and App Setup

`main.py` wires the service as a FastAPI app with:

- lifespan hook that creates database tables on startup and calls `cleanup_orphaned_inference_runs()` to mark any stuck queued/running/cancelling run rows as failed before accepting new traffic
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
| speech | `/v1/speech` |
| voice | `/v1/voice` |
| catalog | `/v1/catalog` |
| preferences | `/v1/preferences` |
| conversations | `/v1/conversations` |
| messages | `/v1/messages` |
| attachments | `/v1/attachments` |
| shared conversations | `/v1/shared-conversations` |
| search | `/v1/search` |

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
    Bridge->>Vault: sign access + refresh JWTs (Transit)
    Bridge-->>Browser: access cookie + refresh cookie + csrf cookie
```

### 6.2 Session model

Sessions are **stateless** — there is no session table. After Vault verifies the credential, the bridge issues two RS256 JWTs **signed by Vault Transit** (the private key never leaves Vault):

- access token (8 h) — verified by signature on every request; no DB or Vault call on the hot path
- refresh token (10 d absolute cap) — rotates the pair, reusing the original login session id (`sid`)

Per-request verification is signature-only against a cached public key. The only shared state is a fail-open Redis logout denylist keyed by `sid`.

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

### 6.5 Revocation

Logout clears the device's cookies and denylists its session id in Redis, so a copy of the token stolen before logout is rejected instantly on the next request. There is no per-user session cap — stateless tokens carry no server-side session roster.

### 6.6 Authorization model

User-scoped routes are protected in two layers:

1. `require_current_user` validates the session.
2. `require_bound_user_id` ensures the path `user_id` matches the authenticated user.

## 7. Database Model

The bridge persists its own application state in Postgres through SQLAlchemy async ORM.

```mermaid
erDiagram
    UserTable ||--o| UserPreferencesTable : has
    UserTable ||--o{ ConversationTable : owns
    AgentTable ||--o{ ConversationTable : used_by
    ConversationTable ||--o{ MessageTable : contains
    ConversationTable }o--o| MessageTable : active_assistant_message_id
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
| `conversations` | conversation shell and sidebar metadata; `active_assistant_message_id` FK points to the AI message currently being streamed |
| `messages` | user and AI messages, reactions, reasoning, plan, subagent state, plus `streaming_*` columns (status / message_path / started_at / completed_at / cancel_requested_at) that drive the inference-run lifecycle. A partial unique index on `conversation_id WHERE streaming_status IN ('queued','running','cancelling')` ensures at most one active stream per conversation. |
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

### 7.3 Schema migrations (Alembic)

Schema is versioned with Alembic. Source of truth:

- ORM models in [`core/database.py`](core/database.py) — the canonical declaration.
- Migration files in [`migrations/versions/`](migrations/versions/) — the ordered set of changes applied over time.
- [`alembic.ini`](alembic.ini) — minimal config; the DB URL is **not** stored here, it is read from `core.settings.settings.database.url` at runtime by [`migrations/env.py`](migrations/env.py).

The baseline migration ([`0001_baseline.py`](migrations/versions/0001_baseline.py)) reproduces the schema previously created by `Base.metadata.create_all`. **It is the floor of the migration history — never edit it.** All future schema changes go in new migrations on top.

**Startup wiring:** the lifespan handler in [`main.py`](main.py) runs `alembic upgrade head` before the app accepts traffic. The upgrade runs in a worker thread (via `asyncio.to_thread`) so alembic's env.py — which opens its own async engine — doesn't collide with FastAPI's event loop. `script_location` is anchored to an absolute path so the call works regardless of the process CWD.

**Emergency opt-out:** `RUN_MIGRATIONS_ON_STARTUP=false` skips the upgrade entirely. Use this if a buggy migration is taking the API down and you need to boot the container to apply a fix manually. Default is `True`; never set it to `False` in normal operation.

**Authoring a new migration** after changing a model in `core/database.py`:

```bash
docker compose -f src/docker-compose.yaml exec dialogue_bridge \
    alembic revision --autogenerate -m "add_foo_column_to_conversations"
```

Review the generated file under `src/dialogue_bridge/migrations/versions/`. Autogenerate is good but not perfect — hand-tune for server-side defaults, partial indexes, enum changes, and any data backfill (`op.execute("UPDATE ...")`). Then apply:

```bash
docker compose -f src/docker-compose.yaml exec dialogue_bridge alembic upgrade head
```

**Useful commands**:

| Command | Effect |
| --- | --- |
| `alembic current` | Print the revision currently applied to the DB. |
| `alembic history` | Show the chain of migrations. |
| `alembic upgrade head` | Apply all pending migrations. |
| `alembic upgrade head --sql` | Print the SQL without executing (offline mode, for review). |
| `alembic downgrade -1` | Roll back one revision (only for migrations that implement `downgrade()`). |
| `alembic stamp <revision>` | Mark the DB at a specific revision without running any migration. Used during the production cutover (Phase 3). |
| `alembic check` | Fail if `core/database.py` has model changes that are not yet captured by a migration. Suitable for CI. |

**Production cutover (one-off):** Dennis already has every table from earlier `create_all` runs but no `alembic_version` row. **Before** deploying the image that runs `alembic upgrade head` on startup, run **once** on Dennis to mark the DB as already at baseline:

```bash
sudo docker exec -it $(sudo docker ps -qf name=magenticx_dialogue_bridge) \
    alembic stamp 0001_baseline
```

This inserts the version row only — no data is touched. From then on every container start runs `alembic upgrade head`, which is a no-op until a real migration is added on top of the baseline.

If you forget to stamp first, the baseline migration will try to `CREATE TABLE` on tables that already exist and the startup will fail. Recovery is to drop the failed transaction state (the partial migration won't have committed) and run `alembic stamp 0001_baseline` before restarting.

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
- generates multiple title candidates through the `agents` title endpoint when none is provided and picks one at random
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

## 10. Inference Run Flow

The bridge constructs the upstream agent request from stored conversation data instead of blindly forwarding browser payloads.

```mermaid
sequenceDiagram
    participant UI
    participant Bridge
    participant DB as Postgres
    participant Task as Inference task
    participant Agents

    UI->>Bridge: POST /v1/inference/runs/{user}/start
    Bridge->>DB: persist user action + AI placeholder (streaming_status='queued')
    Bridge->>Task: launch(message.id)
    Bridge->>UI: detail + summary + run + assistant message
    UI->>Bridge: WS /v1/inference/runs/{user}/{run}/ws (subscribe since=null)
    Bridge-->>UI: DB snapshot if already terminal, otherwise live tail
    Task->>DB: load conversation + messages + attachments
    Task->>Task: validate messagePath
    Task->>Task: remove trailing empty AI placeholder
    Task->>Task: serialize text + inline image data URLs
    Task->>Agents: POST /agents/{slug}/stream
    Agents-->>Task: SSE AG-UI frames
    Task->>Bridge: XADD inference:run:{id}:events
    Bridge-->>UI: {"type":"event","seq":"...","payload":...}
    Task->>DB: terminal AI message + conversation write
    Task->>Bridge: XADD terminal + EXPIRE 3600s
    Bridge-->>UI: {"type":"terminal"} → close
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

- `mode`
- `message`
- `conversationId`, `parentMessageId`, or `targetMessageId` depending on mode
- `messagePath`

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

- The bridge owns a detached run task and the browser observes it over `text/event-stream`.
- `Cache-Control: no-cache`, `Connection: keep-alive`, and `X-Accel-Buffering: no` are set on observer responses.
- Upstream AG-UI frames are parsed into in-memory run state and emitted to observers as run snapshots.
- Upstream failures transition the run to `failed` and publish a terminal snapshot.

## 11. Detached Inference Runs

Detached runs are the primary inference path. The run lifecycle is fully owned by the server; the browser is a passive observer.

### 11.1 Run creation

`start_inference_flow(...)` (in `utils/inference_start.py`) orchestrates persistence, then calls `create_inference_run_record(...)` (in `utils/inference_runs.py`) in the same transaction:

1. persists the user-side action for `new`, `send`, `edit`, `retry`, or `shared_continue`
2. creates an AI placeholder `MessageTable` row with `streaming_status='queued'`, `streaming_started_at=now()`, and snapshots of the message path and tool preferences in the `streaming_*` columns
3. sets `conversation.active_assistant_message_id` to the new message id

The endpoint returns the latest conversation detail/summary, the run shape (built from the message row), and the placeholder message after the transaction commits. There is no longer a separate `inference_runs` table — the assistant message *is* the run.

### 11.2 Background task execution

`InferenceRunManager` is a process-level singleton. `launch(run_id)` spawns an asyncio `Task` that calls `_run(...)`, which prepares history and then calls `_do_stream(...)`. That path:

- marks the run `running` in Postgres
- calls the `agents` service SSE endpoint
- reads each AG-UI chunk and applies it to an `InferenceRunRuntime` accumulator (in-memory only — no DB writes during streaming)
- builds a lightweight runtime event dict in `_publish_runtime_event(...)` and appends it to the run's **Redis Stream** at `inference:run:{run_id}:events` via `RedisEventLog.append(...)`

### 11.3 Observer subscription

Browsers connect via WebSocket at `/v1/inference/runs/{user_id}/{run_id}/ws`. The handler authenticates the session cookie, accepts the upgrade, waits for the client's first frame (`{"type": "subscribe", "since": "<seq>" | null}`), then drives `stream_run_events(run_id, since=since)`:

1. if the run is already terminal, a single `{"type": "snapshot", "payload": ...}` frame is sent from the Postgres snapshot and the connection closes
2. otherwise, the handler `XREAD BLOCK`s the Redis stream from the supplied cursor (or `0` for full backlog), sending each event as `{"type": "event", "seq": "<stream-id>", "payload": ...}`
3. when a terminal-status event is seen, a `{"type": "terminal"}` frame is sent and the connection closes cleanly
4. on transient disconnect the client reconnects with `since=<last-seen-seq>`; missed events are replayed from Redis up to the TTL window (1 h after terminal)

The legacy SSE endpoint at `GET /v1/inference/runs/{user_id}/{run_id}/stream` is kept for one release cycle so older clients can still observe; it reads from the same Redis stream and emits `text/event-stream` frames without sequence-ID metadata. New code should use the WebSocket route.

Multiple browsers can observe the same run simultaneously — Redis Streams support fan-out natively (each WebSocket handler is an independent `XREAD` consumer).

### 11.4 Cancellation

`POST /v1/inference/runs/{user_id}/{run_id}/cancel` sets an asyncio `Event` that `_do_stream` checks at each await point. The run aborts immediately at the current suspension point, transitions to `cancelling`, then `cancelled`, and the final DB write reflects the cancellation.

### 11.5 HITL pause & resume

When the agent emits `__interrupt__`, the agents-service normalizer turns it into an AG-UI `HITL_INTERRUPT` event — and when the interrupt fires inside a subagent namespace, the **same interrupt is delivered twice**: top-level (namespace in metadata) and wrapped as `SUBAGENT_EVENT(HITL_INTERRUPT)`. The bridge `InferenceRunRuntime` therefore tracks pending interrupts as a set of **identities** (`pending_interrupt_ids`, keyed by `interrupt.id`) — never a bare counter, which would count a subagent pause twice, drift upward across resume legs, and leave the run waiting forever after its real completion. When the upstream `/stream` HTTP body ends, the manager's `_run` task inspects the set:

- **empty** → genuine completion → terminal write + Redis EXPIRE.
- **non-empty** → the run is paused on a checkpoint. `_run` keeps the task alive and races `cancel_event` against a per-run `resume_event`.

`POST /v1/inference/runs/{user_id}/{run_id}/resume` carries the user's decision (`approve` / `reject`, plus optional `reason` / `value`) into `InferenceRunManager.request_resume(run_id, payload)`, which stores the payload and flips the event. `_run` wakes, removes the payload's `interrupt_id` from the pending set (falling back to the oldest entry when absent), and spawns `_do_resume(...)` — a parallel to `_do_stream` that POSTs to the agents service's `/agents/{slug}/resume` endpoint. The agents service rehydrates the cached `InMemorySaver` for the same `thread_id` and feeds `Command(resume=...)` into `graph.astream(...)`. New events flow back through the same Redis stream the original run wrote to, so the WebSocket observers transparently see the resumed activity. A 409 from the agents service (no cached checkpoint — e.g., process restart between interrupt and resume) is translated into a failed terminal status with a user-readable error message.

### 11.6 DB write policy

For the normal success path, DB writes happen at run start and terminal finalization:

- **at creation** (`create_inference_run_record`) — the user action, run row, and AI placeholder are written together
- **at completion** (`_finish_run`) — content, thinking, raw events, plan, subagents, status, and timestamps are written in a single update

There are zero DB writes per stream chunk. Cancellation, launch failure, and stale queued-run cleanup can add small terminal/cleanup writes outside the happy path.

### 11.7 Run lifecycle

```mermaid
stateDiagram-v2
    [*] --> queued : create_inference_run_record
    queued --> running : _run starts
    running --> cancelling : cancel signal received
    cancelling --> cancelled : _finish_run
    running --> completed : _finish_run (success)
    running --> failed : _finish_run (error)
    completed --> [*]
    cancelled --> [*]
    failed --> [*]
```

## 12. Attachments and Blob Delivery

### 12.1 Attachment ingestion

Attachments are sent as base64 payloads in `MessageIn.attachments`.

Current constraints from the schemas:

- max attachment size: `25 MB`
- max total attachment payload per message: `25 MB`
- max attachments per message: `10`

### 12.2 Stored representation

- raw bytes are decoded from base64
- a `BlobTable` row stores the binary content
- an `AttachmentTable` row stores metadata and links to the blob

### 12.3 Download endpoints

| Endpoint | Purpose |
| --- | --- |
| `/v1/attachments/download/{user_id}/{conversation_id}/{message_id}/{blob_id}` | stream non-image blobs with byte-range support |
| `/v1/attachments/images/{user_id}` | paginated base64 image retrieval |

### 12.4 Blob download behavior

- only non-image blobs are served by the download endpoint
- images are intentionally blocked there and served via the image pagination route
- byte ranges are supported with `206 Partial Content`
- `Accept-Ranges` and `Content-Range` are set appropriately

## 13. Preferences Model

The preferences surface is:

- `GET /v1/preferences/{user_id}`
- `PUT /v1/preferences/{user_id}`

Current payload fields:

- `prefersAgenticChat`

Tool control is no longer a global preference. It moved to a per-(user, agent) disabled set on the agents service (Settings → Agents); the old `user_preferences.tools` column was dropped in migration `0016_retire_enabled_tools`.

## 14. Request Models and Limits

### 14.1 Inference payload

```json
{
  "messagePath": ["msg-1", "msg-2"]
}
```

### 14.2 Conversation creation payload

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

### 14.3 Attachment validation rules

Each attachment requires:

- `name`
- `mime`
- valid base64 `dataB64`

Either `content` or at least one attachment must be present for non-placeholder messages.

## 15. API Surface

### 15.1 Auth

| Endpoint | Method |
| --- | --- |
| `/v1/auth/login` | `POST` |
| `/v1/auth/session` | `GET` |
| `/v1/auth/session/refresh` | `POST` |
| `/v1/auth/logout` | `POST` |

### 15.2 Catalog

| Endpoint | Method |
| --- | --- |
| `/v1/catalog/agents` | `GET` |
| `/v1/catalog/tools` | `GET` |

### 15.3 Preferences

| Endpoint | Method |
| --- | --- |
| `/v1/preferences/{user_id}` | `GET` |
| `/v1/preferences/{user_id}` | `PUT` |

### 15.4 Conversations

| Endpoint | Method |
| --- | --- |
| `/v1/conversations/{user_id}` | `POST` |
| `/v1/conversations/{user_id}` | `GET` |
| `/v1/conversations/{user_id}/{conversation_id}` | `GET` |
| `/v1/conversations/{user_id}/{conversation_id}` | `DELETE` |
| `/v1/conversations/{user_id}/{conversation_id}/title` | `PATCH` |

### 15.5 Messages

| Endpoint | Method |
| --- | --- |
| `/v1/messages/{user_id}/{conversation_id}` | `POST` |
| `/v1/messages/{user_id}/{conversation_id}/{message_id}` | `PATCH` |
| `/v1/messages/{user_id}/{conversation_id}/{message_id}/like` | `POST` |
| `/v1/messages/{user_id}/{conversation_id}/{message_id}/dislike` | `POST` |

### 15.6 Inference

| Endpoint | Method | Notes |
| --- | --- | --- |
| `/v1/inference/runs/{user_id}/start` | `POST` | Backend-owned start for new, send, edit, retry, and shared continuation |
| `/v1/inference/runs/{user_id}` | `GET` | List runs (`?status=active` for hydration) |
| `/v1/inference/runs/{user_id}/{run_id}/ws` | `WS` | WebSocket observer with `since=<seq>` resume — replays from Redis Stream |
| `/v1/inference/runs/{user_id}/{run_id}/stream` | `GET` | **Deprecated** legacy SSE observer; kept for one release cycle |
| `/v1/inference/runs/{user_id}/{run_id}/cancel` | `POST` | Signal asyncio cancel |
| `/v1/inference/runs/{user_id}/{run_id}/resume` | `POST` | Approve / reject a HITL `__interrupt__` paused on the agents-service checkpoint and resume the run |

### 15.7 Speech

| Endpoint | Method |
| --- | --- |
| `/v1/speech/dictation/{user_id}` | `POST` |
| `/v1/speech/read-aloud/{user_id}/{conversation_id}/{message_id}` | `POST` |

### 15.8 Voice

| Endpoint | Method |
| --- | --- |
| `/v1/voice/realtime/{user_id}/session` | `POST` |
| `/v1/voice/realtime/{user_id}/conversation-event` | `POST` |
| `/v1/voice/realtime/{user_id}/end` | `POST` |

### 15.9 Shared Conversations

| Endpoint | Method |
| --- | --- |
| `/v1/shared-conversations/{token}` | `GET` |

### 15.10 Search

| Endpoint | Method |
| --- | --- |
| `/v1/search/{user_id}` | `GET` |

### 15.11 Attachments

| Endpoint | Method |
| --- | --- |
| `/v1/attachments/download/{user_id}/{conversation_id}/{message_id}/{blob_id}` | `GET` |
| `/v1/attachments/preview/{user_id}/{conversation_id}/{message_id}/{blob_id}` | `GET` |
| `/v1/attachments/preview-token/{user_id}/{conversation_id}/{message_id}/{blob_id}` | `GET` |
| `/v1/attachments/public/{token}` | `GET` |
| `/v1/attachments/images/{user_id}` | `GET` |

## 16. Observability, Security, and Edge Behavior

### 16.1 Observability

The service has a queue-based structured logging stack similar to `agents`.

It logs:

- request lifecycle
- DB operations
- auth outcomes
- agent sync and tool fetch outcomes
- inference stream metrics
- blob download metrics

### 16.2 Stream metrics

Inference and blob streaming are instrumented with:

- chunk count
- forwarded bytes
- first-byte latency
- total stream duration
- SSE event counts where applicable

### 16.3 Proxy awareness

Client IP resolution trusts forwarded headers only when the request comes from:

- a trusted proxy secret header, or
- a trusted proxy CIDR

### 16.4 Rate limiting

Authentication is rate-limited per resolved client IP using SlowAPI. Inference starts are rate-limited per user id.

### 16.5 CORS

CORS settings are configurable through env vars, with defaults aimed at local Agentic UI development.

## 17. Configuration

Configuration is loaded from `core/settings.py` (pydantic-settings; secrets use `SecretStr`).

### 17.1 Required variables

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | async SQLAlchemy database URL |
| `SESSION_TOKEN_SECRET` | HMAC secret for session token hashing and log redaction fallback |

`VAULT_URL` is effectively required if you want login to work. Without it, the auth router loads but login returns a configuration error.

### 17.2 Upstream and auth variables

| Variable | Default |
| --- | --- |
| `AGENTS_SERVICE_URL` | `http://agents:8003` |
| `VAULT_USERPASS_MOUNT` | `userpass` |
| `VAULT_OIDC_ROLE` | `agenticx` |
| `VAULT_OIDC_PATH` | `identity/oidc/token` |
| `VAULT_HTTP_TIMEOUT` | `10.0` |

Note: `VAULT_OIDC_ROLE` and `VAULT_OIDC_PATH` exist in settings, but the current implementation does not use them during login.

### 17.3 Session variables

| Variable | Default |
| --- | --- |
| `SESSION_COOKIE_SECURE` | `true` |
| `SESSION_COOKIE_SAMESITE` | `lax` |
| `SESSION_ACCESS_TTL_SECONDS` | `900` |
| `SESSION_REFRESH_TTL_SECONDS` | `604800` |
| `SESSION_MAX_PER_USER` | `3` |

### 17.4 Rate limit and proxy variables

| Variable | Default |
| --- | --- |
| `AUTH_RATE_LIMIT_MAX_ATTEMPTS` | `15` |
| `AUTH_RATE_LIMIT_WINDOW_SECONDS` | `60` |
| `INFERENCE_RATE_LIMIT_MAX_ATTEMPTS` | `10` |
| `INFERENCE_RATE_LIMIT_WINDOW_SECONDS` | `60` |
| `INFERENCE_MAX_ACTIVE_RUNS_PER_USER` | `5` |
| `TRUSTED_PROXY_HEADER_NAME` | `X-Internal-Proxy-Secret` |
| `TRUSTED_PROXY_SECRET` | required (service refuses to start if unset) |

### 17.5 Redis (inference event log + skills cache) variables

| Variable | Default |
| --- | --- |
| `REDIS_URL` | `redis://redis:6379/0` |
| `REDIS_PASSWORD_FILE` | unset locally; `/run/secrets/redis_password` in prod |
| `REDIS_PASSWORD` | unset (used only when `REDIS_PASSWORD_FILE` is not provided) |
| `REDIS_STREAM_MAXLEN` | `5000` (approximate cap on per-run event stream) |
| `REDIS_STREAM_TERMINAL_TTL_SECONDS` | `3600` (replay window after a run ends) |
| `REDIS_STREAM_READ_BLOCK_MS` | `30000` (`XREAD BLOCK` timeout) |
| `REDIS_SKILLS_GLOBAL_TTL_SECONDS` | `86400` (global skills catalog cache, 24 h) |
| `REDIS_SKILLS_USER_REGISTRY_TTL_SECONDS` | `7200` (per-user skill pool cache, 2 h) |
| `REDIS_SKILLS_USER_AGENT_TTL_SECONDS` | `7200` (per-(user, agent) assignment cache, 2 h) |

### 17.6 CORS variables

Defaults allow local origins around ports `8080` and `8050`. See `core/settings.py` for the authoritative list and override behavior.

## 18. Directory Map

```text
src/dialogue_bridge/
├── main.py                        FastAPI app bootstrap and router wiring
├── core/
│   ├── settings.py                Environment-driven settings (pydantic-settings)
│   ├── database.py                ORM models and session factory
│   ├── auth_client.py             Vault userpass client
│   ├── auth_session.py            Session, cookie, CSRF, and auth dependencies
│   ├── proxy.py                   Trusted proxy IP resolution
│   └── rate_limit.py              SlowAPI setup
├── router/
│   ├── auth.py                    Login/session/logout
│   ├── catalog.py                 Agents and tools catalog
│   ├── preferences.py             User preferences
│   ├── conversations.py           Conversation CRUD
│   ├── messages.py                Message create/update/reactions
│   ├── inference.py               Backend-owned inference start, observe, cancel, list endpoints
│   ├── voice.py                   Realtime voice session persistence/proxy endpoints
│   ├── shared_conv.py             Public shared conversation snapshot endpoint
│   ├── search.py                  Workspace conversation search
│   ├── speech.py                  Speech and dictation endpoints
│   └── attachments.py             Blob streaming and image pagination
├── schemas/                       Pydantic request/response models
├── utils/
│   ├── agents.py                  Agent sync and upstream catalog helpers
│   ├── conversations.py           Conversation/message/blob persistence helpers
│   ├── inference.py               Branch resolution and agent payload serialization
│   ├── inference_start.py         Backend-owned inference start orchestration
│   ├── inference_runs.py          Detached run lifecycle — InferenceRunManager, InferenceRunRuntime, create/stream/cleanup
│   ├── event_log.py               Redis-Streams-backed per-run AG-UI event log (RedisEventLog: append / read_since / mark_terminal)
│   ├── shared_conv.py             Shared conversation clone/snapshot helpers
│   ├── search.py                  Workspace search helper
│   ├── speech.py                  Speech proxy helpers
│   ├── voice.py                   Realtime voice helper logic
│   ├── titles.py                  Upstream title generation helper and random candidate selector
│   ├── validators.py              Ownership validators
│   └── suggestions.py             Starter suggestion helper
├── observability/                 Logging, metrics, middleware, redaction
├── requirements.txt
└── Dockerfile
```

## 19. Local Development

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

## 20. Docker and Compose

### Dockerfile

The image:

- uses `python:3.12-slim`
- installs `build-essential`
- installs dependencies from `requirements.txt`
- copies the app into `/app`
- starts Uvicorn on port `8002`

### Compose wiring

From `src/docker-compose.yaml`:

- `dialogue_bridge` depends on:
  - `agents`
  - `chat_postgres`
  - `redis`
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
- `REDIS_URL=redis://redis:6379/0`
- `REDIS_PASSWORD_FILE=/run/secrets/redis_password` (prod) or `REDIS_PASSWORD=${REDIS_PASSWORD}` (local dev)

## 21. Known Behavioral Notes

- Database schema migrations run automatically on startup via `alembic upgrade head` in the FastAPI lifespan handler (see §7.3). The legacy `Base.metadata.create_all` path was removed when alembic became the source of truth.
- Agent manifests are synchronized on demand, not during startup.
- `get_agent_by_id` currently reads only from the in-memory cache, so a cache miss depends on a prior catalog sync path having primed it.
- Login works with Vault userpass only in the current code.
- The bridge stores raw binary blobs in Postgres, not in external object storage.
- Image attachments are returned as base64 in the image pagination endpoint.
- Inference runs survive browser disconnects. The asyncio background task continues regardless of whether any WebSocket observer is connected. A reconnecting observer resends `{"type":"subscribe","since":<lastSeq>}`; the handler replays missed events from the per-run Redis stream and then continues live-tailing. If the run already terminated, the handler emits a single Postgres-backed snapshot frame and closes.
- On startup, `cleanup_orphaned_inference_runs()` marks any rows still in `queued`, `running`, or `cancelling` status as `failed`. This covers runs that were interrupted by a process restart and prevents stale active-run locks from blocking new inference on those conversations.

## 22. Quick File References

- `main.py`: app setup and route prefixes
- `core/auth_session.py`: sessions, cookies, CSRF, and auth dependencies
- `core/auth_client.py`: Vault authentication
- `core/database.py`: ORM schema
- `router/inference.py`: backend-owned inference start, WebSocket observation (`inference_run_websocket`), deprecated SSE fallback, cancellation, and active-run listing
- `router/speech.py`: speech and dictation endpoints
- `utils/inference.py`: branch resolution and multimodal serialization
- `utils/inference_runs.py`: detached run lifecycle — InferenceRunManager, InferenceRunRuntime, create/observe/cleanup
- `utils/agents.py`: agent cache and tools proxy helpers
