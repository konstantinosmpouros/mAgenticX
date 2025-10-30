# RAG Service

## Overview
The RAG service is a FastAPI microservice exposing vector retrieval and spreadsheet analytics used by the LangGraph agents. It wraps a Chroma REST client, generates embeddings via OpenAI, and loads Excel workbooks into an in-memory DuckDB database during startup.

## Service Role
This microservice decouples retrieval and analytics concerns from the conversational agents. It offers a stable contract for fetching contextual documents and running lightweight SQL across curated spreadsheets so agents can stay focused on reasoning.

## Directory Highlights
Within this folder you will find the FastAPI app, configuration module that wires DuckDB and Chroma, request schemas, Dockerfile, and supporting data directory. Together they provide everything required to run the service on its own or as part of the full stack.

## Responsibilities
- Connect to the Chroma server (`vectordb`) over REST and provide async top-k document retrieval for named collections.
- Boot Excel files from `data/` into DuckDB tables and expose schema introspection plus SQL execution endpoints.
- Provide lightweight JSON APIs consumed by agents for grounding and analytics.

## Retrieval Workflow
`config.py` constructs a `chromadb.HttpClient` with host/port from `RAG_HOST` and `RAG_PORT`, plus `langchain-openai` embeddings (`text-embedding-3-large`). Each `/retrieve/{collection}` request builds a LangChain `Chroma` retriever and calls `ainvoke` to fetch the requested number of documents. Responses include the original query, `k`, and an array of `{content, metadata}` entries. HTTP 404 signals that no documents were returned.

## Excel Analytics
At startup the service scans `data/` for `.xlsx/.xls/.xlsm` files, sanitises names into snake_case table identifiers, reads the first worksheet with pandas, and registers it with DuckDB. Metadata for each table (original schema) is stored in `TABLES`. `GET /excel/{table}/schema` runs `DESCRIBE` to list column names and types; `POST /excel/{table}/query/sql` executes arbitrary SQL (validated to ensure the table exists) and returns `row_count` plus `data` records. Errors are surfaced as 400 responses. If no workbook loads successfully the service fails fast at startup.

## API Reference
- `POST /retrieve/{collection_name}` with body `{"query": "...", "k": 4}` -> top-k documents from the named Chroma collection.
- `GET /excel/{table}/schema` -> array of `{column, type}` pairs for the registered DuckDB table.
- `POST /excel/{table}/query/sql` with body `{"sql": "SELECT ... FROM table ..."}` -> executes SQL against DuckDB and returns JSON rows.

All endpoints raise 4xx/5xx on failure and use standard JSON responses.

## Configuration
- `OPENAI_API_KEY` (required) - passed to `OpenAIEmbeddings`.
- `RAG_HOST`, `RAG_PORT` - location of the Chroma REST API (defaults align with the compose `vectordb` service).
- Excel files must be present under `data/` before startup.
- The FastAPI app listens on port 8001; the compose service attaches to both `backend` and `frontend` networks so agents can reach it.

## Local Development
```shell
cd src/rag_service
python -m venv .venv
.\.venv\Scripts\activate    # use source .venv/bin/activate on POSIX
pip install -r requirements.txt

set OPENAI_API_KEY=sk-...
set RAG_HOST=localhost
set RAG_PORT=8000
uvicorn main:app --host 0.0.0.0 --port 8001 --reload
```

Run a Chroma server locally (see `README_CHROMA.md`) and ensure the `data/` directory contains at least one readable workbook.

## Docker Notes
The Dockerfile is based on `python:3.10-slim`, installs system build tools plus dependencies from `requirements.txt`, copies the service, and starts Uvicorn. In compose the container depends on `vectordb`, inherits OpenAI credentials, and shares the internal network with the agents service.
