import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
    Database,
    ExternalLink,
    Network,
    Radio,
    Rocket,
    Server,
    ShieldCheck,
    Workflow,
    Wrench,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { StaticPageHeader } from "@/components/ui/static-page-header";

const tabs = [
    { id: "services", label: "Services", icon: Server },
    { id: "deployment", label: "Deployment", icon: Rocket },
    { id: "setup", label: "Setup", icon: Wrench },
    { id: "data", label: "Data Model", icon: Database },
];

const services = [
    {
        name: "Agentic UI",
        port: "8050",
        role: "React + Vite SPA served by nginx; proxies /api to the bridge and renders AG-UI streams, attachments, and preferences.",
        flow: "Auth/session cookies are issued by the bridge; every network hop stays on /api so the UI never talks directly to backends.",
        interfaces: [
            "Auth flow proxied to the bridge/Vault: /api/authenticate and /api/session/refresh.",
            "Chat lifecycle: /api/users/:id/conversations + /messages + /attachments (multipart uploads).",
            "Inference runs: /api/v1/inference/runs starts, observes, and cancels agent streams.",
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
            "Inference: /inference/runs/:userId/:conversationId starts runs; /runs/:userId/:runId/stream observes AG-UI events.",
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
        interfaces: ["Chroma HTTP API for collection management and similarity search."],
        data: "Embeddings persist to the vectorstore bind mount; lives on the internal backend network.",
    },
    {
        name: "Chat Postgres",
        port: "5432",
        role: "Primary datastore for users, agent manifests, conversations, messages, reactions, and attachment blobs.",
        flow: "Accessed only by the dialogue bridge via SQLAlchemy/asyncpg; cascades remove messages/attachments on conversation delete.",
        interfaces: ["PostgreSQL protocol only; no public HTTP surface."],
        data: "chat_convs volume stores the data directory. Credentials default to admin/admin in Compose.",
    },
    {
        name: "Vault",
        port: "8004",
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
    "Inference: UI starts an inference run, observes its run stream, and can cancel it; bridge rebuilds history with inline images, sets thread/checkpoint ids, and forwards to agents /stream with tool preferences.",
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
            "VAULT_URL, VAULT_USERPASS_MOUNT, VAULT_OIDC_ROLE to talk to Vault (when enabled).",
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

const ease: [number, number, number, number] = [0.22, 1, 0.36, 1];

function stagger(i: number, base = 0.06) {
    return { duration: 0.35, delay: i * base, ease };
}

export default function Architecture() {
    const [activeTab, setActiveTab] = useState<string>("services");
    const shouldReduce = useReducedMotion();

    return (
        <div className="min-h-screen bg-background">
            <StaticPageHeader icon={<Radio size={18} />} title="System Architecture" />

            <main className="mx-auto w-full max-w-5xl space-y-6 px-4 py-10 sm:px-6">
                {/* Hero */}
                <motion.section
                    initial={shouldReduce ? false : { opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.45, ease }}
                    className="relative overflow-hidden rounded-3xl border border-border bg-card p-8"
                >
                    <div className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-primary/6 blur-3xl" />
                    <div className="flex flex-wrap items-start justify-between gap-6">
                        <div className="space-y-2">
                            <p className="text-[0.65rem] font-bold uppercase tracking-[0.2em] text-primary">
                                Overview
                            </p>
                            <h2 className="text-2xl font-semibold tracking-tight text-foreground">
                                How the pieces fit together
                            </h2>
                            <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
                                The UI talks only to the dialogue bridge. The bridge authenticates via Vault, persists
                                conversations and attachments in Postgres, proxies inference to the agents service, and
                                fetches MCP tools through the agents service. Agents stream LangGraph AG-UI frames, call
                                the RAG microservice for retrieval/analytics, and discover extra tools through the MCP
                                gateway.
                            </p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            <span className="rounded-xl border border-border bg-muted px-3 py-1.5 text-xs font-semibold text-muted-foreground">
                                React + FastAPI + LangGraph
                            </span>
                            <span className="rounded-xl border border-border bg-muted px-3 py-1.5 text-xs font-semibold text-muted-foreground">
                                SSE Streams
                            </span>
                        </div>
                    </div>
                </motion.section>

                {/* Tabs */}
                <motion.div
                    initial={shouldReduce ? false : { opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.35, delay: 0.1, ease }}
                    className="flex flex-wrap gap-2 rounded-2xl border border-border bg-card p-2"
                >
                    {tabs.map((tab) => {
                        const Icon = tab.icon;
                        const isActive = activeTab === tab.id;
                        return (
                            <button
                                key={tab.id}
                                type="button"
                                onClick={() => setActiveTab(tab.id)}
                                className={cn(
                                    "inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
                                    isActive
                                        ? "bg-primary/10 text-primary"
                                        : "text-muted-foreground hover:bg-muted hover:text-foreground"
                                )}
                            >
                                <Icon className="h-4 w-4" />
                                {tab.label}
                            </button>
                        );
                    })}
                </motion.div>

                {/* Tab content */}
                <AnimatePresence mode="wait">
                    <motion.div
                        key={activeTab}
                        initial={shouldReduce ? false : { opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={shouldReduce ? undefined : { opacity: 0, y: -6 }}
                        transition={{ duration: 0.28, ease }}
                        className="space-y-6"
                    >
                        {activeTab === "services" && (
                            <>
                                <div className="grid gap-4 lg:grid-cols-2">
                                    {services.map((svc, i) => (
                                        <motion.article
                                            key={svc.name}
                                            initial={shouldReduce ? false : { opacity: 0, y: 14 }}
                                            animate={{ opacity: 1, y: 0 }}
                                            transition={stagger(i, 0.04)}
                                            whileHover={shouldReduce ? undefined : { y: -1 }}
                                            className="group relative overflow-hidden rounded-2xl border border-border bg-card p-5 transition-shadow duration-300 hover:shadow-elegant"
                                        >
                                            <div className="absolute inset-y-3 left-0 w-[3px] rounded-full bg-primary opacity-0 transition-opacity duration-300 group-hover:opacity-60" />
                                            <div className="flex items-start gap-3">
                                                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                                                    <Server className="h-4 w-4" />
                                                </div>
                                                <div className="min-w-0">
                                                    <div className="flex flex-wrap items-center gap-2">
                                                        <h3 className="text-sm font-semibold text-foreground">
                                                            {svc.name}
                                                        </h3>
                                                        <span className="rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-[0.6rem] font-bold text-primary">
                                                            :{svc.port}
                                                        </span>
                                                    </div>
                                                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                                                        {svc.role}
                                                    </p>
                                                    <p className="mt-1 text-xs text-muted-foreground/70">
                                                        {svc.flow}
                                                    </p>
                                                </div>
                                            </div>
                                            <div className="mt-4 grid gap-3 sm:grid-cols-2">
                                                <div>
                                                    <p className="mb-1.5 text-[0.6rem] font-bold uppercase tracking-[0.18em] text-muted-foreground">
                                                        Interfaces
                                                    </p>
                                                    <ul className="space-y-1">
                                                        {svc.interfaces.map((item) => (
                                                            <li
                                                                key={item}
                                                                className="flex gap-2 text-xs text-muted-foreground"
                                                            >
                                                                <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-primary/50" />
                                                                {item}
                                                            </li>
                                                        ))}
                                                    </ul>
                                                </div>
                                                <div>
                                                    <p className="mb-1.5 text-[0.6rem] font-bold uppercase tracking-[0.18em] text-muted-foreground">
                                                        Data & deps
                                                    </p>
                                                    <p className="text-xs leading-relaxed text-muted-foreground">
                                                        {svc.data}
                                                    </p>
                                                </div>
                                            </div>
                                        </motion.article>
                                    ))}
                                </div>

                                <div className="rounded-2xl border border-border bg-card p-6">
                                    <div className="mb-5 flex items-center gap-3">
                                        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
                                            <Workflow className="h-4 w-4" />
                                        </div>
                                        <div>
                                            <p className="text-[0.65rem] font-bold uppercase tracking-[0.18em] text-primary">
                                                Runtime
                                            </p>
                                            <h3 className="text-base font-semibold text-foreground">
                                                Request lifecycle
                                            </h3>
                                        </div>
                                    </div>
                                    <div className="grid gap-3 sm:grid-cols-2">
                                        {requestFlow.map((step, idx) => (
                                            <motion.div
                                                key={step}
                                                initial={shouldReduce ? false : { opacity: 0, y: 10 }}
                                                animate={{ opacity: 1, y: 0 }}
                                                transition={stagger(idx, 0.05)}
                                                className="flex gap-3 rounded-xl border border-border bg-muted/30 p-4"
                                            >
                                                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[0.65rem] font-bold text-primary">
                                                    {idx + 1}
                                                </span>
                                                <p className="text-xs leading-relaxed text-muted-foreground">{step}</p>
                                            </motion.div>
                                        ))}
                                    </div>
                                </div>

                                <div className="grid gap-4 lg:grid-cols-3">
                                    {[
                                        {
                                            icon: <ShieldCheck className="h-4 w-4" />,
                                            title: "Security & Auth",
                                            items: [
                                                "Vault userpass → OIDC JWT; cookies managed by the bridge.",
                                                "Bridge validates JWT on every protected route; enforces user/resource ownership.",
                                                "MCP gateway secrets live in src/mcp_gateway/mcp_secret.env.",
                                            ],
                                        },
                                        {
                                            icon: <Network className="h-4 w-4" />,
                                            title: "Data & Storage",
                                            items: [
                                                "Postgres stores users, conversations, messages, attachments (blob table).",
                                                "Chroma volume at src/vectorstores/chroma_db_openai.",
                                                "Agents keep LangGraph checkpoints in-memory per run (no volume mount).",
                                            ],
                                        },
                                        {
                                            icon: <ExternalLink className="h-4 w-4" />,
                                            title: "Entrypoints",
                                            items: [
                                                "UI dev: npm run dev in src/agentic_ui.",
                                                "Bridge: uvicorn main:app --reload --port 8002.",
                                                "Agents: uvicorn main:app --reload --port 8003.",
                                            ],
                                        },
                                    ].map((card, i) => (
                                        <motion.div
                                            key={card.title}
                                            initial={shouldReduce ? false : { opacity: 0, y: 14 }}
                                            animate={{ opacity: 1, y: 0 }}
                                            transition={stagger(i, 0.08)}
                                            className="rounded-2xl border border-border bg-card p-5"
                                        >
                                            <div className="mb-3 flex items-center gap-2">
                                                <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary/10 text-primary">
                                                    {card.icon}
                                                </div>
                                                <h4 className="text-sm font-semibold text-foreground">
                                                    {card.title}
                                                </h4>
                                            </div>
                                            <ul className="space-y-2">
                                                {card.items.map((item) => (
                                                    <li key={item} className="flex gap-2 text-xs text-muted-foreground">
                                                        <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-primary/50" />
                                                        {item}
                                                    </li>
                                                ))}
                                            </ul>
                                        </motion.div>
                                    ))}
                                </div>
                            </>
                        )}

                        {activeTab === "deployment" && (
                            <div className="space-y-6">
                                <div className="rounded-2xl border border-border bg-card p-6">
                                    <div className="mb-5 flex items-center gap-3">
                                        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
                                            <Rocket className="h-4 w-4" />
                                        </div>
                                        <h3 className="text-base font-semibold text-foreground">
                                            Deployment options
                                        </h3>
                                    </div>
                                    <div className="grid gap-3 sm:grid-cols-3">
                                        {deployment.map((item, i) => (
                                            <motion.div
                                                key={item.title}
                                                initial={shouldReduce ? false : { opacity: 0, y: 12 }}
                                                animate={{ opacity: 1, y: 0 }}
                                                transition={stagger(i, 0.07)}
                                                className="rounded-xl border border-border bg-muted/30 p-4"
                                            >
                                                <p className="text-xs font-semibold text-foreground">{item.title}</p>
                                                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                                                    {item.detail}
                                                </p>
                                            </motion.div>
                                        ))}
                                    </div>
                                </div>

                                <div className="grid gap-4 lg:grid-cols-2">
                                    {[
                                        {
                                            title: "Compose specifics",
                                            items: [
                                                "Primary file: src/docker-compose.yaml.",
                                                "Networks: backend (internal) and frontend.",
                                                "Volumes: vectorstore (Chroma), chat_convs (Postgres); agent checkpoints are in-memory.",
                                                "Optional Vault: src/docker-compose-hashicorp.yaml (exposes 8004).",
                                            ],
                                        },
                                        {
                                            title: "Ports to know",
                                            items: [
                                                "Agentic UI: 8050 (nginx).",
                                                "Dialogue Bridge: 8002.",
                                                "Agents: 8003.",
                                                "RAG Service: 8001.",
                                                "Chroma: 8000 (internal only).",
                                                "MCP Gateway: 8005 (SSE catalog).",
                                                "Vault: 8004 (when enabled).",
                                            ],
                                        },
                                    ].map((card, i) => (
                                        <motion.div
                                            key={card.title}
                                            initial={shouldReduce ? false : { opacity: 0, y: 14 }}
                                            animate={{ opacity: 1, y: 0 }}
                                            transition={stagger(i, 0.1)}
                                            className="rounded-2xl border border-border bg-card p-5"
                                        >
                                            <h4 className="mb-3 text-sm font-semibold text-foreground">
                                                {card.title}
                                            </h4>
                                            <ul className="space-y-2">
                                                {card.items.map((item) => (
                                                    <li key={item} className="flex gap-2 text-xs text-muted-foreground">
                                                        <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-primary/50" />
                                                        {item}
                                                    </li>
                                                ))}
                                            </ul>
                                        </motion.div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {activeTab === "setup" && (
                            <div className="rounded-2xl border border-border bg-card p-6">
                                <div className="mb-5 flex items-center gap-3">
                                    <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
                                        <Wrench className="h-4 w-4" />
                                    </div>
                                    <h3 className="text-base font-semibold text-foreground">Setup checklist</h3>
                                </div>
                                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                                    {setupSections.map((section, i) => (
                                        <motion.div
                                            key={section.title}
                                            initial={shouldReduce ? false : { opacity: 0, y: 14 }}
                                            animate={{ opacity: 1, y: 0 }}
                                            transition={stagger(i, 0.1)}
                                            className="overflow-hidden rounded-xl border border-border bg-muted/30 p-4"
                                        >
                                            <p className="mb-2 text-xs font-semibold text-foreground">
                                                {section.title}
                                            </p>
                                            <ul className="space-y-2">
                                                {section.bullets.map((item) => (
                                                    <li
                                                        key={item}
                                                        className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground"
                                                    >
                                                        <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-primary/50" />
                                                        <span className="min-w-0 break-words">{item}</span>
                                                    </li>
                                                ))}
                                            </ul>
                                        </motion.div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {activeTab === "data" && (
                            <div className="space-y-6">
                                <div className="rounded-2xl border border-border bg-card p-6">
                                    <div className="mb-5 flex items-center gap-3">
                                        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
                                            <Database className="h-4 w-4" />
                                        </div>
                                        <h3 className="text-base font-semibold text-foreground">
                                            Database schema (Postgres)
                                        </h3>
                                    </div>
                                    <div className="grid gap-3 md:grid-cols-2">
                                        {dataModel.map((item, i) => (
                                            <motion.div
                                                key={item.name}
                                                initial={shouldReduce ? false : { opacity: 0, y: 12 }}
                                                animate={{ opacity: 1, y: 0 }}
                                                transition={stagger(i, 0.06)}
                                                className="group relative overflow-hidden rounded-xl border border-border bg-muted/30 p-4 transition-shadow duration-300 hover:shadow-card"
                                            >
                                                <div className="absolute inset-y-2 left-0 w-[3px] rounded-full bg-primary opacity-0 transition-opacity duration-300 group-hover:opacity-60" />
                                                <p className="text-[0.65rem] font-bold uppercase tracking-[0.18em] text-primary">
                                                    {item.name}
                                                </p>
                                                <p className="mt-2 text-xs leading-relaxed text-foreground">
                                                    {item.fields}
                                                </p>
                                                <p className="mt-2 text-xs text-muted-foreground">{item.notes}</p>
                                            </motion.div>
                                        ))}
                                    </div>
                                </div>

                                <motion.div
                                    initial={shouldReduce ? false : { opacity: 0, y: 12 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{ delay: 0.3, duration: 0.35, ease }}
                                    className="rounded-2xl border border-border bg-card p-5"
                                >
                                    <h4 className="mb-3 text-sm font-semibold text-foreground">
                                        Relationships to remember
                                    </h4>
                                    <ul className="space-y-2">
                                        {[
                                            "users 1:N conversations; conversations 1:N messages (ordered asc by created_at).",
                                            "messages N:1 parent_message_id for threading; each message 0:N attachments.",
                                            "attachments 1:1 blobs; deleting conversations cascades to messages and blobs.",
                                            "agents 1:N conversations; agents list is refreshed from the agents service.",
                                            "user_preferences 1:1 users (tools JSON, prefers_agentic_chat flag).",
                                        ].map((rel) => (
                                            <li key={rel} className="flex gap-2 text-xs text-muted-foreground">
                                                <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-primary/50" />
                                                {rel}
                                            </li>
                                        ))}
                                    </ul>
                                </motion.div>
                            </div>
                        )}
                    </motion.div>
                </AnimatePresence>
            </main>
        </div>
    );
}
