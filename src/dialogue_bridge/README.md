# Dialogue Bridge Service

## Overview

The dialogue bridge is the FastAPI backend that fronts the LangGraph agents for the Agentic UI. It authenticates users against HashiCorp Vault, persists conversations and binary attachments in Postgres, caches the agent roster, and proxies AG-UI server-sent events from the agents service back to the browser.

## Service Role

Within the broader platform this service operates as the orchestrator: it is the single backend consumed by the UI and the entry point for all conversation lifecycle operations. Every request is vetted, enriched, and routed to the correct downstream service from here.

## Directory Highlights

This folder contains the FastAPI application, SQLAlchemy models, Vault authentication helpers, and Docker artefacts needed to run the bridge independently or under Docker Compose. All persistence and auth glue for the project lives in this codebase.

## Responsibilities

- Authenticate users via Vault userpass, exchange the Vault client token for an OIDC JWT, and manage HTTP-only session and refresh cookies.
- Upsert Vault-authenticated users, sync active agents, and expose a roster that stays aligned with the agents service.
- Provide REST APIs for conversation CRUD, message creation (with attachments), reactions, and attachment downloads.
- Stream inference responses by rebuilding chat history (including image attachments) and piping LangGraph SSE frames through to the UI.
- Enforce per-user access control by validating JWT claims against stored users before every conversation or attachment operation.

## Authentication and Session Flow

`POST /authenticate` accepts username/password credentials, logs into Vault (`vault_auth/client.py`), exchanges the resulting Vault client token for an OIDC JWT, persists the user via `upsert_user_from_vault`, and sets `SESSION_COOKIE_NAME` and `SESSION_REFRESH_COOKIE_NAME` cookies with the configured TTL (`SESSION_COOKIE_DEFAULT_TTL`).  
`POST /session/refresh` consumes the refresh cookie, renews the Vault client token when possible, issues a fresh JWT, and rotates cookies.  
`POST /logout` clears both cookies.  
All protected endpoints depend on `require_token_claims` (see `vault_auth/auth.py`), which loads the Vault JWKS, validates the presented JWT, and ensures the Vault entity id or stored user id matches the requested resource.

## API Surface

- `GET /agents` returns active agents from the local cache/database (`AgentPublic` models).
- `POST /users/{user_id}/conversations` creates a conversation and its first message (text plus optional attachments encoded as base64).
- `GET /users/{user_id}/conversations` provides paginated summaries (`fastapi-pagination`) with preview text, updated timestamps, and message counts.
- `GET /users/{user_id}/conversations/{conversation_id}` hydrates the full conversation including message history and attachment metadata.
- `POST /users/{user_id}/conversations/{conversation_id}/messages` appends a message, persists attachments, updates the conversation summary, and returns the stored message plus refreshed summary.
- `POST /users/{user_id}/conversations/{conversation_id}/messages/{message_id}/like` and `/dislike` toggle the reaction flag.
- `DELETE /users/{user_id}/conversations/{conversation_id}` cascades deletes to messages, attachments, and blobs.
- `GET /users/{user_id}/conversations/{conversation_id}/messages/{message_id}/blobs/{blob_id}` streams file attachments with byte-range support for resumable downloads.
- `GET /users/{user_id}/images` returns a paginated list of image attachments (base64 data) for gallery-style rendering.
- `POST /users/{user_id}/conversations/{conversation_id}/inference/stream` proxies chat history to the selected agent endpoint and relays AG-UI SSE frames to the UI.

Refer to `main.py` for the complete path list, status codes, and response models declared in `database/schemas.py`.

## Attachments and Media

Uploads arrive as base64 strings (`AttachmentIn` payloads). The bridge decodes them, writes the raw bytes into `BlobTable`, and associates metadata (filename, mime type, size) via `AttachmentTable`.  
Image attachments are inlined as data URLs when chat history is fed to agents (`serialise_message_with_images_for_agent`) and when fetched through the `/images` endpoint. Non-image files are downloaded through the blob streaming endpoint, which honours `Range` headers and avoids buffering entire files in memory.

## Data Model

`database/__init__.py` defines the async SQLAlchemy ORM:

- `UserTable` stores Vault entity ids, profile metadata, and preferences.
- `AgentTable` caches metadata for LangGraph agents (synced from the agents service on startup).
- `ConversationTable` tracks per-user conversations, agent selections, privacy flags, and the last message preview.
- `MessageTable` stores user/assistant turns, including reasoning telemetry (`thinking`, `reasoning_time_seconds`) and error markers.
- `AttachmentTable` and `BlobTable` persist file metadata and binary payloads with cascading deletes.
Schema creation and agent synchronisation run inside the FastAPI lifespan hook at startup.

## Configuration

Key environment variables:

- `DATABASE_URL` (required) - async SQLAlchemy URL, e.g. `postgresql+asyncpg://admin:admin@chat_postgres:5432/chat_db`.
- `VAULT_ADDR` - base URL for the Vault server (configured via Docker Compose and kept on the internal network).
- `VAULT_USERPASS_MOUNT`, `VAULT_OIDC_ROLE`, `VAULT_OIDC_PATH`, `VAULT_NAMESPACE`, `VAULT_HTTP_TIMEOUT` - tune Vault access.
- `SESSION_COOKIE_NAME`, `SESSION_REFRESH_COOKIE_NAME`, `SESSION_COOKIE_DOMAIN`, `SESSION_COOKIE_SECURE`, `SESSION_COOKIE_SAMESITE`, `SESSION_COOKIE_DEFAULT_TTL` - cookie behaviour for session and refresh tokens.

## Local Development

```shell
cd src/dialogue_bridge
python -m venv .venv
.\.venv\Scripts\activate    # use source .venv/bin/activate on POSIX
pip install -r requirements.txt

set DATABASE_URL=postgresql+asyncpg://admin:admin@localhost:5432/chat_db
set VAULT_ADDR=http://<vault-host>:<vault-port>
set VAULT_USERPASS_MOUNT=userpass
set VAULT_OIDC_ROLE=agenticx
uvicorn main:app --host 0.0.0.0 --port 8002 --reload
```

Ensure Postgres is running (see `README_POSTGRES.md`) and Vault is initialised/unsealed before exercising the auth endpoints.

## Docker Notes

The Dockerfile builds on `python:3.10-slim`, installs the pinned dependencies from `requirements.txt`, copies the service code, and starts Uvicorn. The compose service exposes port 8002, mounts the backend/frontend networks, and injects the environment variables shown above.

## Related Documents

- `README_POSTGRES.md` documents the Postgres sidecar used by this service.
- The repository `README.md` covers the full stack and Vault bootstrap script.
