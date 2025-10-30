# Vector DB Service

## Overview
The `vectordb` service wraps the official `chromadb/chroma:0.6.3` image and exposes Chroma's REST API to other containers. It is the persistent backing store for embeddings created by the agents and the RAG service.

## Service Context
The vector database gives the platform a durable home for embeddings and collection metadata. It stays internal to the compose network so only trusted services interact with it directly.

## What Lives Here
This document explains how the container is configured, how to run it standalone for debugging, and how other services depend on it. There is no application code—only deployment guidance and operational tips.

## Responsibilities
- Serve the Chroma REST API on port 8000 inside the compose network.
- Persist collections to a bind-mounted directory so data survives container restarts.
- Remain internal to the `backend` Docker network (no host port is published in compose).

## Configuration (compose defaults)
- `IS_PERSISTENT=TRUE`
- `PERSIST_DIRECTORY=/chroma/chroma`
- `ANONYMIZED_TELEMETRY=FALSE`
- Volume: `vectorstore:/chroma/chroma` (binds to `./src/vectorstores/chroma_db_openai` on the host)

## Local Usage
To run Chroma outside the compose stack:

```shell
docker run --rm -p 8000:8000 ^
  -e IS_PERSISTENT=TRUE ^
  -e PERSIST_DIRECTORY=/chroma/chroma ^
  -e ANONYMIZED_TELEMETRY=FALSE ^
  -v %cd%\src\vectorstores\chroma_db_openai:/chroma/chroma ^
  chromadb/chroma:0.6.3
```

Add a `ports` section to `src/docker-compose.yaml` if you need to reach Chroma from the host for debugging (the default setup keeps it internal).

## Interaction with Other Services
- `rag_service` connects via `chromadb.HttpClient` using `RAG_HOST=vectordb` and `RAG_PORT=8000`.
- The `agents` service indirectly relies on Chroma through the RAG microservice.

Keep the host directory writable so Chroma can create and update collection data. Remove the volume to reset the vector store.
