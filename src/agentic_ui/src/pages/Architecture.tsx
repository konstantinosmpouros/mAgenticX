import { ArrowRight, Server, Workflow, ShieldCheck, Network, Radio, ExternalLink } from "lucide-react";

const services = [
  {
    name: "Agentic UI",
    port: "8050 (80 in container) / 8080 dev",
    role: "React + Vite SPA served by nginx; proxies /api to the bridge.",
    flow: "Talks only to the dialogue_bridge for auth, conversations, MCP tools, and dictation.",
  },
  {
    name: "Dialogue Bridge",
    port: "8002",
    role: "FastAPI orchestrator; Vault auth, Postgres persistence, attachment streaming, inference proxy.",
    flow: "Calls agents for SSE streams, RAG via agents, and returns MCP tool manifests to the UI.",
  },
  {
    name: "Agents",
    port: "8003",
    role: "LangGraph personas (hr/orthodox/retail), MCP tool discovery, dictation, title generation.",
    flow: "Streams AG-UI frames, resolves MCP tools via gateway, calls RAG for retrieval/analytics.",
  },
  {
    name: "RAG Service",
    port: "8001",
    role: "FastAPI microservice wrapping Chroma REST + DuckDB Excel analytics.",
    flow: "Serves /retrieve/{collection} and /excel endpoints to agents.",
  },
  {
    name: "MCP Gateway",
    port: "8005",
    role: "docker/mcp-gateway exposing a curated Model Context Protocol catalog over SSE.",
    flow: "Agents hit /sse to list tools; secrets come from mcp_secret.env.",
  },
  {
    name: "VectorDB (Chroma)",
    port: "8000",
    role: "Chroma server for embeddings collections (mounted at vectorstores/chroma_db_openai).",
    flow: "Consumed by RAG Service.",
  },
  {
    name: "Vault & Postgres",
    port: "Vault internal / Postgres 5432",
    role: "Vault issues OIDC JWTs and userpass auth; Postgres stores users, conversations, attachments.",
    flow: "Bridge depends on both for auth and storage.",
  },
];

const requestFlow = [
  "UI authenticates through the bridge; bridge exchanges with Vault, sets session/refresh cookies.",
  "UI fetches agents + MCP tools via bridge. Bridge caches agents; tools come from agents -> MCP gateway.",
  "User sends a message: bridge rebuilds history (including inline images) and posts to agents /stream.",
  "Agent runs LangGraph, calls RAG (Chroma/DuckDB) and optional MCP tools; streams AG-UI frames back.",
  "Bridge relays frames to UI; attachments are stored in Postgres blobs, previews returned on fetch.",
];

const deployment = [
  {
    title: "Local (npm/uvicorn)",
    detail: "Run UI on 8080 with a proxy to 8002; run bridge, agents, and rag_service with uvicorn; run Chroma separately.",
  },
  {
    title: "Docker Compose",
    detail: "See src/docker-compose.yaml. Networks: backend (internal) + frontend; volumes: vectorstore, chat_convs, agents_checkpoints.",
  },
  {
    title: "Secrets",
    detail: "OpenAI keys, Vault settings, and MCP credentials come from env vars; MCP secrets from src/mcp_gateway/mcp_secret.env.",
  },
];

const Architecture = () => {
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-slate-50">
      <header className="border-b border-white/5 bg-slate-900/60 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-white/10 bg-white/5">
              <Radio className="h-5 w-5" />
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.32em] text-slate-400">mAgenticX</p>
              <h1 className="text-xl font-semibold">System Architecture</h1>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <a
              href="/"
              className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-2 text-sm font-semibold text-slate-100 transition hover:border-white/20 hover:bg-white/10"
            >
              Back to app
              <ArrowRight className="h-4 w-4" />
            </a>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10 space-y-10">
        <section className="rounded-2xl border border-white/10 bg-white/5 p-6 shadow-lg">
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
              <div className="rounded-xl border border-emerald-300/30 bg-emerald-500/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.24em] text-emerald-100">
                React + FastAPI + LangGraph
              </div>
              <div className="rounded-xl border border-cyan-300/30 bg-cyan-500/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.24em] text-cyan-100">
                SSE Streams
              </div>
            </div>
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-2">
          {services.map((svc) => (
            <article
              key={svc.name}
              className="rounded-2xl border border-white/10 bg-slate-900/70 p-5 shadow-md transition hover:border-white/20 hover:bg-slate-900"
            >
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/10 bg-white/5">
                  <Server className="h-5 w-5 text-slate-100" />
                </div>
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <h3 className="text-lg font-semibold">{svc.name}</h3>
                    <span className="rounded-full bg-white/10 px-2 py-0.5 text-[0.7rem] font-semibold uppercase tracking-[0.18em] text-slate-200">
                      {svc.port}
                    </span>
                  </div>
                  <p className="text-sm text-slate-200/90">{svc.role}</p>
                  <p className="text-xs text-slate-400">{svc.flow}</p>
                </div>
              </div>
            </article>
          ))}
        </section>

        <section className="rounded-2xl border border-white/10 bg-white/5 p-6 shadow-lg">
          <div className="flex items-center gap-3">
            <Workflow className="h-5 w-5 text-slate-100" />
            <div>
              <p className="text-xs uppercase tracking-[0.26em] text-slate-400">Runtime flow</p>
              <h3 className="text-xl font-semibold">Request lifecycle</h3>
            </div>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {requestFlow.map((step, idx) => (
              <div
                key={step}
                className="flex gap-3 rounded-xl border border-white/10 bg-slate-900/70 p-4 shadow-sm"
              >
                <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-sm font-semibold">
                  {idx + 1}
                </div>
                <p className="text-sm text-slate-200/90">{step}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-3">
          <div className="rounded-2xl border border-white/10 bg-slate-900/70 p-5 shadow-md">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-emerald-200" />
              <h3 className="text-lg font-semibold">Security & Auth</h3>
            </div>
            <ul className="mt-3 space-y-2 text-sm text-slate-200/90">
              <li>Vault userpass -&gt; OIDC JWT; cookies managed by the bridge.</li>
              <li>Bridge validates JWT on every protected route; enforces user/resource ownership.</li>
              <li>MCP gateway secrets live in <code className="rounded bg-white/10 px-1 py-0.5">src/mcp_gateway/mcp_secret.env</code>.</li>
            </ul>
          </div>

          <div className="rounded-2xl border border-white/10 bg-slate-900/70 p-5 shadow-md">
            <div className="flex items-center gap-2">
              <Network className="h-5 w-5 text-cyan-200" />
              <h3 className="text-lg font-semibold">Data & Storage</h3>
            </div>
            <ul className="mt-3 space-y-2 text-sm text-slate-200/90">
              <li>Postgres stores users, conversations, messages, attachments (blob table).</li>
              <li>Chroma volume at <code className="rounded bg-white/10 px-1 py-0.5">src/vectorstores/chroma_db_openai</code>.</li>
              <li>Agents checkpoints mount to <code className="rounded bg-white/10 px-1 py-0.5">agents_checkpoints</code> volume.</li>
            </ul>
          </div>

          <div className="rounded-2xl border border-white/10 bg-slate-900/70 p-5 shadow-md">
            <div className="flex items-center gap-2">
              <ExternalLink className="h-5 w-5 text-indigo-200" />
              <h3 className="text-lg font-semibold">Entrypoints</h3>
            </div>
            <ul className="mt-3 space-y-2 text-sm text-slate-200/90">
              <li>UI dev: <code className="rounded bg-white/10 px-1 py-0.5">npm run dev</code> in <code className="rounded bg-white/10 px-1 py-0.5">src/agentic_ui</code>.</li>
              <li>Bridge: <code className="rounded bg-white/10 px-1 py-0.5">uvicorn main:app --reload --port 8002</code>.</li>
              <li>Agents: <code className="rounded bg-white/10 px-1 py-0.5">uvicorn main:app --reload --port 8003</code>.</li>
            </ul>
          </div>
        </section>

        <section className="rounded-2xl border border-white/10 bg-white/5 p-6 shadow-lg">
          <div className="flex items-center gap-2">
            <Workflow className="h-5 w-5 text-slate-100" />
            <h3 className="text-xl font-semibold">Deployment notes</h3>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            {deployment.map((item) => (
              <div key={item.title} className="rounded-xl border border-white/10 bg-slate-900/70 p-4">
                <p className="text-sm font-semibold text-slate-100">{item.title}</p>
                <p className="mt-2 text-sm text-slate-200/90">{item.detail}</p>
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
};

export default Architecture;
