# Agents Service

## Overview

The `agents` container hosts the LangGraph-based inference workflows that power each conversational persona. A FastAPI app wraps three compiled graphs (OrthodoxAI v1, HR Policies v1, Retail v1) and streams their responses using the AG-UI server-sent events protocol so the UI receives thought, tool, and message frames in real time.

## Responsibilities

- Host the agent workflows compiled with LangGraph `StateGraph`.
- Marshal requests from the dialogue bridge into the LangGraph runtime and stream responses as SSE frames.
- Invoke retrieval and analytics tools backed by the `rag_service` (vector search and Excel SQL execution).
- Coordinate shared utilities for tool schemas, moderation, and OpenAI model access across agents.

## Key Technologies

- FastAPI and Uvicorn for the HTTP surface (`main.py`).
- LangGraph plus LangChain components for graph construction and tool execution.
- `ag_ui.core` and the custom `AGUIEmitter` (`agui.py`) for AG-UI compatible event encoding.
- OpenAI GPT models (via `langchain-openai`) for reasoning and generation.
- Async streaming interfaces (`astream`) for incremental agent output.

## API Surface

- `POST /OrthodoxAI/v1/stream` - Streams Orthodox theological answers with multi-stage retrieval, summarisation, and reflection.
- `POST /HRPolicies/v1/stream` - Streams HR guidance grounded in the HR RAG collection.
- `POST /Retail/v1/stream` - Streams retail analytics that blend natural language reasoning with DuckDB insights fetched through the `rag_service` Excel endpoints.

Each endpoint accepts `{ "user_input": [{ "role": "...", "content": "..." }, ...] }` and returns an SSE stream already encoded for the AG-UI frontend.

## Runtime Configuration

- `OPENAI_API_KEY` (required): used by all LangChain LLM and embedding calls.
- `RAG_HOST` and `RAG_PORT`: point tool calls at the RAG microservice (defaults to `rag_service:8001` when running with compose).
- Container listens on port `8003` and is joined to both the `backend` and `frontend` networks so the dialogue bridge and UI can access it.

## Local Development

```shell
cd src/agents
python -m venv .venv && .\.venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8003 --reload
```

The agents expect the RAG service to be reachable and Chroma collections to exist; run `rag_service` and `vectordb` alongside for end-to-end testing.

## Docker Notes

The Dockerfile builds from `python:3.10-slim`, installs build essentials plus the dependencies in `requirements.txt`, copies the source tree, and starts Uvicorn (with `--reload` enabled for dev workflows). When `docker compose` builds the `agents` image it uses this folder as the context.

## Code Map

- `main.py`: FastAPI routes and SSE streaming glue.
- `agui.py`: Reusable AG-UI emitter that formats LangGraph events.
- `config.py`: Shared configuration for RAG endpoints and collection names.
- `orthodox_agents/`, `hr_agents/`, `retail_agents/`: LangGraph graph definitions, nodes, and prompts for each persona.
- `tools/`: Tool wrappers used inside the graphs (Excel SQL, RAG retrieval, telemetry helpers).
- `llms.py`, `moderation.py`: Shared model factories and guardrails.

## Service Interactions

- Upstream: relies on `rag_service` for vector search and Excel analytics, plus OpenAI APIs for LLM calls.
- Downstream: consumed exclusively by `dialogue_bridge`, which proxies SSE responses to the `agentic_ui` frontend.
