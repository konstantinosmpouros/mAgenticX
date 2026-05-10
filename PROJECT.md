# PROJECT.md

A deep technical orientation for **mAgenticX** — what it is, how it is structured, every service, every agent, every endpoint, every table, and where to find them. Intended for new contributors and AI assistants who need a fast, concrete map of the codebase.

For setup and deployment, see [README.md](README.md). This document focuses on internal structure.

---

## Table of Contents

1. [What This Project Is](#1-what-this-project-is)
2. [Repository Layout](#2-repository-layout)
3. [Architecture at a Glance](#3-architecture-at-a-glance)
4. [Services](#4-services)
5. [Backend Stack](#5-backend-stack)
6. [Frontend Stack](#6-frontend-stack)
7. [Agents Catalog](#7-agents-catalog)
8. [API Surface](#8-api-surface)
9. [Database Schema](#9-database-schema)
10. [AG-UI Event Protocol](#10-ag-ui-event-protocol)
11. [UI Inventory](#11-ui-inventory)
12. [Configuration & Environment](#12-configuration--environment)
13. [Build, Test, and CI/CD](#13-build-test-and-cicd)
14. [Complexity Hotspots](#14-complexity-hotspots)
15. [Roadmap (from src/TODO)](#15-roadmap-from-srctodo)
16. [Where to Start](#16-where-to-start)

---

## 1. What This Project Is

**mAgenticX** is a full-stack, multi-service agentic platform for authenticated chat with:

- Streamed reasoning traces (plans, sub-agent activity, tool calls)
- Retrieval-grounded answers (vector + SQL-on-tabular)
- Tool use via the Model Context Protocol (MCP)
- Branch-aware / forkable conversations
- Conversation sharing with granular access control
- Voice input (STT) and read-aloud output (TTS)
- File attachments, syntax highlighting, math rendering

It is designed for environments where plain chat is not enough — tool execution, observability, and visible reasoning artifacts are first-class.

---

## 2. Repository Layout

| Path | Purpose |
| --- | --- |
| [src/](src/) | All runtime services (UI, BFF, agents, RAG, MCP gateway, vectorstore, vault, TLS) |
| [tests/](tests/) | Service-specific and end-to-end test suites |
| [docs/](docs/) | Architecture diagrams, screenshots, deep-agent analysis PDFs |
| [notebooks/](notebooks/) | Jupyter notebooks for agent / RAG / tools / STT exploration |
| [data/](data/) | Domain knowledge bases (Orthodox theology corpus, Greek biblical texts) |
| [.github/workflows/](.github/workflows/) | CI/CD: code review, Bandit, Snyk, Claude security review |
| [README.md](README.md) | Public-facing project landing page |
| [SECURITY.md](SECURITY.md) | Security policy |
| [LICENSE](LICENSE) | License |

---

## 3. Architecture at a Glance

mAgenticX is a set of containerized FastAPI / Node services orchestrated via Docker Compose. Each service has a single responsibility and communicates over HTTP/SSE with TLS between trusted services.

```text
Browser ─► agentic_ui (nginx :8050)
              └─ /api ─► dialogue_bridge (:8002)  ──┬─► Postgres        (conversations, messages, blobs)
                                                    ├─► Vault           (auth, JWT issuance)
                                                    └─► agents (:8003) ──┬─► rag_service (:8001) ─► Chroma (:8000), OpenAI
                                                                         └─► mcp_gateway (:8005) ─► MCP tool catalog
```

**Streaming path:** the browser POSTs to `dialogue_bridge` to create a detached inference run. The bridge spawns a background asyncio task that streams from `agents` independently of any HTTP connection — agents emits AG-UI events (plans, sub-agent state, tool traces, text deltas) back into the task, which accumulates them in-memory and publishes lightweight events to SSE observers. The browser subscribes to a separate observer endpoint; it can disconnect and reconnect freely without interrupting the run. A single DB write captures the final result at completion.

---

## 4. Services

All services live under [src/](src/) and ship as containers.

| Service | Port | Stack | Responsibility |
| --- | --- | --- | --- |
| [agentic_ui/](src/agentic_ui/) | 8050 | React 18 + Vite + nginx | Browser SPA + reverse proxy. Chat UI, sharing, preferences, voice, architecture viewer. |
| [dialogue_bridge/](src/dialogue_bridge/) | 8002 | FastAPI | Authenticated BFF. Session/JWT exchange, conversation persistence, SSE proxying, attachments. |
| [agents/](src/agents/) | 8003 | FastAPI + LangGraph + DeepAgents | Streaming agent runtime. Normalizes events into the AG-UI protocol. |
| [rag_service/](src/rag_service/) | 8001 | FastAPI + Chroma + DuckDB | Vector retrieval and SQL-on-spreadsheet analytics. |
| [mcp_gateway/](src/mcp_gateway/) | 8005 | MCP server | Tool catalog and SSE endpoint for MCP-compliant tools. |
| [vectorstores/](src/vectorstores/) | 8000 | Chroma | Persistent vector storage (`chroma_db_openai/`). |
| [vault/](src/vault/) | 8004 | HashiCorp Vault | Userpass auth backend, JWT issuance. |
| [tls/](src/tls/) | — | — | Internal CA + per-service certificates. |

### Compose files

| File | Stack |
| --- | --- |
| [src/docker-compose.yaml](src/docker-compose.yaml) | Core stack: UI, Bridge, Agents, RAG, Chroma, Postgres |
| [src/docker-compose-mcp.yaml](src/docker-compose-mcp.yaml) | MCP gateway addon |
| [src/docker-compose-hashicorp.yaml](src/docker-compose-hashicorp.yaml) | Vault addon |

---

## 5. Backend Stack

**Runtime:** Python 3.11+ • FastAPI 0.135 • Uvicorn 0.32

**Agent stack:**

- LangGraph 1.1.2 — workflow graphs
- LangChain 1.2.12 — primitives, structured-output LLM wrappers
- DeepAgents 0.4.11 — planner / sub-agent delegation
- ag-ui-protocol 0.1.14 — streaming event protocol
- mcp 1.23.0 + langchain-mcp-adapters 0.1.13 — Model Context Protocol tool integration

**Persistence & retrieval:**

- PostgreSQL — async via SQLAlchemy 2.0.40 + asyncpg 0.30 — conversations, messages, attachments
- Chroma 1.5.6 + langchain-chroma 1.1.0 — vector embeddings
- DuckDB 1.3.1 + pandas 2.2.3 + openpyxl — SQL on Excel / tabular sources

**Auth & security:** HashiCorp Vault (userpass) • python-jose JWT • SlowAPI rate limiting • TLS inter-service • CSRF double-submit cookies

**Per-service requirements:**

- [src/agents/requirements.txt](src/agents/requirements.txt)
- [src/dialogue_bridge/requirements.txt](src/dialogue_bridge/requirements.txt)
- [src/rag_service/requirements.txt](src/rag_service/requirements.txt)

---

## 6. Frontend Stack

**Stack:** React 18.3 • Vite 6.4 • TypeScript • TailwindCSS 3.4 • shadcn/ui (Radix primitives)

**Notable libs:**

- `@ag-ui/core` — AG-UI protocol client for streaming reasoning artifacts
- React Router DOM, React Hook Form, TanStack React Query, Framer Motion
- Shiki 3.18 / highlight.js 11.11 / react-syntax-highlighter — code rendering
- KaTeX 0.16 + remark-math — math
- React-Markdown 10 — message rendering
- React-voice-visualizer 2.0.8 — STT visualization
- Recharts 2.12 — charts
- next-themes — dark mode

**npm scripts** (from [src/agentic_ui/package.json](src/agentic_ui/package.json)):

| Script | Command |
| --- | --- |
| `dev` | `vite` |
| `build` | `vite build` |
| `build:dev` | `vite build --mode development` |
| `lint` | `eslint .` |
| `preview` | `vite preview` |

---

## 7. Agents Catalog

### 7.1 LangGraph agents — [src/agents/langgraph_agents/](src/agents/langgraph_agents/)

| Agent | Path | Sub-nodes | Purpose |
| --- | --- | --- | --- |
| `hr_policies_agent_v1` | [hr_policies_agent_v1/agents.py](src/agents/langgraph_agents/hr_policies_agent_v1/agents.py) | analysis, simple_gen, query_reflective, query_no_reflective, doc_ranking, summarizer, complex_gen, reflection | HR policy Q&A with retrieval + reflection. Structured output: `AnalyzerOutput`, `ReflectionOutput`, `RetrievalQueriesOutput`, `RankingOutput`. |
| `retail_agent_v1` | [retail_agent_v1/agents.py](src/agents/langgraph_agents/retail_agent_v1/agents.py) | analysis, simple_gen, sql_gen, sql_error_gen, answer | Spreadsheet/retail analytics. Generates and self-corrects SQL via `SQLQueryOutput`. |
| `orthodox_agent_v1` | [orthodox_agent_v1/agents.py](src/agents/langgraph_agents/orthodox_agent_v1/agents.py) | analysis, simple_gen, query_reflective, query_no_reflective, summarizer, complex_gen, reflection | Orthodox theology agent grounded in the Greek corpus under [data/](data/). |

### 7.2 Deep agents — [src/agents/deep_agents/](src/agents/deep_agents/)

| Agent | Path | Sub-agents | Purpose |
| --- | --- | --- | --- |
| `omni_agent` | [omni_agent/system_prompts.py](src/agents/deep_agents/omni_agent/system_prompts.py) | RESEARCHER, WRITER | Planner-style orchestrator. Researcher gathers, Writer drafts; both can write files. |

### 7.3 Runtime base classes — [src/agents/runtime/](src/agents/runtime/)

- [base_agent.py](src/agents/runtime/base_agent.py) — abstract base class
- [langgraph_agent.py](src/agents/runtime/langgraph_agent.py) — LangGraph workflow runner
- [deep_agent.py](src/agents/runtime/deep_agent.py) — Deep-agent orchestration

---

## 8. API Surface

### 8.1 dialogue_bridge — [src/dialogue_bridge/router/](src/dialogue_bridge/router/)

| Method | Path | File | Purpose |
| --- | --- | --- | --- |
| POST | `/login` | [auth.py:38](src/dialogue_bridge/router/auth.py#L38) | Authenticate via Vault userpass |
| GET | `/session` | [auth.py:116](src/dialogue_bridge/router/auth.py#L116) | Current session state |
| POST | `/session/refresh` | [auth.py:126](src/dialogue_bridge/router/auth.py#L126) | Refresh access token |
| POST | `/logout` | [auth.py:141](src/dialogue_bridge/router/auth.py#L141) | Revoke session |
| GET | `/agents` | [catalog.py:20](src/dialogue_bridge/router/catalog.py#L20) | List available agents |
| GET | `/tools` | [catalog.py:35](src/dialogue_bridge/router/catalog.py#L35) | List MCP tools |
| POST | `/{user_id}` | [conversations.py:46](src/dialogue_bridge/router/conversations.py#L46) | Create conversation |
| POST | `/{user_id}/{conv_id}/branch` | [conversations.py:122](src/dialogue_bridge/router/conversations.py#L122) | Branch at message |
| POST | `/{user_id}/{conv_id}/fork` | [conversations.py:172](src/dialogue_bridge/router/conversations.py#L172) | Fork conversation |
| DELETE | `/{user_id}/{conv_id}` | [conversations.py:246](src/dialogue_bridge/router/conversations.py#L246) | Delete conversation |
| GET / PATCH / POST | various | [conversations.py](src/dialogue_bridge/router/conversations.py) | Get / list / archive / share / report |
| POST | `/stream/{user_id}/{conversation_id}` | [inference.py](src/dialogue_bridge/router/inference.py) | Legacy SSE proxy (still available) |
| POST | `/stream/.../transcribe` | [inference.py](src/dialogue_bridge/router/inference.py) | STT transcription |
| POST | `/runs/{user_id}/{conversation_id}` | [inference.py](src/dialogue_bridge/router/inference.py) | Create and start a detached inference run |
| GET | `/runs/{user_id}?status=active` | [inference.py](src/dialogue_bridge/router/inference.py) | List active runs (hydration on load/refresh) |
| GET | `/runs/{user_id}/{run_id}/stream` | [inference.py](src/dialogue_bridge/router/inference.py) | SSE observer — snapshot on connect, then live events |
| POST | `/runs/{user_id}/{run_id}/cancel` | [inference.py](src/dialogue_bridge/router/inference.py) | Signal asyncio cancel; run aborts at current await |
| POST | `/{user_id}/{conversation_id}` | [messages.py:35](src/dialogue_bridge/router/messages.py#L35) | Add message |
| PATCH | `/{user_id}/{conversation_id}/{message_id}` | [messages.py:99](src/dialogue_bridge/router/messages.py#L99) | Like / feedback |
| POST | various | [messages.py](src/dialogue_bridge/router/messages.py) | Read-aloud, report, generate suggestions |
| GET | `/download/`, `/preview/`, `/images/` | [attachments.py](src/dialogue_bridge/router/attachments.py) | Stream blobs (byte-range) |
| GET / PUT | `/preferences/{user_id}` | [preferences.py](src/dialogue_bridge/router/preferences.py) | User prefs |
| GET / POST | `/shares/...` | [shared_conv.py](src/dialogue_bridge/router/shared_conv.py) | Create/access shared conversations |

### 8.2 agents — [src/agents/main.py](src/agents/main.py)

Internal-only (TLS-fronted, not exposed to the browser):

| Method | Path | Line | Purpose |
| --- | --- | --- | --- |
| POST | `/dictate/transcribe` | [main.py:111](src/agents/main.py#L111) | STT |
| GET | `/agents` | [main.py:190](src/agents/main.py#L190) | List agents + metadata |
| GET | `/tools` | [main.py:203](src/agents/main.py#L203) | MCP tool catalog |
| POST | `/titles/generate` | [main.py:230](src/agents/main.py#L230) | Auto-title conversation |
| POST | `/suggestions/generate` | [main.py:240](src/agents/main.py#L240) | Next-turn suggestions |
| POST | `/speech/read-aloud` | [main.py:250](src/agents/main.py#L250) | TTS |
| POST | `/agents/{agent_slug}/stream` | [main.py:269](src/agents/main.py#L269) | Stream agent inference (AG-UI events) |

### 8.3 rag_service — [src/rag_service/main.py](src/rag_service/main.py)

| Method | Path | Line | Purpose |
| --- | --- | --- | --- |
| POST | `/retrieve/{collection_name}` | [main.py:47](src/rag_service/main.py#L47) | Semantic retrieval from Chroma |
| GET | `/excel/{table}/schema` | [main.py:80](src/rag_service/main.py#L80) | Table schema |
| POST | `/excel/{table}/query/sql` | [main.py:95](src/rag_service/main.py#L95) | Read-only SQL on workbook |

---

## 9. Database Schema

SQLAlchemy models live in [src/dialogue_bridge/core/database.py](src/dialogue_bridge/core/database.py).

| Table | Key columns | Notes |
| --- | --- | --- |
| `agents` | `id`, `slug` (unique), `name`, `description`, `icon`, `version`, `is_active` | Agent registry shown in UI catalog |
| `users` | `id`, `username` (unique), `vault_user_id` (unique), `email`, `display_name`, `department`, `role_title`, `last_login_at` | Synced from Vault on login |
| `user_preferences` | `id`, `user_id` (FK, unique), `tools` (JSON), `prefers_agentic_chat`, `suggestions_enabled`, `read_aloud_voice` | Per-user feature flags |
| `conversations` | `id`, `user_id`, `agent_id`, `forked_parent_id`, `forked_message_id`, `title`, `is_private`, `is_archived`, `last_message_preview`, `last_message_at`, `active_inference_run_id` (FK) | Branch lineage via `forked_parent_id` / `forked_message_id`; `active_inference_run_id` points to the current detached run |
| `messages` | `id`, `conversation_id`, `parent_message_id`, `sender` (user/ai), `type` (text/file/image/audio/tool), `content`, `liked`, `reasoning_steps` (JSON), `raw_events` (JSON), `plan` (JSON), `subagents` (JSON) | AG-UI events captured per-message |
| `inference_runs` | `id`, `user_id`, `conversation_id`, `assistant_message_id`, `parent_message_id`, `status` (queued/running/cancelling/completed/cancelled/failed), `message_path` (JSON), `enabled_tools` (JSON), `content`, `thinking` (JSON), `raw_events` (JSON), `plan` (JSON), `subagents` (JSON), `error_message`, `started_at`, `completed_at`, `cancel_requested_at`, `updated_at` | Detached run record; partial unique index enforces at most one active run per conversation |
| `attachments` | `id`, `message_id`, `file_name`, `mime_type`, `size_bytes`, `blob_id` | Metadata |
| `blobs` | `id`, `data` (binary), `created_at` | File binary storage |
| `conversation_reports` | `id`, `conversation_id`, `user_id`, `message_id`, `reason`, `details`, `status` | Abuse reports |
| `conversation_shares` | `id`, `token` (unique), `conversation_id`, `owner_user_id`, `snapshot_until_message_id`, `snapshot_json`, `is_active`, `expires_at` | Share tokens with frozen snapshots |
| `sessions` | `id`, `user_id`, `access_token_hash` (unique), `refresh_token_hash` (unique), `access_expires_at`, `refresh_expires_at`, `revoked_at`, `user_agent_hash`, `ip_hash` | JWT/session tracking |

Pydantic DTOs (60+) live in [`src/dialogue_bridge/schemas/__init__.py`](src/dialogue_bridge/schemas/__init__.py).

---

## 10. AG-UI Event Protocol

The agent runtime emits a structured event stream consumed by the UI. Events are defined in [src/agents/runtime/protocols/agui/events.py](src/agents/runtime/protocols/agui/events.py) and emitted by [src/agents/runtime/protocols/agui/emitter.py](src/agents/runtime/protocols/agui/emitter.py); the bridge captures them via [src/agents/runtime/protocols/agui/normalizer.py](src/agents/runtime/protocols/agui/normalizer.py).

| Event | Purpose |
| --- | --- |
| `RUN_STARTED` / `RUN_FINISHED` | Agent run lifecycle |
| `TEXT_MESSAGE_START` / `_CONTENT` / `_END` | Streamed assistant text |
| `THINKING_START` / `_END` / `THINKING_TEXT_MESSAGE_CONTENT` | Reasoning block |
| `TOOL_CALL_START` / `_ARGS` / `_RESULT` / `_END` | Tool invocation lifecycle |
| `PLAN_SNAPSHOT` | Planner state checkpoint |
| `TASK_SUBAGENT` / `SUBAGENT_EVENT` | Sub-agent assignment + activity envelope |
| `BEFORE_AGENT_EVENT` | Pre-agent-run hook |
| `HITL_INTERRUPT` | Human-in-the-loop interrupt |

---

## 11. UI Inventory

### 11.1 Pages — [src/agentic_ui/src/pages/](src/agentic_ui/src/pages/)

| File | Role |
| --- | --- |
| `ChatPage.tsx` | Primary chat surface |
| `Login.tsx` | Authentication form |
| `SharedConvPage.tsx` | Read-only / partial-share viewer |
| `Architecture.tsx` | Live architecture viewer |
| `Test.tsx` | Dev test harness |
| `ErrorPage.tsx` | Error state |
| `NotFound.tsx` | 404 |

### 11.2 Chat components — [src/agentic_ui/src/components/chat/](src/agentic_ui/src/components/chat/)

| Component | Role |
| --- | --- |
| `ChatHeader.tsx` | Top bar with agent / conversation info |
| `ChatBody.tsx` | Message stream container |
| `ChatInputBar.tsx` | Input + attachments + STT |
| `ChatSidebar.tsx` | Conversation list + settings |
| `ChatMessage.tsx` | Single message render |
| `MessageContent.tsx` | Markdown + code + math rendering |
| `MessageAttachments.tsx` | Per-message attachment gallery |
| `ActionBars.tsx` | Copy / like / regenerate actions |
| `BranchControls.tsx` | Branch / fork UI |
| `ChainOfThought.tsx` | Reasoning trace |
| `PlanningContainer.tsx` | Plan snapshot visualization |
| `SubagentContainer.tsx` | Sub-agent task / result display |
| `SharePanel.tsx` | Share token + expiry UI |
| `ProfilePanel.tsx` | User profile / session |
| `ReportPanel.tsx` | Abuse report flow |
| `AttachmentPreviewPanel.tsx` | Image / PDF preview |

### 11.3 Hooks — [src/agentic_ui/src/hooks/](src/agentic_ui/src/hooks/)

| Hook | Role |
| --- | --- |
| `useSessionEffects.ts` | Auth state sync + token refresh |
| `useChatEffects.ts` | SSE subscription + AG-UI state machine |
| `useInferenceRuns.ts` | Global detached run manager — hydration, beginRun, stopRun, applyRunEvent, observeRunId |
| `useKeyboardShortcuts.ts` | Send, branch, etc. |
| `use-toast.ts` | Toast notifications |
| `use-mobile.tsx` | Mobile viewport detection |

### 11.4 Handlers — [src/agentic_ui/src/handlers/](src/agentic_ui/src/handlers/)

`auth.ts`, `conversations.ts`, `messages.ts`, `inference.ts`, `attachments.ts`, `agents.ts`, `preferences.ts`, `sharedConversations.ts`, `agui.ts` (event parsing), `shortcuts.ts`.

---

## 12. Configuration & Environment

### 12.1 Config files

- Per-service config in `core/configs.py` (see [src/agents/core/configs.py](src/agents/core/configs.py), [src/dialogue_bridge/core/configs.py](src/dialogue_bridge/core/configs.py))
- [src/mcp_gateway/mcp_catalog.yaml](src/mcp_gateway/mcp_catalog.yaml) — MCP tool registry (~519 KB)
- [src/mcp_gateway/mcp_config.yaml](src/mcp_gateway/mcp_config.yaml) — MCP server config
- TLS material under [src/tls/](src/tls/)

### 12.2 Environment variables

**External APIs** (root `.env`): `OPENAI_API_KEY`, `OPENAI_ORG`, `OPENAI_PROJ`, `ANTHROPIC_API_KEY`, `HUGGINGFACE_TOKEN`, `ELEVENLABS_API_KEY`, `TAVILY_API_KEY`, `SERPAPI_API_KEY`, `SERPER_API_KEY`, `EXA_API_KEY`, `ALPHAVANTAGE_API_KEY`, `JINA_API_KEY`.

**App / logging:** `APP_ENV`, `APP_VERSION`, `LOG_SERVICE_NAME`.

**Database:** `DATABASE_ECHO`, `DATABASE_POOL_PRE_PING`, `DATABASE_POOL_RECYCLE`, `DATABASE_POOL_SIZE`, `DATABASE_MAX_OVERFLOW`.

**Session / cookies:** `SESSION_COOKIE_SECURE`, `SESSION_COOKIE_DOMAIN`, `SESSION_COOKIE_NAME`, `SESSION_REFRESH_COOKIE_NAME`, `SESSION_CSRF_COOKIE_NAME`, `SESSION_CSRF_HEADER_NAME`, `SESSION_ACCESS_TTL_SECONDS`, `SESSION_REFRESH_TTL_SECONDS`, `SESSION_MAX_PER_USER`, `SESSION_COOKIE_SAMESITE`.

**CORS:** `CORS_ALLOWED_ORIGINS`, `CORS_ALLOW_CREDENTIALS`, `CORS_ALLOW_METHODS`, `CORS_ALLOW_HEADERS`, `CORS_EXPOSE_HEADERS`.

**Auth + proxy + TLS:** `VAULT_URL`, `VAULT_USERPASS_MOUNT`, `TRUSTED_PROXY_CIDRS`, `TLS_CA_CERT_PATH`.

---

## 13. Build, Test, and CI/CD

### 13.1 Tests — [tests/](tests/)

| Path | Coverage |
| --- | --- |
| [tests/agents/](tests/agents/) | Agent runtime + LangGraph integration |
| [tests/dialogue_bridge/](tests/dialogue_bridge/) | Routers, schemas, auth, conversation logic |
| [tests/rag_service/](tests/rag_service/) | Retrieval, SQL, Chroma integration |
| [tests/mcp_gateway/](tests/mcp_gateway/) | MCP gateway compose/config contracts |
| [tests/agentic_ui/](tests/agentic_ui/) | Frontend API/static contract coverage |
| [tests/integration/](tests/integration/) | Backend integration flows (create → stream → finalize, archive/delete, report/share) |

### 13.2 CI workflows — [.github/workflows/](.github/workflows/)

| Workflow | Purpose |
| --- | --- |
| `code-review.yml` | Claude code-review action on PR open / sync |
| `security-bandit.yml` | Python static security analysis (Bandit) on `src/agents/`, `src/dialogue_bridge/`, `src/rag_service/` |
| `security-snyk.yml` | Dependency vulnerability scanning (npm + Python) |
| `security-claude.yml` | Claude-assisted security review (manual / sensitive PRs) |

### 13.3 Local dev

- **Frontend:** `cd src/agentic_ui && npm install && npm run dev`
- **Backend services:** Docker Compose (`docker compose -f src/docker-compose.yaml up`)
- **Notebooks:** [notebooks/](notebooks/) — `Agents`, `DeepAgents`, `RAG`, `Tools`, `STT_Analysis`

---

## 14. Complexity Hotspots

Files most critical for understanding (and most expensive to break):

| File | LOC | Why it matters |
| --- | --- | --- |
| [src/agents/runtime/protocols/agui/normalizer.py](src/agents/runtime/protocols/agui/normalizer.py) | 674 | AG-UI SSE event normalization / parsing |
| [src/dialogue_bridge/router/conversations.py](src/dialogue_bridge/router/conversations.py) | 638 | Conversation CRUD + branching + sharing |
| [`src/dialogue_bridge/schemas/__init__.py`](src/dialogue_bridge/schemas/__init__.py) | 580 | 60+ Pydantic DTOs |
| [src/dialogue_bridge/utils/inference_runs.py](src/dialogue_bridge/utils/inference_runs.py) | 506 | Detached run lifecycle — InferenceRunManager singleton, asyncio task spawning, pub/sub fan-out, DB write policy |
| [src/dialogue_bridge/core/database.py](src/dialogue_bridge/core/database.py) | 387 | SQLAlchemy models + relationships |
| [src/dialogue_bridge/core/auth_session.py](src/dialogue_bridge/core/auth_session.py) | 378 | JWT / session / CSRF / refresh |
| [src/agents/core/configs.py](src/agents/core/configs.py) | 347 | Env-driven service config |
| [src/agents/langgraph_agents/hr_policies_agent_v1/nodes.py](src/agents/langgraph_agents/hr_policies_agent_v1/nodes.py) | 335 | Multi-step HR workflow nodes |
| [src/agents/main.py](src/agents/main.py) | 330 | Service init + route registration |
| [src/agents/protocols/agui/emitter.py](src/agents/protocols/agui/emitter.py) | 293 | AG-UI event encoding / emission |
| [src/agents/runtime/deep_agent.py](src/agents/runtime/deep_agent.py) | 282 | DeepAgent orchestration |

---

## 15. Roadmap (from [src/TODO](src/TODO))

### 15.1 Security hardening

- Constrain / remove free-form SQL endpoint in `rag_service`
- Refresh-token replay detection
- Edge rate limiting at nginx / Cloudflare
- Prompt-injection guardrails on user input
- Reduce upload DoS surface; enforce size limits
- Container hardening (CPU/memory limits, read-only FS, tmpfs)

### 15.2 New product features

- **Projects / Workspaces** — group conversations, agents, tools; project-scoped memory
- **Deep Research mode** — multi-step workflows, citations, traces, exportable reports
- **Scheduled Tasks** — one-off and recurring agent jobs
- **Artifacts / Canvas** — editable generated content
- **Agent run timeline** — planning → retrieval → tools → verification
- **Voice mode** — real-time conversational voice agents
- **Long-term memory service** across agents
- **Document interaction** — PDF / Word / Excel preview & edit

### 15.3 Engineering

- Migrate retrieval to MCP tool calling
- End-to-end non-image attachment support in inference + deep-agent passthrough
- Replace Chroma with **pgvector in Postgres** (single store, easier sync)
- Centralized logging (ELK / Datadog / Loki)
- More robust retry logic
- More unit / integration / stress tests

---

## 16. Where to Start

| If you want to… | Start here |
| --- | --- |
| Stand the platform up | [README.md](README.md) → Quick Start |
| Add a new LangGraph agent | Copy a folder under [src/agents/langgraph_agents/](src/agents/langgraph_agents/) and register it in [src/agents/main.py](src/agents/main.py) |
| Add a new deep agent | [src/agents/deep_agents/omni_agent/](src/agents/deep_agents/omni_agent/) as the template |
| Add a new tool | Append to [src/mcp_gateway/mcp_catalog.yaml](src/mcp_gateway/mcp_catalog.yaml) |
| Add an HTTP endpoint | A router under [src/dialogue_bridge/router/](src/dialogue_bridge/router/), then a DTO in [`schemas/__init__.py`](src/dialogue_bridge/schemas/__init__.py) |
| Change DB schema | [src/dialogue_bridge/core/database.py](src/dialogue_bridge/core/database.py) |
| Touch auth / sessions | [src/dialogue_bridge/core/auth_session.py](src/dialogue_bridge/core/auth_session.py) + [src/vault/](src/vault/) |
| Touch the chat surface | [src/agentic_ui/src/pages/ChatPage.tsx](src/agentic_ui/src/pages/ChatPage.tsx) + [src/agentic_ui/src/components/chat/](src/agentic_ui/src/components/chat/) |
| Wire a new AG-UI event into the UI | Emit in [src/agents/runtime/protocols/agui/emitter.py](src/agents/runtime/protocols/agui/emitter.py), parse in [src/agentic_ui/src/handlers/agui.ts](src/agentic_ui/src/handlers/agui.ts), render in a chat component |
| Add a retrieval source | [src/rag_service/](src/rag_service/) |
| Trace a message end-to-end | UI input → `dialogue_bridge` `POST /runs` → `create_inference_run` → `InferenceRunManager.launch` spawns asyncio task → task calls `agents` `/agents/{slug}/stream` → AG-UI events accumulated in `InferenceRunRuntime` → published to observers → single DB write at `_finish_run` → rendered via `useInferenceRuns.applyRunEvent` |
| Trace a detached run end-to-end | [src/dialogue_bridge/utils/inference_runs.py](src/dialogue_bridge/utils/inference_runs.py) — start at `create_inference_run`, follow `InferenceRunManager.launch` → `_do_stream` → `_finish_run`; pair with [src/agentic_ui/src/hooks/useInferenceRuns.ts](src/agentic_ui/src/hooks/useInferenceRuns.ts) `beginRun` → `observeRunId` → `applyRunEvent` |
