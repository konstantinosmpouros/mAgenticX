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
| Tool Catalog | `mcp_gateway` publishes a curated MCP tool catalog over SSE for the agents service. | Docker MCP Gateway |
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
| `mcp_gateway` | MCP catalog over SSE consumed by the agents service. | internal:8005 |

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
| `src/mcp_gateway/` | MCP gateway catalog, secrets, and server config for tool discovery. |
| `src/vectorstores/` | Chroma persistence folder referenced by compose. |
| `src/vault/` | Vault config, data storage, and bootstrap script. |
| `notebooks/` | Exploratory notebooks and utilities that informed production code. |
| `docs/` | Design notes and diagrams (when present). |
| `src/docker-compose.yaml` | Compose orchestration for the full stack. |

## Visual Walkthroughs

### Network & Service Topology

The first diagram shows how browser traffic hits the host at `localhost:8050`, passes through the agentic_ui Nginx container, and is proxied to the dialogue_bridge. From there SSE streams reach the agents, tool catalog is fetched from the mcp_gateway, retrieval calls go to rag_service, vectors live in Chroma, and chat state persists to Postgres with Vault handling JWTs. The second diagram groups the same services by frontend, backend, and infrastructure layers so you can see the split between UI, BFF + agents + MCP/RAG, and the auth/storage tier.

![Network flow and container ports](docs/Screenshot%202025-10-31%20014810.png)
![Frontend/Backend/Infra topology](docs/Screenshot%202025-10-31%20014854.png)

### Chat & Data Flows

This sequence captures a full chat turn: the UI posts the user message and attachments to the bridge, which stores them in Postgres, then streams inference via the agents. Agents pull tool manifests from the MCP gateway, optionally execute MCP tools or issue retrieval/analytics requests to rag_service and Chroma, and stream AG-UI frames back. The UI finally saves the AI reply through the bridge into Postgres.

![Chat request lifecycle and RAG interactions](docs/Screenshot%202025-10-31%20014930.png)

### Authentication Flow

Here you can see credentials flowing from the UI to the bridge, then to Vault for userpass login and OIDC token exchange. The bridge receives JWT + client token, upserts the user locally, sets session/refresh cookies, and confirms the signed-in state.

![Vault login, OIDC exchange, and session cookies](docs/Screenshot%202025-10-31%20014954.png)

### Architecture & Platform Overview

The component tree shows the core data plane: agentic_ui consuming REST/SSE from the bridge; the bridge authenticating via Vault, persisting conversations to Postgres, proxying SSE to agents; agents hitting MCP for tool catalogs and RAG for retrieval; RAG talking to Chroma and OpenAI for vectors/embeddings. The platform overview widens the lens to include users/admins, the platform services, and managed stores (Postgres, Vault, Chroma, OpenAI) with the extra admin path into the UI for configuration.

![Component architecture tree](docs/Screenshot%202025-10-31%20015018.png)
![End-to-end platform view (users, platform, stores/services)](docs/Screenshot%202025-10-31%20015842.png)

## Tooling & Workflow Tips

- Run `npm run lint` in `src/agentic_ui` to keep the frontend tidy.
- Python services benefit from Uvicorn’s auto-reload for rapid iteration.
- Use `docker compose logs -f <service>` to tail container output while exercising the stack.

Refer to the per-service READMEs for in-depth configuration, API details, and development workflows.
