# RAG Service

FastAPI microservice that provides two capabilities:

- Retrieval from a ChromaDB vector store using OpenAI embeddings.
- Lightweight Excel analytics via DuckDB (schema discovery and SQL execution over loaded Excel workbooks).

## Overview

- Server: FastAPI (`main.py`)
- Vector DB: Chroma running in REST mode (external container/service)
- Embeddings: OpenAI `text-embedding-3-large` via `langchain-openai`
- Excel engine: In‑memory DuckDB populated from `data/` Excel files on startup

This service does not perform ingestion/indexing. It retrieves from an existing Chroma collection and lets agents query Excel data by SQL.

## Endpoints

- POST `/retrieve/{collection_name}`
  - Body: `{ "query": string, "k": number }`
  - Returns: top‑`k` documents from the specified Chroma `collection_name`.
  - Example:

    ```bash
    curl -X POST \
      http://localhost:8001/retrieve/my_collection \
      -H "Content-Type: application/json" \
      -d '{"query":"What are Q4 highlights?","k":5}'
    ```

- GET `/excel/{table}/schema`
  - Returns: column names and DuckDB types for the loaded table.
  - Example:

    ```bash
    curl http://localhost:8001/excel/financial_sample/schema
    ```

- POST `/excel/{table}/query/sql`
  - Body: `{ "sql": string }` (must reference the `table` given in the path)
  - Returns: JSON rows and `row_count`.
  - Example:

    ```bash
    curl -X POST \
      http://localhost:8001/excel/financial_sample/query/sql \
      -H "Content-Type: application/json" \
      -d '{"sql":"SELECT Country, SUM(Sales) AS total_sales FROM financial_sample GROUP BY Country ORDER BY total_sales DESC LIMIT 5"}'
    ```

## Configuration

- Env vars
  - `OPENAI_API_KEY`: OpenAI API key used by embeddings
  - `RAG_HOST`: Chroma REST host (e.g., `vectordb` when using docker‑compose)
  - `RAG_PORT`: Chroma REST port (e.g., `8000`)

- Ports
  - Uvicorn serves on `8001` (see `Dockerfile`).

- Data directory
  - Place Excel files in `data/` (same folder as `main.py`).
  - Supported: `.xlsx`, `.xls`, `.xlsm`.

## Running Locally

1) Install dependencies

```bash
cd src/rag_service
pip install -r requirements.txt
```

2) Start or point to a Chroma REST server (e.g., docker image `chromadb/chroma:0.6.3`).

3) Set env vars and run the API

```bash
export OPENAI_API_KEY=... \
       RAG_HOST=localhost \
       RAG_PORT=8000

uvicorn main:app --host 0.0.0.0 --port 8001 --reload
```

4) Verify with the examples in the Endpoints section.

Notes:

- Ensure `data/` contains at least one readable Excel workbook. A sample `data/Financial Sample.xlsx` is included.
- The service retrieves from an existing Chroma `collection_name`; populate collections using your ingestion pipeline separately.

## Running with Docker

Build and run the service container alone:

```bash
cd src/rag_service
docker build -t rag_service:local .
docker run --rm -p 8001:8001 \
  -e OPENAI_API_KEY=$OPENAI_API_KEY \
  -e RAG_HOST=host.docker.internal \
  -e RAG_PORT=8000 \
  rag_service:local
```

Using the repository docker‑compose (recommended):

```bash
cd src
docker compose up -d vectordb rag_service
```

This starts Chroma (`vectordb`) and the RAG API (`rag_service`). The API listens on port 8001 inside the network (exposed externally only if you add a port mapping).

## Code Map

- `main.py`: FastAPI app; retrieval and Excel endpoints.
- `config.py`: env vars, Chroma client settings, OpenAI embeddings, Excel → DuckDB loading.
- `schemas.py`: Pydantic models for request bodies.
- `requirements.txt`: Python dependencies.
- `Dockerfile`: Container setup for the service.
