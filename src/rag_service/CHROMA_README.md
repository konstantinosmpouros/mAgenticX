# Vector DB Service

## Overview

The `vectordb` service packages the official `chromadb/chroma:0.6.3` image and exposes Chroma's REST API to other containers in the stack. It persists embeddings to a bind-mounted directory so collections survive restarts and provides the backing store required by `rag_service` and the LangGraph agents.

## Responsibilities

- Host a Chroma server reachable on port `8000` within the Docker network.
- Store vector collections for retrieval-augmented workflows.
- Remain internal to the `backend` network so only trusted services can access it.

## Configuration

Environment variables are set in `docker-compose.yaml`:
- `IS_PERSISTENT=TRUE`: enables disk-backed storage.
- `PERSIST_DIRECTORY=/chroma/chroma`: internal path where Chroma writes collections.
- `ANONYMIZED_TELEMETRY=FALSE`: disables outbound telemetry.

## Data Persistence

A named volume `vectorstore` is bound to `./vectorstores/chroma_db_openai`. Populate this directory with pre-built collections or allow the ingestion process to write into it. Make sure the host folder exists with the right permissions before launching the stack.

## Local Execution

To run Chroma outside compose:

```
docker run --rm -p 8000:8000 \
  -e IS_PERSISTENT=TRUE \
  -e PERSIST_DIRECTORY=/chroma/chroma \
  -e ANONYMIZED_TELEMETRY=FALSE \
  -v $(pwd)/src/vectorstores/chroma_db_openai:/chroma/chroma \
  chromadb/chroma:0.6.3
```

`rag_service` and `agents` can then reach it at `http://localhost:8000` when developing locally.

## Compose Integration

`docker-compose.yaml` attaches the container to the `backend` network and omits a `ports` section so it remains reachable only from sibling services (`rag_service`). Adjust the compose file if you need to expose Chroma outside Docker for debugging.

## Service Interactions

- Upstream: none (managed image).
- Downstream: `rag_service` connects over REST and builds retrievers; `agents` rely on that service to fetch documents stored here.
