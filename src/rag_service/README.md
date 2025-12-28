# RAG Service

FastAPI microservice for retrieval and spreadsheet analytics used by the agents service.

## What it does

- Connects to the Chroma REST API (`vectordb`) with OpenAI `text-embedding-3-large` embeddings to return top-k documents.
- Loads Excel workbooks from `data/` into in-memory DuckDB tables at startup (first worksheet only, snake_case table names). Startup fails fast if `data/` is missing or no sheets load; unreadable sheets are skipped with warnings.
- Exposes schema and SQL query endpoints the agents use for grounded analytics.

## API surface

- `POST /retrieve/{collection_name}` with `{"query": "...", "k": 4}` – async top-k retrieval. Returns 404 when no documents match.
- `GET /excel/{table}/schema` – `DESCRIBE` results as `{column, type}` pairs.
- `POST /excel/{table}/query/sql` with `{"sql": "SELECT ... FROM <table> ..."}` – executes SQL; 404 if the table is unknown, 400 on SQL errors.

## Data loading

- Startup walks `data/` for Excel files (`.xlsx`, `.xls`, `.xlsm`), sanitises names into snake_case (e.g., `Financial Sample.xlsx` → `financial_sample`), and registers each first sheet as a DuckDB table.
- Table metadata is cached in `config.TABLES`; the API rejects requests for tables not present in this cache.
- Remove or replace files in `data/` and restart the service to refresh the available tables.

## Runtime notes

- `config.py` wires `chromadb.HttpClient` using `RAG_HOST/RAG_PORT`, wraps it with LangChain `Chroma`, and caches workbook metadata in `TABLES`.
- Table names are sanitised (non-word chars replaced with `_`), preserving the original schema in metadata.
- The FastAPI app listens on port 8001; Compose puts it on both backend and frontend networks so agents can reach it.

## Configuration

- `OPENAI_API_KEY` (required) – passed to `OpenAIEmbeddings` (`text-embedding-3-large`).
- `RAG_HOST`, `RAG_PORT` (required) – Chroma host/port; no defaults are applied, so set them explicitly (Compose sets `RAG_HOST=vectordb`, `RAG_PORT=8000`).
- Excel files must exist under `data/` before startup or the service will raise during import.

## Local development

```shell
cd src/rag_service
python -m venv .venv
source .venv/bin/activate   # use .venv\\Scripts\\activate on Windows
pip install -r requirements.txt

export OPENAI_API_KEY=sk-...
export RAG_HOST=localhost
export RAG_PORT=8000
uvicorn main:app --host 0.0.0.0 --port 8001 --reload
```

Run a Chroma server locally (see `README_CHROMA.md`) and keep at least one readable workbook in `data/`.

## Docker notes

The Dockerfile builds from `python:3.10-slim`, installs dependencies, and starts Uvicorn. Compose depends on `vectordb`, injects OpenAI credentials, and mounts the `data/` directory into the container.
