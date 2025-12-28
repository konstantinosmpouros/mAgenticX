# Agents Service

LangGraph-backed FastAPI service that streams AG-UI events for each persona, lists available MCP tools, and offers utility endpoints for dictation and conversation titling.

## What it does

- Hosts the agent registry (`hr-policies-agent-v1`, `orthodox-agent-v1`, `retail-agent-v1`) discovered automatically from `langgraph_agents/*` and streams their output via `/agents/{slug}/stream`.
- Normalises chat history (text + images) before invoking graphs, resolving tool selections from the MCP gateway and surfacing thinking/tool frames over SSE.
- Exposes `GET /agents` for manifests and `GET /tools` for the live MCP tool catalog (server id, name, description, parameter count) cached for the UI.
- Provides `POST /dictate/transcribe` speech-to-text using `gpt-4o-transcribe` and `POST /titles/generate` to name new conversations.
- Maps tool ids like `tavily-search` back to the correct MCP server when the gateway omits server prefixes, keeping server/tool separation intact for the UI.

## API surface

- `GET /agents` – agent manifests discovered from the registry.
- `GET /tools` – MCP tool manifests pulled via `MCP_TOOLS_HTTP_URL`.
- `POST /agents/{agent_slug}/stream` – streams AG-UI SSE frames. Body shape:

  ```json
  {
    "user_input": [{"role": "user", "content": "..."}],
    "config": {"tools": [{"tool_name": "brave_web_search"}]}
  }
  ```

  The `config.tools` list prunes allowed MCP tools per request; unknown tools are ignored with a warning.
- `POST /dictate/transcribe` – multipart upload (`file`) returning `{ "text": "..." }`.
- `POST /titles/generate` – returns `{ "title": "..." }` for the provided first message.

## Architecture

- `blueprints/langgraph_agent.py` defines the `LangGraphAgent` base: validates tool selections, resolves MCP tools, builds the LangGraph `StateGraph`, and caches the compiled graph.
- `langgraph_agents/*` house the concrete workflows (state models, prompts, nodes, wiring). Each class exposes `name` (slug) and `manifest()`.
- `utils/mcp_tools.py` connects to the MCP gateway over SSE (`MCP_TOOLS_HTTP_URL`), caches manifests, and offers helper functions to map server/tool identifiers.
- `utils/agents.py` discovers agents into `AGENT_REGISTRY`, builds stream URLs, and surfaces manifests for the bridge cache.
- `agui.py` emits AG-UI frames for runs, thinking, tool calls, and assistant messages.

## Configuration

- `OPENAI_API_KEY` (required) – used for LLM calls, embeddings, and dictation.
- `RAG_HOST` / `RAG_PORT` – point retrieval tools at the RAG service (defaults align with Compose).
- `MCP_TOOLS_HTTP_URL` – MCP gateway SSE endpoint (default `http://mcp_gateway:8005/sse`).
- `DISABLED_AGENT_SLUGS` (optional) – comma-separated agent slugs to skip at startup (e.g., `hr-policies-agent-v1, Retail Agent`). Whitespace around commas is ignored; whitespace inside a slug is preserved. Leaving it empty registers all agents.

## Local development

```shell
cd src/agents
python -m venv .venv
source .venv/bin/activate   # use .venv\\Scripts\\activate on Windows
pip install -r requirements.txt

export OPENAI_API_KEY=sk-...
export RAG_HOST=localhost
export RAG_PORT=8001
export MCP_TOOLS_HTTP_URL=http://localhost:8005/sse   # match your gateway port
uvicorn main:app --host 0.0.0.0 --port 8003 --reload
```

Ensure the RAG service and MCP gateway are reachable before exercising retrieval-heavy agents.

## Docker notes

The Dockerfile targets `python:3.11-slim`, installs dependencies, and starts Uvicorn. Docker Compose binds port 8003, depends on `rag_service`, sets `MCP_TOOLS_HTTP_URL`, and mounts `agents_checkpoints` for LangGraph state when needed.
