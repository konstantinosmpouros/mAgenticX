# Dialogue Bridge Service

FastAPI backend that fronts the agents service for the Agentic UI. It authenticates through Vault, persists conversations and attachments in Postgres, caches agent manifests, proxies inference streams, surfaces MCP tools, and forwards dictation uploads.

## What it does

- Authenticates users against Vault userpass, exchanges the client token for an OIDC JWT, and manages session/refresh cookies.
- Syncs agent manifests from the agents service, caches them for validation, and exposes the roster to the UI.
- Persists conversations, messages, reactions, and file blobs; rebuilds chat history (including inline images) before proxying inference streams.
- Proxies MCP tool discovery (`/tools`) and speech-to-text uploads (`/users/{id}/dictation/transcribe`) to the agents service.
- Stores per-user tool preferences (`/users/{id}/preferences`) so the UI can disable MCP tools; exposes paginated images and attachments for download.
- Streams inference as SSE by forwarding AG-UI frames from the agents service and layering `thread_id`/context metadata derived from the conversation + message branch (`messagePath`).

## API highlights

- `POST /authenticate`, `/session/refresh`, `/logout` – Vault auth + cookie lifecycle.
- `GET /agents` – cached roster; refreshes from the agents service when empty.
- `GET /tools` – MCP tool catalog fetched via the agents service.
- `POST /users/{id}/dictation/transcribe` – proxies audio files to agents STT.
- `GET/PUT /users/{id}/preferences` – persist tool disablement and agentic chat preference.
- Conversation surface: create/list/get/delete conversations; create/like/dislike messages; stream inference at `/users/{id}/conversations/{conv_id}/inference/stream`.
- Attachments: upload alongside messages, fetch paginated `/users/{id}/images`, download blobs with byte ranges at `/users/{id}/conversations/{conv_id}/messages/{msg_id}/blobs/{blob_id}`.
- Routers live under `apis/` folder (auth, utils, conversations, messages, attachments, inference); shared validation lives in `utils/`.

Response models live in `database/schemas.py`; routers are under `apis/`.

## Data model

- `UserTable` + `UserPreferencesTable` hold Vault entity ids and preferences (disabled MCP tools, `prefers_agentic_chat`).
- `AgentTable` caches manifests from the agents service and is kept in sync on startup and on-demand.
- `ConversationTable`, `MessageTable`, `AttachmentTable`, `BlobTable` store chat state, including reasoning telemetry and binary payloads with cascading deletes.
Schema creation runs in the lifespan hook on startup.

## Configuration

- `DATABASE_URL` – async SQLAlchemy URL.
- `AGENTS_SERVICE_URL` – base URL for the agents service (default `http://agents:8003`).
- Vault: `VAULT_URL`, `VAULT_USERPASS_MOUNT`, `VAULT_OIDC_ROLE`, `VAULT_OIDC_PATH`, `VAULT_NAMESPACE`, `VAULT_HTTP_TIMEOUT`, `VAULT_OIDC_DISCOVERY_URL`, `VAULT_JWT_AUDIENCE`.
- Cookies: `SESSION_COOKIE_NAME`, `SESSION_REFRESH_COOKIE_NAME`, `SESSION_COOKIE_DOMAIN`, `SESSION_COOKIE_SECURE`, `SESSION_COOKIE_SAMESITE`, `SESSION_COOKIE_DEFAULT_TTL`.

## Local development

```shell
cd src/dialogue_bridge
python -m venv .venv
source .venv/bin/activate   # use .venv\\Scripts\\activate on Windows
pip install -r requirements.txt

export DATABASE_URL=postgresql+asyncpg://admin:admin@localhost:5432/chat_db
export AGENTS_SERVICE_URL=http://localhost:8003
export VAULT_URL=http://<vault-host>:<vault-port>
export VAULT_USERPASS_MOUNT=userpass
export VAULT_OIDC_ROLE=agenticx
uvicorn main:app --host 0.0.0.0 --port 8002 --reload
```

Start Postgres and initialise/unseal Vault before exercising auth or inference.

## Docker notes

The Dockerfile targets `python:3.10-slim`, installs dependencies, and launches Uvicorn. Compose binds port 8002, depends on agents/Postgres, and shares backend/frontend networks with the UI.
