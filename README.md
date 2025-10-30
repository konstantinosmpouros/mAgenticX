# mAgenticX

## Overview
mAgenticX is a modular multi-agent chat stack that pairs a React front end with FastAPI services, LangGraph agents, retrieval tooling, and Vault-backed authentication. The system is dockerised, streams AG-UI events end-to-end, and keeps conversations plus binary attachments in Postgres.

## Purpose
The platform is designed to help teams explore complex conversational use cases where multiple specialised agents collaborate. It emphasises explainability, attachment handling, and seamless switching between agent personas without sacrificing observability.

## High-Level Structure
The repository is organised as a collection of services that can run together via Docker Compose or independently for local development. Each service owns a clear responsibility—UI, orchestration, domain reasoning, retrieval, or persistence—while remaining loosely coupled through HTTP interfaces.

## Services
- `agentic_ui` - Vite/React SPA served by Nginx; proxies `/api` calls to the dialogue bridge and renders AG-UI thought, tool, and message frames.
- `dialogue_bridge` - FastAPI backend that authenticates against HashiCorp Vault, persists users/conversations/messages, stores attachments, and proxies agent inference streams.
- `agents` - FastAPI wrapper around three LangGraph workflows (OrthodoxAI v1, HR Policies v1, Retail v1) that emit AG-UI compatible SSE.
- `rag_service` - FastAPI microservice offering Chroma retrieval and DuckDB-backed Excel analytics consumed by the agents.
- `vectordb` - Chroma 0.6.x server with a bind-mounted store so embeddings survive restarts.
- `chat_postgres` - PostgreSQL 16 instance holding all structured chat data.
- `vault` - HashiCorp Vault 1.21 configured for userpass login plus OIDC token exchange; issues the JWTs that secure the dialogue bridge.

## Request Flow
1. The UI posts credentials to `/api/authenticate`; the bridge logs into Vault, exchanges the Vault client token for an OIDC JWT, writes HTTP-only session and refresh cookies, and upserts the user in Postgres.
2. Authenticated UI calls (agents roster, conversation CRUD, downloads) are authorised by validating the JWT against Vault JWKS and ensuring the Vault entity id matches the stored user.
3. Inference requests proxy chat history and attachments to the selected LangGraph endpoint and stream AG-UI frames from the agents service back to the browser.
4. Agents call `rag_service` when they need document retrieval or spreadsheet analytics; the RAG service queries Chroma (`vectordb`) or DuckDB tables hydrated from Excel workbooks.
5. Messages, reactions, attachments, and blobs are committed by the bridge to `chat_postgres`, keeping previews and the agent cache in sync.

## Docker Compose Quickstart
Prerequisites: Docker 24+, Docker Compose, and an `OPENAI_API_KEY` with access to the GPT models referenced in `src/agents/llms.py`.

```shell
# from the repo root
docker compose -f src/docker-compose.yaml up --build
```

Default endpoints:
- UI (`agentic_ui`): http://localhost:8050
- Dialogue bridge: http://localhost:8002
- Agents service: http://localhost:8003
- RAG service: http://localhost:8001
- Vault service: internal-only HashiCorp Vault container used for authentication
- Postgres: localhost:5432 (exposed for local tooling)
- Chroma (`vectordb`): internal on port 8000

Named volumes and bind mounts:
- `./src/vectorstores/chroma_db_openai` stores Chroma collections.
- `./src/vault/config` and `./src/vault/data` hold Vault Raft state and config.
- `chat_convs` persists the Postgres data directory.

Stop the stack with:

```shell
docker compose -f src/docker-compose.yaml down
```

After Vault starts for the first time, execute `src/vault/vault_init.sh` to initialise, unseal, create a userpass login, and provision the `agenticx` OIDC role expected by the bridge.

## Local Development
Each service can be run independently; the per-service READMEs expand on commands and environment variables.

- `agentic_ui`: `npm install` then `npm run dev` (Vite listens on port 8080). Configure a `/api` proxy back to the bridge during dev or rely on the Nginx container from compose.
- `dialogue_bridge`: Python 3.11+. `pip install -r requirements.txt`, export `DATABASE_URL` plus Vault settings (`VAULT_ADDR`, `VAULT_USERPASS_MOUNT`, `VAULT_OIDC_ROLE`, etc.), then `uvicorn main:app --host 0.0.0.0 --port 8002 --reload`.
- `agents`: Python 3.11+. `pip install -r requirements.txt`, set `OPENAI_API_KEY`, `RAG_HOST`, and `RAG_PORT`, then run `uvicorn main:app --host 0.0.0.0 --port 8003 --reload`.
- `rag_service`: Python 3.11+. `pip install -r requirements.txt`, populate `src/rag_service/data/` with Excel workbooks, set `OPENAI_API_KEY`, `RAG_HOST`, `RAG_PORT`, and start `uvicorn main:app --host 0.0.0.0 --port 8001 --reload`.
- `vectordb`: start `chromadb/chroma:0.6.3` with the volume bound to `./src/vectorstores/chroma_db_openai` or reuse the compose service.
- `chat_postgres`: use the compose service (`postgres:16.3`) with credentials `admin/admin` and database `chat_db`.

## Repository Layout
- `src/agentic_ui/` - React front end, Vite config, Nginx runtime image.
- `src/dialogue_bridge/` - FastAPI bridge, SQLAlchemy models, Vault auth helpers.
- `src/agents/` - LangGraph agent templates, FastAPI surface, shared tools.
- `src/rag_service/` - Retrieval and Excel analytics microservice.
- `src/vectorstores/` - Chroma persistence directory referenced by compose.
- `src/vault/` - Vault config, Raft storage, bootstrap helpers.
- `notebooks/` - Exploratory notebooks plus supporting assets and utilities.
- `docs/` - Design notes and diagrams (when present).
- `src/docker-compose.yaml` - Compose orchestration for the full stack.

## Tooling
- Front end linting via `npm run lint` inside `src/agentic_ui`.
- Python services run under Uvicorn with auto reload; add tests alongside service code as needed.
- Use `docker compose logs -f <service>` to follow container output while running the stack.

Refer to the service-specific README files for API details, configuration flags, and development workflows.
