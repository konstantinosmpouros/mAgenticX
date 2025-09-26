# Chat Postgres Service

## Overview

`chat_postgres` runs the official `postgres:latest` container and provides durable storage for the dialogue bridge. Conversation metadata, messages, attachments, and binary blobs are persisted here via SQLAlchemy models defined in `src/dialogue_bridge/database.py`.

## Responsibilities

- Host a PostgreSQL 15+ compatible instance reachable on port `5432`.
- Persist seeded users, agent metadata, and all chat-related tables.
- Share data across restarts through the `chat_convs` named volume.

## Configuration

Environment variables set in `docker-compose.yaml`:

- `POSTGRES_USER=admin`
- `POSTGRES_PASSWORD=admin`
- `POSTGRES_DB=chat_db`

Mount points:

- `chat_convs` volume -> `/var/lib/postgresql/data` to retain database files.

Networks:

- Attached to both `backend` and `frontend` to simplify connectivity from `dialogue_bridge` and (if required) external tools. Adjust networks if you want to limit access further.

## Local Execution

Launch the same configuration outside compose:

```shell
docker run --rm -p 5432:5432 \
  -e POSTGRES_USER=admin \
  -e POSTGRES_PASSWORD=admin \
  -e POSTGRES_DB=chat_db \
  -v $(pwd)/.postgres-data:/var/lib/postgresql/data \
  postgres:latest
```

Update `DATABASE_URL` in the dialogue bridge (`postgresql+asyncpg://admin:admin@localhost:5432/chat_db`) when running locally.

## Operational Notes

- The dialogue bridge automatically creates tables and seeds agents/users on startup, so the database can start empty.
- Use any Postgres client (`psql`, `pgAdmin`, `DBeaver`) to inspect data. Credentials match the env vars above.
- Rotate credentials and enable SSL for production scenarios; adjust compose overrides accordingly.

## Service Interactions

Consumed exclusively by `dialogue_bridge`, which creates an async SQLAlchemy engine using the provided credentials and manages schema creation during startup.
