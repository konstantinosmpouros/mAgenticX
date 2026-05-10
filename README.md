<p align="center">
    <img src="src/agentic_ui/public/logo2.png" alt="mAgenticX logo" width="120" />
</p>

<h1 align="center">mAgenticX</h1>

<p align="center">
    A production-shaped agentic platform — multi-agent orchestration, retrieval, tool use, and a full chat workspace with observable reasoning.
</p>

<p align="center">
    <a href="#quick-start">Quick Start</a> •
    <a href="#architecture-at-a-glance">Architecture</a> •
    <a href="#services">Services</a> •
    <a href="#documentation-hub">Docs</a>
</p>

```mermaid
flowchart TB
    subgraph Users["Users"]
        Admin["Admin"]
        Browser["End user browser"]
    end

    subgraph Platform["mAgenticX Platform"]
        UI["agentic_ui<br/>(served by nginx)"]
        Bridge["dialogue_bridge<br/>(FastAPI BFF)"]
        Agents["agents<br/>(LangGraph workflows)"]
        MCP["mcp_gateway<br/>(MCP tool catalog SSE)"]
        RAG["rag_service<br/>(retrieval and analytics)"]
    end

    subgraph Stores["Managed stores & services"]
        PG["chat_postgres<br/>(conversations and blobs)"]
        Vault["HashiCorp Vault<br/>(auth and JWT)"]
        Chroma["vectordb Chroma<br/>(vector collections)"]
        OpenAI["OpenAI API<br/>(LLMs and embeddings)"]
    end

    Admin -->|"configure UI"| UI
    Browser -->|"HTTP SSE via 8050"| UI
    UI -->|"REST SSE via /api"| Bridge
    Bridge -->|"Proxy SSE and tools"| Agents
    Agents -->|"Tool catalog SSE"| MCP
    Bridge -->|"Persist conversations"| PG
    Bridge -->|"JWT exchange"| Vault
    Agents -->|"Document and analytics tools"| RAG
    RAG -->|"Vector REST"| Chroma
    RAG -->|"Embeddings"| OpenAI
    Admin -->|"DB tooling"| PG
    Admin -->|"Vault CLI UI"| Vault
```

## What mAgenticX Is

mAgenticX is a full-stack agentic system built around a browser chat experience, an authenticated backend-for-frontend, a streaming agent runtime, and a dedicated retrieval layer. It is designed for environments where you need more than plain chat: tool execution, retrieval grounding, attachments, dictation, observability, and visible reasoning artifacts such as plans, sub-agent activity, and tool traces.

The repository is split into focused services, each with its own implementation README. This root document is the landing page for the project: it explains how the platform fits together, where to start, and where to go next.

## Table of Contents

- [What mAgenticX Is](#what-magenticx-is)
- [Why It Exists](#why-it-exists)
- [Architecture at a Glance](#architecture-at-a-glance)
- [Core Flows](#core-flows)
- [Examples](#examples)
- [Services](#services)
- [Repository Map](#repository-map)
- [Quick Start](#quick-start)
- [Screens and Diagrams](#screens-and-diagrams)
- [Documentation Hub](#documentation-hub)
- [Development Notes](#development-notes)
- [License](#license)

## Why It Exists

- To provide a production-shaped agentic chat stack instead of a single demo script.
- To separate concerns cleanly across UI, auth/persistence, agent execution, retrieval, and tool discovery.
- To expose agent runtime behavior in the UI through AG-UI events rather than hiding everything behind a plain text stream.
- To support both retrieval-backed domain agents and more general deep-agent orchestration patterns in the same project.
- To keep each major subsystem independently understandable and deployable.

## Architecture at a Glance

```mermaid
flowchart LR
    User["User"]
    UI["Agentic UI\nReact + Vite + nginx"]
    Bridge["Dialogue Bridge\nFastAPI BFF"]
    Agents["Agents Service\nLangGraph + deep agents"]
    RAG["RAG Service\nChroma + DuckDB access"]
    MCP["MCP Gateway\nSSE tool catalog"]
    Vault["Vault\nuserpass auth"]
    PG["Postgres\nconversations + attachments"]
    Chroma["Chroma\nvector store"]

    User --> UI
    UI --> Bridge
    Bridge --> Vault
    Bridge --> PG
    Bridge --> Agents
    Agents --> RAG
    Agents --> MCP
    RAG --> Chroma
```

## Core Flows

### Authenticated Chat Flow

The browser talks only to the dialogue bridge. The bridge authenticates against Vault, manages the application session, persists conversation state, and owns the inference run as a persistent server-side asyncio task. The browser can disconnect and reconnect freely without interrupting the run.

```mermaid
sequenceDiagram
    participant U as User
    participant UI as Agentic UI
    participant B as Dialogue Bridge
    participant P as Postgres
    participant A as Agents

    U->>UI: Sign in and open chat
    UI->>B: /api/v1/auth/login
    B-->>UI: session + refresh cookies
    UI->>B: POST /api/v1/inference/runs/{userId}/{conversationId}
    B->>P: create inference_run row + AI placeholder message
    B-->>UI: run_id + initial snapshot
    B->>B: spawn background asyncio task (detached)
    UI->>B: GET /api/v1/inference/runs/{userId}/{run_id}/stream (SSE observer)
    B-->>UI: DB snapshot on connect, then live in-memory events
    B->>A: POST /agents/{slug}/stream (inside background task)
    A-->>B: AG-UI SSE frames
    B->>B: accumulate in InferenceRunRuntime (no DB writes during stream)
    B-->>UI: publish lightweight events to all observers
    B->>P: single DB write at run completion (content, events, status)
```

### Retrieval and Tooling Flow

The agents service can combine model reasoning with vector retrieval, spreadsheet analytics, and MCP tools, then emit the resulting activity back to the UI as structured events.

```mermaid
flowchart TD
    Prompt["User prompt"]
    Agent["Selected agent"]
    Decide{"Needs retrieval or tools?"}
    RAG["RAG service"]
    MCP["MCP gateway tools"]
    Chroma["Chroma search"]
    DuckDB["DuckDB SQL over Excel"]
    Stream["AG-UI events"]

    Prompt --> Agent
    Agent --> Decide
    Decide -->|Vector or tabular grounding| RAG
    Decide -->|External tools| MCP
    RAG --> Chroma
    RAG --> DuckDB
    RAG --> Agent
    MCP --> Agent
    Agent --> Stream
```

### Browser Rendering Flow

The UI does not just append streamed text. It receives events from the run observer SSE endpoint and normalizes them into visible assistant text, tool traces, plan snapshots, thinking progress, and sub-agent artifacts. The run continues on the server even if the browser disconnects; reconnecting replays a DB snapshot and then resumes live events.

```mermaid
flowchart LR
    Observer["Run observer SSE\n(/inference/runs/.../stream)"]
    Snapshot["DB snapshot on connect"]
    Live["Live in-memory events"]
    Parse["applyRunEvent(...)"]
    Text["Assistant text"]
    Tools["Tool activity"]
    Plan["Plan snapshots"]
    Sub["Sub-agent state"]
    Persist["Single DB write at completion"]

    Observer --> Snapshot
    Observer --> Live
    Snapshot --> Parse
    Live --> Parse
    Parse --> Text
    Parse --> Tools
    Parse --> Plan
    Parse --> Sub
    Text --> Persist
    Tools --> Persist
    Plan --> Persist
    Sub --> Persist
```

## Examples

Representative use cases supported by the current codebase:

- HR policy support: ask policy or workplace questions against the HR retrieval workflow and surface grounded answers with cited context.
- Orthodox domain support: route religious and theological prompts through the Orthodox workflow with domain-specific retrieval logic.
- Retail and spreadsheet analysis: query tabular business data through the RAG service’s DuckDB-backed Excel layer.
- General agentic orchestration: use the Omni/deep-agent path for planning, delegation, tool use, and sub-agent event rendering.

## Services

| Service | Role | Default Port | Main Stack | Docs |
| --- | --- | ---: | --- | --- |
| `agentic_ui` | Browser chat app and reverse proxy entrypoint | `8050` | React, Vite, nginx | [UI README](src/agentic_ui/README.md) |
| `dialogue_bridge` | Authenticated BFF, persistence layer, SSE proxy | `8002` | FastAPI, SQLAlchemy, Postgres | [Bridge README](src/dialogue_bridge/README.md) |
| `agents` | Streaming agent runtime and AG-UI normalization | `8003` | FastAPI, LangGraph, OpenAI | [Agents README](src/agents/README.md) |
| `rag_service` | Retrieval and SQL over spreadsheet-backed data | `8001` | FastAPI, Chroma, DuckDB | [RAG README](src/rag_service/README.md) |
| `mcp_gateway` | Tool catalog and MCP SSE endpoint | `8005` | docker/mcp-gateway | [MCP Gateway README](src/mcp_gateway/README.md) |
| `vectordb` | Persistent vector storage for retrieval | `8000` | Chroma | integrated |
| `chat_postgres` | Durable chat state, attachments, and feedback | `5432` | PostgreSQL | integrated |
| `vault` | Authentication backend used by the bridge | `8004` | HashiCorp Vault | integrated |

## Repository Map

```text
.
├── README.md
├── LICENSE
├── docs/
│   └── architecture screenshots and diagrams
├── notebooks/
│   └── exploratory and analysis notebooks
└── src/
    ├── agentic_ui/          React SPA, nginx proxy, AG-UI rendering
    ├── dialogue_bridge/     FastAPI BFF, auth, persistence, SSE relay
    ├── agents/              Agent runtime, manifests, AG-UI event output
    ├── rag_service/         Retrieval and DuckDB-backed analytics
    ├── mcp_gateway/         MCP catalog and gateway config
    ├── vectorstores/        Chroma persistence
    ├── vault/               Vault config and bootstrap assets
    ├── docker-compose.yaml
    ├── docker-compose-mcp.yaml
    └── docker-compose-hashicorp.yaml
```

## Quick Start

### Prerequisites

- Docker and Docker Compose for the containerized stack
- Node.js 18+ for standalone UI development
- Python 3.11+ for standalone backend development
- OpenAI API access for the configured models

### Core Stack

The main application services are defined in `src/docker-compose.yaml`:

```bash
docker compose -f src/docker-compose.yaml up --build
```

This core stack includes:

- `agentic_ui`
- `dialogue_bridge`
- `agents`
- `rag_service`
- `vectordb`
- `chat_postgres`

### Supporting Services

The repo also includes separate Compose files for infrastructure that may be run alongside or independently of the core stack:

- `src/docker-compose-mcp.yaml` for the MCP gateway
- `src/docker-compose-hashicorp.yaml` for Vault

The main stack expects external connectivity to `mcp_net` and `hashicorp_vault` when those services are deployed separately. Review those Compose files before assuming a single-command full-environment startup.

### Main URLs

When the default Compose setup is running:

- UI: `http://localhost:8050`
- Dialogue Bridge: `http://localhost:8002`
- Agents: `http://localhost:8003`
- RAG Service: `http://localhost:8001`
- MCP Gateway: `http://localhost:8005/sse` when started
- Vault: `http://localhost:8004` when started

### Local Development

For service-by-service development, use the implementation READMEs:

- [UI local development](src/agentic_ui/README.md#development)
- [Dialogue bridge setup](src/dialogue_bridge/README.md)
- [Agents setup](src/agents/README.md)
- [RAG service setup](src/rag_service/README.md)
- [MCP gateway setup](src/mcp_gateway/README.md)

## Screens and Diagrams

### Network and Request Flow

```mermaid
flowchart TD
    Browser["Browser"] -->|"HTTP :8050"| Nginx["nginx — agentic_ui"]
    Nginx -->|"/ → static SPA assets"| SPA["React SPA"]
    Nginx -->|"/api/ → proxy_pass :8002"| Bridge["dialogue_bridge :8002"]
    Bridge -->|"TLS :8003"| Agents["agents :8003"]
    Bridge -->|"asyncpg :5432"| PG["chat_postgres"]
    Bridge -->|"HTTPS :8004"| Vault["vault :8004"]
    Agents -->|"HTTP :8001"| RAG["rag_service :8001"]
    Agents -->|"SSE :8005"| MCP["mcp_gateway :8005"]
    RAG -->|"HTTP :8000"| Chroma["vectordb :8000"]
    Agents & RAG -->|"HTTPS"| OpenAI["OpenAI API"]
```

### Platform Overview

```mermaid
flowchart TB
    subgraph Users["Users"]
        Admin["Admin"]
        Browser["End user browser"]
    end

    subgraph Platform["mAgenticX Platform"]
        UI["agentic_ui\n(served by nginx)"]
        Bridge["dialogue_bridge\n(FastAPI BFF)"]
        Agents["agents\n(LangGraph workflows)"]
        MCP["mcp_gateway\n(MCP tool catalog SSE)"]
        RAG["rag_service\n(retrieval and analytics)"]
    end

    subgraph Stores["Managed stores & services"]
        PG["chat_postgres\n(conversations and blobs)"]
        Vault["HashiCorp Vault\n(auth and JWT)"]
        Chroma["vectordb Chroma\n(vector collections)"]
        OpenAI["OpenAI API\n(LLMs and embeddings)"]
    end

    Admin -->|"configure UI"| UI
    Browser -->|"HTTP SSE via 8050"| UI
    UI -->|"REST SSE via /api"| Bridge
    Bridge -->|"Proxy SSE and tools"| Agents
    Agents -->|"Tool catalog SSE"| MCP
    Bridge -->|"Persist conversations"| PG
    Bridge -->|"JWT exchange"| Vault
    Agents -->|"Document and analytics tools"| RAG
    RAG -->|"Vector REST"| Chroma
    RAG -->|"Embeddings"| OpenAI
    Admin -->|"DB tooling"| PG
    Admin -->|"Vault CLI UI"| Vault
```

### Chat Lifecycle

```mermaid
sequenceDiagram
    participant U as User
    participant UI as Agentic UI
    participant B as Dialogue Bridge
    participant P as Postgres
    participant A as Agents

    U->>UI: Send message
    UI->>B: POST /runs/{userId}/{conversationId}
    B->>P: create inference_run row + AI message placeholder
    B-->>UI: run_id + initial snapshot
    B->>B: spawn detached asyncio task
    UI->>B: GET /runs/{userId}/{run_id}/stream (SSE observer)
    B-->>UI: DB snapshot on connect, then live events per chunk
    B->>A: POST /agents/{slug}/stream (inside background task)
    A-->>B: AG-UI SSE frames
    B-->>UI: lightweight events published to all observers
    B->>P: single DB write at run completion
    U->>UI: disconnect / refresh
    Note over B,A: run continues server-side uninterrupted
    UI->>B: reconnect → GET /runs/{userId}/{run_id}/stream
    B-->>UI: fresh DB snapshot + resume live events
```

### Authentication

```mermaid
sequenceDiagram
    participant B as Browser
    participant Bridge as Dialogue Bridge
    participant Vault as HashiCorp Vault
    participant PG as Postgres

    B->>Bridge: POST /login {username, password}
    Bridge->>Vault: POST /v1/auth/userpass/login/{username}
    Vault-->>Bridge: Vault client_token
    Bridge->>PG: upsert user row, create session row (hashed tokens)
    Bridge-->>B: HttpOnly cookies — session, refresh, CSRF value

    Note over B,Bridge: Every authenticated request
    B->>Bridge: request + X-CSRF-Token header + session cookie
    Bridge->>Bridge: verify access JWT + CSRF double-submit
    Bridge-->>B: response

    Note over B,Bridge: Token refresh
    B->>Bridge: POST /session/refresh (refresh cookie)
    Bridge->>Bridge: rotate access token, update session row
    Bridge-->>B: new session + CSRF cookies

    Note over B,Bridge: Sign out
    B->>Bridge: POST /logout
    Bridge->>PG: mark session revoked
    Bridge-->>B: clear all cookies
```

## Documentation Hub

Use the root README for orientation, then jump into the service manuals for implementation detail:

- [Agentic UI](src/agentic_ui/README.md)
- [Dialogue Bridge](src/dialogue_bridge/README.md)
- [Agents Service](src/agents/README.md)
- [RAG Service](src/rag_service/README.md)
- [MCP Gateway](src/mcp_gateway/README.md)

## Development Notes

- If you are working on the browser experience, start with `src/agentic_ui`.
- If you are changing auth, sessions, chat persistence, or SSE proxying, start with `src/dialogue_bridge`.
- If you are changing agent workflows, manifests, or AG-UI stream behavior, start with `src/agents`.
- If you are changing retrieval collections, Excel analytics, or DuckDB behavior, start with `src/rag_service`.
- If you are changing available tools or MCP server wiring, start with `src/mcp_gateway`.

## License

This repository is licensed under the [MIT License](LICENSE).
