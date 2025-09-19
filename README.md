# mAgenticX

mAgenticX is a modular, containerized multi-agent chat platform. A React UI connects to a FastAPI dialogue bridge that persists conversations in Postgres and proxies streaming responses from a LangGraph-based agents service. Retrieval and lightweight analytics are handled by a separate RAG service backed by a Chroma vector database.

## Highlights

- Multi-agent chat with tool use and AG-UI streaming of thoughts and messages
- RAG via Chroma (persistent vector store) + OpenAI embeddings
- Attachments (images/files) stored alongside messages
- Clean service boundaries and Docker Compose orchestration

## Architecture

- `src/agentic_ui` — Vite + React frontend for the chat experience. Renders reasoning, tools, and attachments; consumes the dialogue bridge REST + SSE endpoints.
  - See: `src/agentic_ui/README.md`
- `src/dialogue_bridge` — FastAPI backend that authenticates users, persists conversations/messages/attachments to Postgres, lists agents, and proxies inference streams to the UI.
  - See: `src/dialogue_bridge/README.md`
  - Postgres service notes: `src/dialogue_bridge/POSTGRES_README.md`
- `src/agents` — FastAPI service hosting LangGraph agents (OrthodoxAI v1, HR Policies v1, Retail v1). Streams AG-UI compatible events.
  - See: `src/agents/README.md`
- `src/rag_service` — FastAPI microservice for retrieval (Chroma) and Excel SQL analytics (DuckDB).
  - See: `src/rag_service/README.md`
  - Chroma service notes: `src/rag_service/CHROMA_README.md`
- `vectordb` — Chroma server (REST) with a persistent volume for embeddings (internal network only).
- `chat_postgres` — Postgres database for durable storage of conversations and attachments.

## Quickstart (Docker Compose)

Prerequisites
- Docker + Docker Compose
- `OPENAI_API_KEY` exported in your environment (used by `agents` and `rag_service`)

Bring the stack up from the repo root:

```
docker compose -f src/docker-compose.yaml up --build
```

Service endpoints (defaults from compose):
- UI: http://localhost:8050 (`agentic_ui`)
- Dialogue Bridge: http://localhost:8002 (`dialogue_bridge`)
- Agents: http://localhost:8003 (`agents`)
- RAG Service: http://localhost:8001 (`rag_service`)
- Postgres: localhost:5432 (`chat_postgres`, exposed)
- Chroma (vectordb): internal on 8000 (no host port)

Tear down:

```
docker compose -f src/docker-compose.yaml down
```

## Local Development

Each service can run standalone for development; see the linked READMEs for full instructions.

- UI (React)
  - `cd src/agentic_ui && npm install && npm run dev`
  - Configure `BFF_HOST`/`BFF_PORT` (or Vite env) to point at your bridge instance
- Dialogue Bridge (FastAPI)
  - Requires Postgres; set `DATABASE_URL`, `username`, `password`
  - `uvicorn main:app --host 0.0.0.0 --port 8002 --reload`
- Agents (FastAPI + LangGraph)
  - Requires `OPENAI_API_KEY` and access to `rag_service`
  - `uvicorn main:app --host 0.0.0.0 --port 8003 --reload`
- RAG Service (FastAPI)
  - Requires Chroma (vectordb) and Excel files in `src/rag_service/data/`
  - `uvicorn main:app --host 0.0.0.0 --port 8001 --reload`

## Configuration

- `OPENAI_API_KEY` — used by `agents` and `rag_service` (embeddings)
- `DATABASE_URL` — async SQLAlchemy URL for dialogue bridge, e.g. `postgresql+asyncpg://admin:admin@chat_postgres:5432/chat_db`
- `BFF_HOST`, `BFF_PORT` — UI build-time settings that locate the dialogue bridge (compose defaults: `dialogue_bridge:8002`)

## Data & Persistence

- Vector store volume `vectorstore` bound to `./src/vectorstores/chroma_db_openai`
- Postgres data volume `chat_convs` for durable chat storage
- Dialogue bridge seeds a default user and agent roster on startup

## Directory Map

- `docs/` — design notes and workflow diagrams
- `notebooks/` — experiments and prototypes
- `src/agentic_ui/` — frontend application
- `src/dialogue_bridge/` — backend API + persistence
- `src/agents/` — agents service (LangGraph + tools)
- `src/rag_service/` — retrieval + Excel SQL service
- `src/vectorstores/` — Chroma persistence folder
- `src/docker-compose.yaml` — Compose stack definition

## Service Interactions

- `agentic_ui` → `dialogue_bridge` (REST + SSE)
- `dialogue_bridge` → `agents` (SSE proxy)
- `agents` → `rag_service` (HTTP) and OpenAI APIs
- `rag_service` → `vectordb` (Chroma REST)
- `dialogue_bridge` ↔ `chat_postgres` (async SQLAlchemy)

For API details and dev commands, consult the per-service READMEs linked above.

