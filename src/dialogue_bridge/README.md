# Dialogue Bridge Service

## Overview

The dialogue bridge is a FastAPI back end that sits between the Agentic UI and the LangGraph agents. It owns conversation state, persists messages and attachments to Postgres, exposes REST endpoints for the frontend, and proxies inference streams from the agents container while preserving AG-UI event frames.

## Responsibilities

- Authenticate users and return agent rosters exposed by the agents service.
- Persist conversations, messages, and binary attachments using SQLAlchemy models mapped to Postgres tables.
- Provide pagination and filtering APIs for listing conversation history.
- Proxy inference streams by rebuilding chat history, calling the agent endpoint, and forwarding SSE bytes to the UI.
- Seed default users and agents on startup so the UI has something to interact with immediately.

## Key Technologies

- FastAPI with lifespan hooks for schema creation and seeding.
- SQLAlchemy (async engine + ORM) backed by `asyncpg` to connect to Postgres.
- `fastapi-pagination` for efficient list responses.
- `httpx` async client for streaming agent responses from the agents service.
- Pydantic v2 models (`schemas.py`) to validate requests and shape responses.

## API Highlights

- `POST /authenticate` validates username/password combinations (hashed with SHA-256).
- `GET /agents` lists active agents stored in the database.
- `POST /users/{user_id}/conversations` creates a conversation plus the first message (with optional attachments).
- `GET /users/{user_id}/conversations` and pagination helpers return conversation summaries.
- `POST /users/{user_id}/conversations/{conversation_id}/inference/stream` proxies an SSE stream from the agent endpoint to the UI.
- `DELETE /users/{user_id}/conversations/{conversation_id}` removes a conversation and cascades to messages and attachments.
- `GET /images/{blob_id}` and related endpoints expose stored binary content when needed by the UI.

Refer to `main.py` for the complete list and response schemas.

## Data Model

`database.py` defines SQLAlchemy ORM tables for users, agents, conversations, messages, attachments, and binary blobs. Relationships cascade deletes and enforce per-user isolation. Seed helpers insert a default user (from env vars) and register agent metadata that points at the agents service URLs.

## Configuration

- `DATABASE_URL` (required): async SQLAlchemy URL for Postgres, e.g. `postgresql+asyncpg://admin:admin@chat_postgres:5432/chat_db`.
- `username` and `password`: credentials for the default seeded user; consumed by `seed_users`.
- Service binds to port `8002` and connects to the `backend` and `frontend` compose networks.

## Local Development

```shell
cd src/dialogue_bridge
python -m venv .venv && .\.venv\Scripts\activate
pip install fastapi fastapi_pagination httpx uvicorn sqlalchemy[asyncio] asyncpg aiosqlite pydantic langchain langchain-openai
set DATABASE_URL=postgresql+asyncpg://admin:admin@localhost:5432/chat_db
set username=admin
set password=your-password
uvicorn main:app --host 0.0.0.0 --port 8002 --reload
```

Start a matching Postgres instance (see the `chat_postgres` service) before launching the API. Replace `set` with `export` if you are on a POSIX shell.

## Docker Notes

The Dockerfile installs FastAPI and persistence dependencies atop `python:3.10-slim`, copies the source tree, and launches Uvicorn. Compose builds the `dialogue_bridge` image from this folder and injects the necessary env vars plus a dependency on the `chat_postgres` service.

## Service Interactions

- Upstream: depends on `chat_postgres` for durable storage.
- Lateral: calls the `agents` service (`http://agents:8003/...`) to obtain streaming completions.
- Downstream: serves as the single backend consumed by `agentic_ui`.
