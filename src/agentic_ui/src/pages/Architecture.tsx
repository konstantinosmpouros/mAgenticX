import { useState } from "react";
import {
  ArrowRight,
  Server,
  Workflow,
  ShieldCheck,
  Network,
  Radio,
  ExternalLink,
  Rocket,
  Wrench,
  Database,
} from "lucide-react";

const tabs = [
  { id: "services", label: "Services", icon: Server },
  { id: "deployment", label: "Deployment", icon: Rocket },
  { id: "setup", label: "Setup", icon: Wrench },
  { id: "data", label: "Data Model", icon: Database },
];

const services = [
  {
    name: "Agentic UI",
    port: "8050 (served by nginx)",
    role: "React + Vite SPA served by nginx; proxies /api to the bridge and renders AG-UI streams, attachments, and preferences.",
    flow: "Auth/session cookies are issued by the bridge; every network hop stays on /api so the UI never talks directly to backends.",
    interfaces: [
      "Auth flow proxied to the bridge/Vault: /api/authenticate and /api/session/refresh.",
      "Chat lifecycle: /api/users/:id/conversations + /messages + /attachments (multipart uploads).",
      "SSE render: /api/users/:id/conversations/:convId/inference/stream emits AG-UI events.",
    ],
    data: "Only UI state (theme, drafts) lives in the browser. All durable data rides through the bridge.",
  },
  {
    name: "Dialogue Bridge",
    port: "8002",
    role: "FastAPI BFF; validates JWTs from Vault, persists conversations/attachments in Postgres, proxies agent SSE streams, and syncs agent/tool manifests.",
    flow: "Rehydrates message history (including inline images) before posting to the agents /stream endpoint; caches active agents and forwards MCP tool metadata.",
    interfaces: [
      "Auth: /authenticate (Vault userpass→OIDC) and /session/refresh to mint/rotate cookies.",
      "Data APIs: /users/:id/conversations, /messages, /attachments for CRUD + pagination.",
      "Inference: /users/:id/conversations/:convId/inference/stream forwards SSE to agents; /agents and /tools proxy discovery.",
    ],
    data: "Owns Postgres tables for users, agents cache, conversations, messages, and attachment blobs. Depends on Vault, Agents, and Postgres.",
  },
  {
    name: "Agents",
    port: "8003",
    role: "LangGraph personas (orthodox/hr/retail) plus helper endpoints for dictation and title generation; aggregates MCP tool catalogs.",
    flow: "Streams AG-UI frames, calls rag_service for retrieval/analytics, and hydrates tools from the MCP gateway.",
    interfaces: [
      "Discovery: GET /agents and GET /tools for manifests consumed by the bridge/UI.",
      "Runtime: POST /agents/:slug/stream (SSE) consumes chat history/config/tool prefs and emits AG-UI events.",
      "Utilities: POST /dictate/transcribe (OpenAI STT) and /titles/generate for conversation names.",
    ],
    data: "Stateless; LangGraph checkpointing now uses in-memory saver per run. Depends on rag_service, MCP gateway, and OpenAI APIs.",
  },
  {
    name: "RAG Service",
    port: "8001",
    role: "FastAPI microservice around Chroma REST (vector search) and DuckDB (Excel analytics).",
    flow: "Synchronous HTTP calls from agents; no SSE. Reads embeddings from Chroma and tables from the local data directory.",
    interfaces: [
      "POST /retrieve/{collection}: semantic search via Chroma HttpClient.",
      "GET /excel/{table}/schema: column metadata to steer SQL generation.",
      "POST /excel/{table}/query/sql: executes constrained SQL against DuckDB-backed tables.",
    ],
    data: "Uses the vectorstore volume for Chroma and in-process DuckDB for spreadsheets. No user-level auth by default.",
  },
  {
    name: "MCP Gateway",
    port: "8005",
    role: "docker/mcp-gateway exposing a curated Model Context Protocol catalog over SSE.",
    flow: "Serves the catalog defined in mcp_catalog.yaml; injects secrets from mcp_secret.env; mounted Docker socket enables MCP servers that spawn containers.",
    interfaces: [
      "SSE endpoint /sse for tool discovery and invocation.",
      "Config comes from mcp_catalog.yaml + mcp_config.yaml; servers filtered via --servers flag.",
      "Secrets injected from mcp_secret.env (e.g., Tavily API token).",
    ],
    data: "Stateless aside from config/secrets; upstream MCP servers provide the actual tools.",
  },
  {
    name: "VectorDB (Chroma)",
    port: "8000",
    role: "Chroma server for embeddings collections mounted at vectorstores/chroma_db_openai.",
    flow: "Consumed exclusively by RAG Service over HTTP.",
    interfaces: [
      "Chroma HTTP API for collection management and similarity search.",
    ],
    data: "Embeddings persist to the vectorstore bind mount; lives on the internal backend network.",
  },
  {
    name: "Chat Postgres",
    port: "5432",
    role: "Primary datastore for users, agent manifests, conversations, messages, reactions, and attachment blobs.",
    flow: "Accessed only by the dialogue bridge via SQLAlchemy/asyncpg; cascades remove messages/attachments on conversation delete.",
    interfaces: [
      "PostgreSQL protocol only; no public HTTP surface.",
    ],
    data: "chat_convs volume stores the data directory. Credentials default to admin/admin in Compose.",
  },
  {
    name: "Vault",
    port: "8004 API",
    role: "HashiCorp Vault handles userpass login and issues OIDC JWTs validated by the bridge.",
    flow: "Runs via the optional docker-compose-hashicorp.yaml; JWKS is fetched by the bridge to validate session tokens.",
    interfaces: [
      "Userpass login at /v1/auth/userpass/login/:user → returns client token + JWT.",
      "JWKS exposed for verifying bridge-issued cookies.",
      "UI accessible on :8004 when enabled.",
    ],
    data: "Raft storage lives under src/vault/data; config in src/vault/config. Mounted on the external hashicorp_vault network.",
  },
];

const requestFlow = [
  "Login: UI posts to the bridge, which authenticates against Vault userpass → OIDC JWT → session/refresh cookies.",
  "Bootstrap: UI pulls agents and MCP tools from the bridge (bridge syncs with the agents service + MCP gateway) and loads user prefs from Postgres.",
  "Start a conversation: UI persists the first message/attachments via the bridge; bridge may ask the agents service to generate a title, then returns summary + detail.",
  "Inference: UI calls /inference/stream; bridge rebuilds history with inline images, sets thread/checkpoint ids, forwards to agents /stream with tool preferences.",
  "Execution: Agents run LangGraph, call rag_service (Chroma + DuckDB) and optional MCP tools, and stream AG-UI frames; bridge relays bytes 1:1 to the UI.",
  "Storage: Message/attachment rows live in Postgres; Chroma stores embeddings; Vault holds auth state.",
];

const deployment = [
  {
    title: "Local (npm/uvicorn)",
    detail: "Run the UI dev server with a proxy to 8002; run bridge, agents, and rag_service with uvicorn; run Chroma separately.",
  },
  {
    title: "Docker Compose",
    detail: "See src/docker-compose.yaml. Networks: backend (internal) + frontend; volumes: vectorstore, chat_convs.",
  },
  {
    title: "Secrets",
    detail: "OpenAI keys, Vault settings, and MCP credentials come from env vars; MCP secrets from src/mcp_gateway/mcp_secret.env.",
  },
];

const setupSections = [
  {
    title: "Prerequisites",
    bullets: [
      "Docker 24+ with Compose for the full stack.",
      "Node 18+ for Agentic UI development.",
      "Python 3.11+ for dialogue_bridge, agents, and rag_service.",
    ],
  },
  {
    title: "Env & secrets",
    bullets: [
      "OPENAI_API_KEY for agents + rag_service.",
      "DATABASE_URL for dialogue_bridge (compose default: postgresql+asyncpg://admin:admin@chat_postgres:5432/chat_db).",
      "VAULT_ADDR, VAULT_USERPASS_MOUNT, VAULT_OIDC_ROLE to talk to Vault (when enabled).",
      "MCP secrets in src/mcp_gateway/mcp_secret.env (e.g., tavily.api_token=...).",
    ],
  },
  {
    title: "Local dev commands",
    bullets: [
      "UI: npm install && npm run dev (proxy /api to 8002).",
      "Bridge: uvicorn main:app --reload --port 8002 (from src/dialogue_bridge).",
      "Agents: uvicorn main:app --reload --port 8003 (from src/agents).",
      "RAG: uvicorn main:app --reload --port 8001 (from src/rag_service).",
      "Chroma: docker run -p 8000:8000 -v ./src/vectorstores/chroma_db_openai:/chroma/chroma chromadb/chroma:0.6.3.",
    ],
  },
];

const dataModel = [
  {
    name: "agents",
    fields: "id, slug (unique), name, description, icon, version, is_active.",
    notes: "Synced from the agents service; conversations cascade-delete when an agent is removed.",
  },
  {
    name: "users & preferences",
    fields: "users: username, local user id, profile fields, last_login_at. preferences: tools JSON, prefers_agentic_chat.",
    notes: "User row is created/updated on Vault login; preferences is 1:1 via user_id.",
  },
  {
    name: "conversations",
    fields: "user_id, agent_id, title, is_private, last_message_preview, last_message_at, timestamps.",
    notes: "Ordered by updated_at; deleting cascades to messages and attachments.",
  },
  {
    name: "messages",
    fields: "sender enum(user/ai), type enum(text/file/image/audio/tool), content, parent_message_id (threading), liked, reasoning_steps, reasoning_time_seconds, is_error, error_message.",
    notes: "History is rebuilt for inference; attachments are linked per message.",
  },
  {
    name: "attachments & blobs",
    fields: "attachments: file_name, mime_type, size_bytes, blob_id; blobs: data (binary).",
    notes: "Images are base64-inlined for agents/UI; non-image files are referenced by name and size.",
  },
];

const Architecture = () => {
  const [activeTab, setActiveTab] = useState<string>("services");

  return (
    <div
      className="min-h-screen overflow-y-auto overflow-x-hidden bg-gradient-to-br from-slate-950 via-slate-950 to-slate-900 text-slate-50"
      style={{ scrollbarGutter: "stable both-edges" }}
    >
      <header className="border-b border-slate-800/70 bg-slate-950/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-slate-800 bg-slate-900/80">
              <Radio className="h-5 w-5 text-fuchsia-300" />
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.32em] text-slate-400">mAgenticX</p>
              <h1 className="text-xl font-semibold">System Architecture</h1>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <a
              href="/"
              className="inline-flex items-center gap-2 rounded-full border border-slate-700 bg-slate-800/80 px-3 py-2 text-sm font-semibold text-slate-100 transition hover:border-fuchsia-400/50 hover:bg-slate-800"
            >
              Back to app
              <ArrowRight className="h-4 w-4" />
            </a>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl px-4 py-10 space-y-10 sm:px-6">
        <section className="rounded-2xl border border-slate-800/70 bg-slate-900/70 p-6 shadow-lg shadow-fuchsia-900/25">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-2">
              <p className="text-xs uppercase tracking-[0.26em] text-slate-400">Overview</p>
              <h2 className="text-2xl font-semibold">How the pieces fit together</h2>
              <p className="max-w-3xl text-sm text-slate-200/90">
                The UI talks only to the dialogue bridge. The bridge authenticates via Vault, persists
                conversations and attachments in Postgres, proxies inference to the agents service, and fetches
                MCP tools through the agents service. Agents stream LangGraph AG-UI frames, call the RAG
                microservice for retrieval/analytics, and discover extra tools through the MCP gateway.
              </p>
            </div>
            <div className="flex gap-3">
              <div className="rounded-xl border border-fuchsia-300/50 bg-fuchsia-600/20 px-4 py-2 text-xs font-semibold uppercase tracking-[0.24em] text-fuchsia-100 shadow-inner shadow-fuchsia-900/40">
                React + FastAPI + LangGraph
              </div>
              <div className="rounded-xl border border-purple-300/50 bg-purple-600/20 px-4 py-2 text-xs font-semibold uppercase tracking-[0.24em] text-purple-100 shadow-inner shadow-purple-900/30">
                SSE Streams
              </div>
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-slate-800/70 bg-slate-950/70 p-4 shadow-lg shadow-fuchsia-900/25">
          <div className="flex flex-wrap gap-3">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold transition ${
                    isActive
                      ? "border-fuchsia-400/70 bg-fuchsia-600/20 text-fuchsia-50 shadow-inner shadow-fuchsia-900/50"
                      : "border-slate-700 bg-slate-800/70 text-slate-200 hover:border-fuchsia-400/50 hover:text-fuchsia-50"
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  {tab.label}
                </button>
              );
            })}
          </div>
        </section>

        {activeTab === "services" && (
          <>
            <section className="grid gap-4 lg:grid-cols-2">
              {services.map((svc) => (
                <article
                  key={svc.name}
                  className="rounded-2xl border border-slate-800/70 bg-slate-900/80 p-5 shadow-md shadow-fuchsia-900/25 transition hover:border-fuchsia-400/50 hover:bg-slate-900"
                >
                  <div className="flex items-start gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-slate-800 bg-slate-950/60">
                      <Server className="h-5 w-5 text-fuchsia-200" />
                    </div>
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <h3 className="text-lg font-semibold">{svc.name}</h3>
                        <span className="rounded-full border border-fuchsia-400/60 bg-fuchsia-600/20 px-2 py-0.5 text-[0.7rem] font-semibold uppercase tracking-[0.18em] text-fuchsia-50 shadow-inner shadow-fuchsia-900/40">
                          {svc.port}
                        </span>
                      </div>
                      <p className="text-sm text-slate-200/90">{svc.role}</p>
                      <p className="text-xs text-slate-400">{svc.flow}</p>
                    </div>
                  </div>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <div className="space-y-2">
                      <p className="text-[0.65rem] uppercase tracking-[0.22em] text-slate-400">Interfaces</p>
                      <ul className="space-y-1 text-xs text-slate-200/90">
                        {svc.interfaces.map((item) => (
                          <li key={item} className="flex gap-2">
                            <span className="text-slate-500">•</span>
                            <span>{item}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div className="space-y-2">
                      <p className="text-[0.65rem] uppercase tracking-[0.22em] text-slate-400">Data & dependencies</p>
                      <p className="text-xs text-slate-200/80">{svc.data}</p>
                    </div>
                  </div>
                </article>
              ))}
            </section>

            <section className="rounded-2xl border border-slate-800/70 bg-slate-900/70 p-6 shadow-lg shadow-fuchsia-900/25">
              <div className="flex items-center gap-3">
                <Workflow className="h-5 w-5 text-fuchsia-200" />
                <div>
                  <p className="text-xs uppercase tracking-[0.26em] text-slate-400">Runtime flow</p>
                  <h3 className="text-xl font-semibold">Request lifecycle</h3>
                </div>
              </div>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {requestFlow.map((step, idx) => (
                  <div
                    key={step}
                    className="flex gap-3 rounded-xl border border-slate-800/70 bg-slate-950/60 p-4 shadow-sm"
                  >
                    <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-fuchsia-400/60 bg-fuchsia-600/20 text-sm font-semibold text-fuchsia-50">
                      {idx + 1}
                    </div>
                    <p className="text-sm text-slate-200/90">{step}</p>
                  </div>
                ))}
              </div>
            </section>

            <section className="grid gap-4 lg:grid-cols-3">
              <div className="rounded-2xl border border-slate-800/70 bg-slate-900/80 p-5 shadow-md shadow-fuchsia-900/25">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="h-5 w-5 text-fuchsia-200" />
                  <h3 className="text-lg font-semibold">Security & Auth</h3>
                </div>
                <ul className="mt-3 space-y-2 text-sm text-slate-200/90">
                  <li>Vault userpass -&gt; OIDC JWT; cookies managed by the bridge.</li>
                  <li>Bridge validates JWT on every protected route; enforces user/resource ownership.</li>
                  <li>
                    MCP gateway secrets live in{" "}
                    <code className="rounded bg-white/10 px-1 py-0.5">src/mcp_gateway/mcp_secret.env</code>.
                  </li>
                </ul>
              </div>

              <div className="rounded-2xl border border-slate-800/70 bg-slate-900/80 p-5 shadow-md shadow-fuchsia-900/25">
                <div className="flex items-center gap-2">
                  <Network className="h-5 w-5 text-purple-200" />
                  <h3 className="text-lg font-semibold">Data & Storage</h3>
                </div>
                <ul className="mt-3 space-y-2 text-sm text-slate-200/90">
                  <li>Postgres stores users, conversations, messages, attachments (blob table).</li>
                  <li>
                    Chroma volume at <code className="rounded bg-white/10 px-1 py-0.5">src/vectorstores/chroma_db_openai</code>.
                  </li>
                  <li>
                  Agents keep LangGraph checkpoints in-memory per run (no volume mount).
                  </li>
                </ul>
              </div>

              <div className="rounded-2xl border border-slate-800/70 bg-slate-900/80 p-5 shadow-md shadow-fuchsia-900/25">
                <div className="flex items-center gap-2">
                  <ExternalLink className="h-5 w-5 text-pink-200" />
                  <h3 className="text-lg font-semibold">Entrypoints</h3>
                </div>
                <ul className="mt-3 space-y-2 text-sm text-slate-200/90">
                  <li>
                    UI dev: <code className="rounded bg-white/10 px-1 py-0.5">npm run dev</code> in{" "}
                    <code className="rounded bg-white/10 px-1 py-0.5">src/agentic_ui</code>.
                  </li>
                  <li>
                    Bridge: <code className="rounded bg-white/10 px-1 py-0.5">uvicorn main:app --reload --port 8002</code>.
                  </li>
                  <li>
                    Agents: <code className="rounded bg-white/10 px-1 py-0.5">uvicorn main:app --reload --port 8003</code>.
                  </li>
                </ul>
              </div>
            </section>
          </>
        )}

        {activeTab === "deployment" && (
          <section className="space-y-6">
            <div className="rounded-2xl border border-slate-800/70 bg-slate-900/70 p-6 shadow-lg shadow-fuchsia-900/25">
              <div className="flex items-center gap-2">
                <Rocket className="h-5 w-5 text-fuchsia-200" />
                <h3 className="text-xl font-semibold">Deployment options</h3>
              </div>
              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                {deployment.map((item) => (
                  <div key={item.title} className="rounded-xl border border-slate-800/70 bg-slate-950/70 p-4 shadow-sm shadow-fuchsia-900/25">
                    <p className="text-sm font-semibold text-slate-100">{item.title}</p>
                    <p className="mt-2 text-sm text-slate-200/90">{item.detail}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <div className="rounded-2xl border border-slate-800/70 bg-slate-900/80 p-5 shadow-md shadow-fuchsia-900/25">
                <h4 className="text-lg font-semibold text-slate-100">Compose specifics</h4>
                <ul className="mt-3 space-y-2 text-sm text-slate-200/90">
                  <li>Primary file: <code className="rounded bg-white/10 px-1 py-0.5">src/docker-compose.yaml</code>.</li>
                  <li>Networks: <code className="rounded bg-white/10 px-1 py-0.5">backend</code> (internal) and <code className="rounded bg-white/10 px-1 py-0.5">frontend</code>.</li>
                  <li>Volumes: vectorstore (Chroma), chat_convs (Postgres); agent checkpoints are in-memory.</li>
                  <li>
                    Optional Vault: <code className="rounded bg-white/10 px-1 py-0.5">src/docker-compose-hashicorp.yaml</code> (exposes 8004).
                  </li>
                </ul>
              </div>
              <div className="rounded-2xl border border-slate-800/70 bg-slate-900/80 p-5 shadow-md shadow-fuchsia-900/25">
                <h4 className="text-lg font-semibold text-slate-100">Ports to know</h4>
                <ul className="mt-3 space-y-2 text-sm text-slate-200/90">
                  <li>Agentic UI: 8050 (nginx).</li>
                  <li>Dialogue Bridge: 8002.</li>
                  <li>Agents: 8003.</li>
                  <li>RAG Service: 8001.</li>
                  <li>Chroma: 8000 (internal only).</li>
                  <li>MCP Gateway: 8005 (SSE catalog).</li>
                  <li>Vault: 8004 (when enabled).</li>
                </ul>
              </div>
            </div>
          </section>
        )}

        {activeTab === "setup" && (
          <section className="rounded-2xl border border-slate-800/70 bg-slate-900/70 p-6 shadow-lg shadow-fuchsia-900/25 w-full max-w-full overflow-hidden">
            <div className="flex items-center gap-2">
              <Wrench className="h-5 w-5 text-amber-200" />
              <h3 className="text-xl font-semibold">Setup checklist</h3>
            </div>
            <div className="mt-4 grid gap-4 md:grid-cols-2 w-full max-w-full">
              {setupSections.map((section) => (
                <div
                  key={section.title}
                  className="rounded-xl border border-slate-800/70 bg-slate-950/70 p-4 shadow-sm shadow-fuchsia-900/25 w-full max-w-full overflow-hidden"
                >
                  <p className="text-sm font-semibold text-slate-100">{section.title}</p>
                  <ul className="mt-2 space-y-2 text-sm text-slate-200/90 w-full max-w-full">
                    {section.bullets.map((item) => (
                      <li key={item} className="flex items-start gap-2 w-full max-w-full">
                        <span className="text-slate-500">•</span>
                        <span className="flex-1 min-w-0 max-w-full whitespace-normal break-words leading-relaxed">
                          {item}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </section>
        )}

        {activeTab === "data" && (
          <section className="space-y-6">
            <div className="rounded-2xl border border-slate-800/70 bg-slate-900/70 p-6 shadow-lg shadow-fuchsia-900/25">
              <div className="flex items-center gap-2">
                <Database className="h-5 w-5 text-fuchsia-200" />
                <h3 className="text-xl font-semibold">Database schema (Postgres)</h3>
              </div>
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                {dataModel.map((item) => (
                  <div key={item.name} className="rounded-xl border border-slate-800/70 bg-slate-950/70 p-4 shadow-sm shadow-fuchsia-900/25">
                    <p className="text-sm font-semibold uppercase tracking-[0.14em] text-slate-100">{item.name}</p>
                    <p className="mt-2 text-xs text-slate-200/90">{item.fields}</p>
                    <p className="mt-2 text-xs text-slate-400">{item.notes}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-2xl border border-slate-800/70 bg-slate-900/80 p-5 shadow-md shadow-fuchsia-900/25">
              <h4 className="text-lg font-semibold text-slate-100">Relationships to remember</h4>
              <ul className="mt-3 space-y-2 text-sm text-slate-200/90">
                <li>users 1:N conversations; conversations 1:N messages (ordered asc by created_at).</li>
                <li>messages N:1 parent_message_id for threading; each message 0:N attachments.</li>
                <li>attachments 1:1 blobs; deleting conversations cascades to messages and blobs.</li>
                <li>agents 1:N conversations; agents list is refreshed from the agents service.</li>
                <li>user_preferences 1:1 users (tools JSON, prefers_agentic_chat flag).</li>
              </ul>
            </div>
          </section>
        )}
      </main>
    </div>
  );
};

export default Architecture;
