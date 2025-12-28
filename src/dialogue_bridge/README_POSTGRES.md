# Chat Postgres Service

## Overview

`chat_postgres` packages the official `postgres:16.3` image and provides durable storage for the dialogue bridge. All conversations, messages, attachments, and blob payloads defined in `src/dialogue_bridge/database/` are persisted here so they survive container restarts.

## Service Context

This database container is the backbone of conversational persistence for the platform. It exists purely to give the dialogue bridge a reliable, isolated store that can be inspected or reset without touching other services.

## What Lives Here

The README documents the configuration expected by Docker Compose, tips for running a compatible Postgres instance locally, and operational notes for maintaining the data volume. No application code resides in this folder—only infrastructure guidance.

## Responsibilities

- Host a PostgreSQL instance reachable on port 5432 for the dialogue bridge and admin tooling.
- Persist synced agent metadata plus runtime inserts for users, conversations, messages, attachments, and blobs.
- Expose a writable volume (`chat_convs`) that keeps database files across restarts or upgrades.

## Configuration (compose defaults)

- `POSTGRES_USER=admin`
- `POSTGRES_PASSWORD=admin`
- `POSTGRES_DB=chat_db`
- Volume: `chat_convs:/var/lib/postgresql/data`
- Networks: `backend` and `frontend` so both the bridge and local admin clients can connect. The compose file also publishes `5432:5432` for host access.

## Local Usage

To run the same configuration outside Docker Compose:

```shell
docker run --rm -p 5432:5432 ^
  -e POSTGRES_USER=admin ^
  -e POSTGRES_PASSWORD=admin ^
  -e POSTGRES_DB=chat_db ^
  -v %cd%\.postgres-data:/var/lib/postgresql/data ^
  postgres:16.3
```

(Use the POSIX variant with `\` line continuations instead of `^` on macOS/Linux.) Point the dialogue bridge at `postgresql+asyncpg://admin:admin@localhost:5432/chat_db` when running locally.

## Operational Notes

- The bridge calls `Base.metadata.create_all` on startup, so the database can begin empty.
- The dialogue bridge syncs agent metadata from the agents service during startup.
- Use any Postgres client (`psql`, `pgAdmin`, `DBeaver`) with the credentials above to inspect or export data.
- For production you should override credentials, enable TLS, and bind the data directory to managed storage.

## Connectivity

The dialogue bridge creates a pooled async SQLAlchemy engine with `asyncpg` and uses transactions around every request. No other service depends on this database.
