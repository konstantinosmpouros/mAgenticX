# Agents Service

## Overview

The agents service wraps a collection of LangGraph workflows behind a FastAPI surface. It streams AG-UI compatible server-sent events that the dialogue bridge forwards to the Agentic UI. Each workflow combines OpenAI models, retrieval helpers, and domain-specific tools to deliver grounded responses.

## Service Goals

This service exists to encapsulate complex reasoning flows behind a lightweight HTTP interface. It emphasises modular graph construction, clear agent boundaries, and observability so new personas can be added without disrupting existing ones.

## What Lives Here

Inside this directory you will find the FastAPI entrypoint, reusable LangGraph blueprints, persona-specific graph implementations, and the shared tool catalogue. Supporting utilities sit alongside the agents so their behaviour remains self-contained.

## Responsibilities

- Compile and host LangGraph workflows for each persona (OrthodoxAI v1, HR Policies v1, Retail v1).
- Normalise incoming chat history (text plus image URLs/data URLs) into LangChain message objects.
- Invoke retrieval and analytics tools (vector search, Excel SQL, external APIs) and surface the intermediate thinking/tool events via AG-UI frames.
- Stream responses incrementally over SSE, including graceful `RUN_ERROR` frames when exceptions occur.

## Architecture

- `main.py` registers `POST /OrthodoxAI/v1/stream`, `/HRPolicies/v1/stream`, and `/Retail/v1/stream`, each instantiating the corresponding LangGraph agent and yielding its `astream` output.
- `blueprints/langgraph_agent.py` provides the `LangGraphAgent` base class: it validates optional tool selections supplied in the request `config`, resolves tool instances, builds the LangGraph `StateGraph`, and compiles it once per agent instance.
- `agents/langgraph_agents/*` hold the concrete workflows. Each package defines a `State` model, constructs reusable LLM chains (`agents.py`), builds node callables (`nodes.py`), and wires the graph edges (`__init__.py`).
- `agui.py` contains the `AGUIEmitter`, a thin wrapper over `ag_ui.core` that emits the correct AG-UI events for runs, thinking, tool calls, and assistant messages.
- `utils.py` exposes helpers such as `normalise_user_input`, which strips system prompts, validates multimodal content, and produces LangChain message objects.

## Agent Workflows

- **OrthodoxAI v1**: Classifies the request, optionally generates retrieval queries and reflections, performs document summarisation, and loops through a reflection stage to decide whether another retrieval pass is needed before producing the final answer. Tools can be injected via the request config.
- **HR Policies v1**: Runs a similar multi-stage pipeline with HR-specific prompts, includes document ranking and a reflection gate that can route back to query generation when additional evidence is needed.
- **Retail Agent v1**: Detects intent, decides between direct answering and data analysis, generates SQL queries executed through the RAG service (DuckDB), and produces a final summary enriched with tabular insights.

## Tooling

`tools/tools.py` defines reusable LangChain tools grouped into:

- Financial analytics (Alpha Vantage series, exchange rates, market news, gainers/losers).
- Search utilities (Google Trends via PyTrends, Wikipedia, Wikidata, PubMed).
- Research helpers (ArXiv content and summary retrievers).
- Computer vision (DALL-E 3 image generation via `OpenAIDALLEImageGenerationTool`).
Tools are selected at runtime by name; request configs can provide a `tools` list to restrict which tools are available to the agent.

## Streaming Model

Each endpoint expects a JSON body:

```json
{
  "user_input": [
    {"role": "user", "content": "..."}
  ],
  "config": {"tools": [{"tool_name": "search_wikipedia"}]}
}
```

Responses are SSE streams already encoded for AG-UI consumption (run lifecycle, thinking blocks, tool call metadata, text chunks). Errors are wrapped in a `{ "type": "RUN_ERROR", "message": "..." }` frame so the UI can present them gracefully.

## Configuration

- `OPENAI_API_KEY` (required) - used by LangChain LLM and embedding calls.
- `RAG_HOST`, `RAG_PORT` - point tools at the RAG service (defaults: `rag_service`, `8001`).
- Optional request-time `config.tools` entries let the UI limit available tool functions per conversation.

## Local Development

```shell
cd src/agents
python -m venv .venv
.\.venv\Scripts\activate    # use source .venv/bin/activate on POSIX
pip install -r requirements.txt

set OPENAI_API_KEY=sk-...
set RAG_HOST=localhost
set RAG_PORT=8001
uvicorn main:app --host 0.0.0.0 --port 8003 --reload
```

Ensure the RAG service and Chroma (`vectordb`) are reachable before streaming agents that require retrieval or analytics.

## Docker Notes

The Dockerfile is based on `python:3.10-slim`, installs build essentials and the dependencies in `requirements.txt`, copies the project, and launches Uvicorn. The compose service binds port 8003, depends on `rag_service`, and receives the OpenAI API key and RAG host/port via environment variables.

## Extending the Service

To add a new agent:

1. Create a package under `agents/langgraph_agents/` with state models, prompts, nodes, and registration logic mirroring the existing agents.
2. Expose a class that subclasses `LangGraphAgent` and wires the graph in `__init__.py`.
3. Register a new route in `main.py`.
4. Update the dialogue bridge seed data (`seed_agents`) so the UI can discover the agent.
