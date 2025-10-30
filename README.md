<div align="center">
  <img src="src/agentic_ui/public/logo2.png" alt="mAgenticX logo" width="120" />
  <div style="font-size: 2.5rem; font-weight: 700; margin-bottom: 0.75rem; font-family: 'Segoe UI', 'Montserrat', sans-serif;">mAgenticX</div>
  <p style="max-width: 520px;">
    A modular, explainable multi-agent chat platform with first-class retrieval, attachment handling, and orchestration.
  </p>
</div>

## Overview
mAgenticX combines a React front end with FastAPI backends, LangGraph agents, and dedicated retrieval services. Conversations, attachments, and telemetry are streamed via the AG-UI protocol and stored durably in Postgres.

## Purpose
The platform helps teams explore multi-agent scenarios where specialised assistants collaborate. It focuses on transparency—surfacing thoughts, tool calls, and context—while keeping the development experience modular and testable.

## High-Level Structure
The repository is organised as a suite of services that can run together through Docker Compose or individually for local development. Each component owns a clear responsibility and communicates over HTTP interfaces.

| Layer | What it does | Key Technologies |
| --- | --- | --- |
| Experience | `agentic_ui` renders the chat experience, handles auth/session lifecycle, and visualises AG-UI events. | React 18, Vite, Tailwind, Radix |
| Orchestration | `dialogue_bridge` authenticates via HashiCorp Vault, persists conversations, and proxies LangGraph streams. | FastAPI, SQLAlchemy, asyncpg |
| Intelligence | `agents` hosts persona-specific LangGraph workflows for OrthodoxAI, HR Policies, and Retail assistants. | LangGraph, LangChain, OpenAI |
| Retrieval & Analytics | `rag_service` provides document retrieval and Excel/DuckDB analytics. `vectordb` stores persistent embeddings. | FastAPI, DuckDB, Chroma |
| Storage & Security | `chat_postgres` and the Vault service give durable storage plus token issuance for the stack. | PostgreSQL, HashiCorp Vault |

## Service Snapshot

| Service | Role in the system | Default Endpoint (Compose) |
| --- | --- | --- |
| `agentic_ui` | UI served by Nginx; proxies `/api` to the bridge. | http://localhost:8050 |
| `dialogue_bridge` | Authenticates users, persists chat state, proxies agent SSE streams. | http://localhost:8002 |
| `agents` | Streams AG-UI events from LangGraph personas. | http://localhost:8003 |
| `rag_service` | Document retrieval and spreadsheet analytics. | http://localhost:8001 |
| `vectordb` | Internal Chroma server storing embeddings. | internal:8000 |
| `chat_postgres` | Conversation and attachment persistence. | localhost:5432 |
| `vault` | HashiCorp Vault for login + JWT issuance (internal network). | internal service |

## Request Flow
1. The UI authenticates through the bridge, which exchanges credentials with Vault and sets session cookies.
2. Authenticated calls retrieve agent rosters, conversations, and attachments after JWT validation against Vault JWKS.
3. Inference requests forward chat history (including inline images) to the selected LangGraph endpoint and stream AG-UI frames back to the browser.
4. Agents call `rag_service` for document grounding or spreadsheet analytics; the RAG service queries Chroma (`vectordb`) or DuckDB tables hydrated from Excel workbooks.
5. New messages, attachments, and reactions are persisted to `chat_postgres`, keeping summaries and caches in sync.

## Quickstart (Docker Compose)

| Requirement | Notes |
| --- | --- |
| Docker / Docker Compose | Tested with Docker 24+. |
| API keys | `OPENAI_API_KEY` must allow the models referenced in `src/agents/llms.py`. |

```shell
# from the repo root
docker compose -f src/docker-compose.yaml up --build
```

Named volumes and bind mounts:

| Volume | Purpose |
| --- | --- |
| `./src/vectorstores/chroma_db_openai` | Persistent Chroma collections. |
| `chat_convs` | Postgres data directory. |
| `./src/vault/config`, `./src/vault/data` | Vault configuration and Raft storage. |

Shut everything down with:

```shell
docker compose -f src/docker-compose.yaml down
```

After the Vault container boots for the first time, run `src/vault/vault_init.sh` to initialise, unseal, create a userpass login, and provision the OIDC role consumed by the bridge.

## Local Development
Run services independently when iterating. Each README in the corresponding directory goes into detail; highlights are below.

| Service | Local bootstrap |
| --- | --- |
| `agentic_ui` | `npm install && npm run dev` (Vite on port 8080). Configure a `/api` proxy to reach the bridge during development. |
| `dialogue_bridge` | Python 3.11+. `pip install -r requirements.txt`, set `DATABASE_URL` plus Vault env vars (e.g. `VAULT_ADDR`, `VAULT_USERPASS_MOUNT`, `VAULT_OIDC_ROLE`), then `uvicorn main:app --host 0.0.0.0 --port 8002 --reload`. |
| `agents` | Python 3.11+. Install dependencies, export `OPENAI_API_KEY`, `RAG_HOST`, `RAG_PORT`, then `uvicorn main:app --host 0.0.0.0 --port 8003 --reload`. |
| `rag_service` | Python 3.11+. Install requirements, ensure `src/rag_service/data/` has Excel files, export `OPENAI_API_KEY`, `RAG_HOST`, `RAG_PORT`, then `uvicorn main:app --host 0.0.0.0 --port 8001 --reload`. |
| `vectordb` | `docker run chromadb/chroma:0.6.3` with the volume bound to `./src/vectorstores/chroma_db_openai`, or reuse the compose container. |
| `chat_postgres` | Use the compose `postgres:16.3` service (`admin/admin`, database `chat_db`) for convenience. |

## Repository Layout

| Path | Description |
| --- | --- |
| `src/agentic_ui/` | React front end, Vite config, and Nginx deployment assets. |
| `src/dialogue_bridge/` | FastAPI bridge, SQLAlchemy models, Vault auth helpers. |
| `src/agents/` | LangGraph agent templates, FastAPI entrypoint, shared tools. |
| `src/rag_service/` | Retrieval + analytics microservice and data directory. |
| `src/vectorstores/` | Chroma persistence folder referenced by compose. |
| `src/vault/` | Vault config, data storage, and bootstrap script. |
| `notebooks/` | Exploratory notebooks and utilities that informed production code. |
| `docs/` | Design notes and diagrams (when present). |
| `src/docker-compose.yaml` | Compose orchestration for the full stack. |

## Tooling & Workflow Tips
- Run `npm run lint` in `src/agentic_ui` to keep the frontend tidy.
- Python services benefit from Uvicorn’s auto-reload for rapid iteration.
- Use `docker compose logs -f <service>` to tail container output while exercising the stack.

Refer to the per-service READMEs for in-depth configuration, API details, and development workflows.
