# RAG Service

## Overview

FastAPI microservice that exposes retrieval and lightweight analytics capabilities consumed by the LangGraph agents. It connects to an external Chroma DB instance over REST, generates embeddings with OpenAI, and loads Excel workbooks into an in-memory DuckDB database for SQL-style analytics.

## Responsibilities

- Retrieve top-k documents from named Chroma collections using `langchain-chroma`.
- Translate Excel workbooks stored in `data/` into DuckDB tables and expose schema plus SQL execution endpoints.
- Provide simple HTTP APIs for the agents to ground their answers with factual context.

## Key Technologies

- FastAPI and Uvicorn for the HTTP layer (`main.py`).
- `chromadb` REST client plus `langchain-chroma` to build retrievers around Chroma collections.
- OpenAI `text-embedding-3-large` via `langchain-openai` for embedding queries.
- DuckDB and Pandas to register Excel sheets as queryable tables.
- Pydantic v2 for request validation.

## API Reference

- `POST /retrieve/{collection_name}`: body `{ "query": str, "k": int }`. Returns the top-k `page_content` plus metadata documents.
- `GET /excel/{table}/schema`: returns column names and DuckDB types for a registered table.
- `POST /excel/{table}/query/sql`: body `{ "sql": str }`. Executes the provided SQL (must reference the same table) and returns `row_count` plus JSON rows.

All responses use standard JSON and raise HTTP 4xx/5xx when retrieval fails or no data is found.

## Startup Workflow

`config.py` loads Excel files from `data/`, sanitises table names, registers them with DuckDB, and builds a registry (`TABLES`). The FastAPI app creates a Chroma REST client per request using `RAG_HOST` and `RAG_PORT`, then wraps it with a LangChain retriever.

## Configuration

- `OPENAI_API_KEY` (required) for embeddings.
- `RAG_HOST` and `RAG_PORT` identify the Chroma REST endpoint (defaults align with the `vectordb` compose service).
- Service listens on port `8001` and is reachable from both the `agents` container and, optionally, other services in the compose network.
- Excel files must live in `src/rag_service/data/`; at least one readable workbook is required at startup.

## Local Development

```shell
cd src/rag_service
python -m venv .venv && .\.venv\Scripts\activate
pip install -r requirements.txt
set OPENAI_API_KEY=your-key
set RAG_HOST=localhost
set RAG_PORT=8000
uvicorn main:app --host 0.0.0.0 --port 8001 --reload
```

Run a Chroma instance separately (see `vectordb` notes) and ensure the `data/` directory has Excel files before starting the server. Replace `set` with `export` on POSIX shells.

## Docker Notes

Dockerfile is based on `python:3.10-slim`, installs build tools, installs `requirements.txt`, copies the service code, and launches Uvicorn. In compose the service is named `rag_service` and depends on the `vectordb` container that provides the Chroma REST API plus persistent volume `vectorstore` mapped to `src/vectorstores/chroma_db_openai`.

## Code Map

- `main.py`: FastAPI endpoints for retrieval and Excel SQL.
- `config.py`: env handling, Chroma client settings, DuckDB bootstrap, embedding factory.
- `schemas.py`: Pydantic models for incoming requests.
- `data/`: Excel inputs that become DuckDB tables at runtime.
- `Dockerfile` and `requirements.txt`: container build and dependencies.

## Service Interactions

- Upstream: uses the `vectordb` service (Chroma) and OpenAI embeddings.
- Downstream: consumed by the `agents` service for both RAG document retrieval and Excel analytics.
