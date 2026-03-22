# Deep Agents Component Map and Implementation Report

## Deep Agents architecture and what you get by default

Deep Agents are best understood as an “agent harness”: an opinionated wrapper around a standard tool-calling loop that bundles planning, a filesystem surface for context management, subagent delegation, and (optionally) long-term memory. citeturn2view7turn0search16turn4search0

Under the hood, the harness is implemented as modular middleware layers: each core capability (planning/todos, filesystem, subagents) is provided as middleware rather than being hard-coded into one monolith. This is why “Deep Agents capabilities” can be mixed, customized, or used independently when building custom agents. citeturn12search2turn5view2turn5view3turn5view4

A few practical implications follow from this harness model:

Deep Agents (Python) are LangGraph-native: `create_deep_agent` returns a compiled LangGraph graph, which means you can use LangGraph features like interrupt/resume, streaming, and persistence. citeturn1search10turn13view0turn1search23

The harness composes the final “prompt” from multiple sources: your custom system prompt (if any), a base harness prompt that teaches built-in tool use, and then additional chunks appended by middleware (todos, filesystem, subagents, HITL, skills, memory). This is why adding middleware isn’t just “adding tools”—it also injects usage guidance that trains the model to use them effectively. citeturn10view0turn5view2turn5view3turn5view4

The security stance is explicitly “trust the model, constrain the tools”: Deep Agents emphasize that an agent can do anything its tools allow; safety boundaries should be enforced at the tool/sandbox/backend layer rather than hoping the model self-polices. citeturn0search16turn12search6

## Filesystem, backends, and virtual vs persistent storage

### The filesystem tools are stable, but the backend decides where they operate

Deep Agents expose a filesystem surface through tools such as `ls`, `read_file`, `write_file`, `edit_file`, `glob`, and `grep`. These tools are “front-ends”; they delegate actual I/O to a pluggable backend. citeturn2view0turn10view0turn9view4

This directly answers your question about “do we need different filesystem tools if we switch to persistent storage?”:

You do **not** need different tools. You keep the same tools; you change the backend (or route prefixes to different backends). The middleware/tool interface remains the same while the storage target changes based on backend configuration and path prefixes. citeturn2view0turn5view3turn2view1turn9view3

### Built-in backends and what they mean

The official Python docs list several built-in backends, with a default of state-backed storage (ephemeral) unless you configure otherwise. citeturn2view0turn9view4turn7view4

**StateBackend (ephemeral, per-thread)**  
By default, the filesystem is stored in LangGraph state and only persists inside a single conversation thread. When the thread ends, these “files” are not automatically shared across unrelated threads. citeturn2view0turn2view1turn13view0

**FilesystemBackend (local disk)**  
Routes filesystem tools to a real directory on disk (under a configured `root_dir`). A notable option is `virtual_mode=True`, which normalizes/sandboxes paths under `root_dir` to reduce path traversal risk. citeturn9view4turn7view4

**StoreBackend (LangGraph Store)**  
Routes filesystem tools to LangGraph long-term storage so files can persist across threads. The backend is typically provided as a factory because it needs runtime objects (store). citeturn2view0turn7view4turn9view3turn13view0

**CompositeBackend (router / prefix routing)**  
Routes file operations to different backends based on path prefix (e.g., ephemeral state for `/workspace/…` and durable store for `/memories/…`). This is the canonical hybrid pattern to combine short-term and long-term file persistence in one logical namespace. citeturn9view3turn2view1turn5view3

### “Virtual filesystem” does not mean “fake”; it means “abstracted”
A “virtual filesystem” in Deep Agents is simply a consistent tool interface (`ls`, `read_file`, etc.) projected over whatever storage you choose: in-state (“thread-local”), local disk, LangGraph store, or a custom backend (S3/Postgres/etc.). The backend protocol specifies required operations (listing, reading, searching/grep, etc.). citeturn9view2turn9view0turn2view0

The backend protocol matters because it clarifies what you must implement if you want your own backend (e.g., S3, Postgres). The official guidelines emphasize absolute paths (e.g., `/x/y.txt`), efficient listing/globbing, user-readable error behavior, and correct “files_update” semantics (only in-state backends should return state updates; external persistence shouldn’t pretend to update LangGraph state directly). citeturn9view4turn9view2turn9view0

### Policy hooks for enterprise rules
Backends can be wrapped/subclassed to enforce rules such as “deny writes under certain prefixes” or other governance constraints. This is a safer and more reliable policy enforcement point than trying to enforce rules only in prompts. citeturn9view4turn0search16

### When `execute` exists (and when it doesn’t)
Deep Agents add an `execute` tool only when using a backend that supports code execution—specifically sandbox backends (and also LocalShellBackend on-host, which is explicitly dangerous). Without such a backend, your agent has filesystem tools but cannot run shell commands. citeturn10view0turn2view0turn7view4turn2view5

## Persistence model: checkpointer vs store vs “across chat”

### Short-term memory: checkpointer + thread_id
In LangGraph terms, “short-term memory” is thread-scoped state: message history and other stateful artifacts for a single conversation thread. This state is persisted via a **checkpointer**, so you can resume the same thread later (including interrupt/resume patterns). citeturn13view0turn1search23turn5view1

This is why human-in-the-loop requires a checkpointer: interrupts pause execution and rely on persisted state so the graph can resume safely. citeturn2view4turn5view1turn1search23

### Long-term memory: store + namespaces (cross-thread)
Long-term memory is explicitly cross-thread and stored in a **store**, scoped by namespaces rather than only thread IDs. This allows you to recall data “in any thread” and across sessions. citeturn13view0turn2view1turn5view3

In Deep Agents, the most direct “long-term memory” implementation is to route a filesystem prefix (typically `/memories/`) to a persistent backend (StoreBackend or FilesystemBackend), so saving a file at `/memories/preferences.md` makes it durable across threads. citeturn2view1turn5view3turn10view0

### The hybrid pattern you will use most in production
If you want both:
- ephemeral scratch space that’s cheap and thread-local, and
- durable memory that survives across conversations

the official pattern is:

Use a `CompositeBackend` where default routes to `StateBackend` and a prefix like `/memories/` routes to `StoreBackend`. citeturn2view1turn9view3turn5view3

This gives you a clear mental model:
- write drafts / large tool dumps to `/workspace/…` (ephemeral)
- write stable preferences / long-lived artifacts to `/memories/…` (persistent)

The same tools work; only the path prefix determines which backend handles the file. citeturn5view3turn9view3

### Context management beyond persistence (offloading + summarization)
Deep Agents also handle context blow-up via two additional strategies:

Offloading large tool inputs/results to the filesystem and replacing them in the active message history with file references/previews. This reduces prompt size while keeping information available via `read_file`/`grep`. citeturn10view0turn2view0

Automatic summarization when context approaches limits (with the original conversation preserved to the filesystem as a canonical record). Additionally, there is optional summarization tooling you can enable via middleware for agent-controlled summarization timing. citeturn10view0turn5view0

## AGENTS.md memory files and Skills: how they’re implemented

### AGENTS.md: always-loaded “memory” context
Deep Agents use AGENTS.md files as “memory files”: they are intended to provide extra context and conventions that should always be present when the agent runs. You supply these paths using the `memory=[...]` parameter. citeturn7view0turn6search16turn10view0

How AGENTS.md is physically provided depends on the backend:

**StateBackend**: you must seed the in-state filesystem by passing a `files={...}` dictionary at invocation time, using virtual absolute paths such as `"/AGENTS.md"`. citeturn7view0turn8view1

**StoreBackend**: you put the file data into the store (e.g., `store.put(namespace=("filesystem",), key="/AGENTS.md", value=...)`) and point the agent’s backend to `StoreBackend`. citeturn7view0turn2view1turn7view4

**FilesystemBackend**: you place an actual `AGENTS.md` file on disk and reference it via a filesystem path relative to `root_dir` (for example `./AGENTS.md`). citeturn7view0turn2view0

This “always loaded” vs “progressive disclosure” difference is crucial: memory files are always included, while skills are loaded only when relevant. citeturn10view0turn2view2

### Skills: progressively disclosed, folder-based capability packs
Skills are directories of folders, each containing `SKILL.md` plus optional code, docs, templates, or assets. The agent reads the frontmatter of each `SKILL.md` at startup, then loads the full content only when it decides the skill is useful (progressive disclosure). citeturn2view2turn8view0turn2view1

As with AGENTS.md, how you provide skills depends on the backend:

**StateBackend**: you pass skill files via `invoke(files={...})`, using virtual paths such as `"/skills/langgraph-docs/SKILL.md"`, and configure `skills=["/skills/"]`. citeturn8view1turn7view0

**StoreBackend**: you store `SKILL.md` under a store key like `"/skills/langgraph-docs/SKILL.md"` and set `skills=["/skills/"]`. citeturn8view2turn7view4

**FilesystemBackend**: you point `skills=[...]` at actual directories on disk (e.g., `skills=["/Users/user/{project}/skills/"]`). citeturn8view2turn2view0

A strong production guideline is: keep AGENTS.md small and stable, push large procedural details into skills (because skills are token-efficient by design). citeturn2view2turn10view0turn6search16

## Subagents, delegation, and context isolation

### What subagents are in Deep Agents
Deep Agents support subagents to delegate isolated multi-step tasks for two reasons:
- context isolation (avoid bloating the main context), and
- specialization (different instructions/tools/models per subagent). citeturn10view0turn5view4turn0search2

Operationally, the harness exposes a built-in `task` tool that lets the main agent spawn an ephemeral subagent, run it until completion, and receive back a single final result. Subagents are stateless in the sense that they do not continuously push messages back; they return a final report-like output. citeturn10view0turn4search0

### How to configure subagents
Subagents can be configured declaratively with fields like:
- `name`, `description`
- `system_prompt`
- `tools`
- optional `model`
- optional subagent-specific `middleware` citeturn5view4turn0search2

For more complex behavior, you can supply a prebuilt custom LangGraph graph by wrapping it in a `CompiledSubAgent`. citeturn5view4turn0search2

Deep Agents also provide a default `general-purpose` subagent designed specifically for “context quarantine”: delegate a complex task to it, get back a concise result, without pulling all intermediate tool logs into the supervisor’s main context window. citeturn5view4turn10view0

### Agent-specific context and tool branching
Two official patterns exist for agent-specific behavior with shared tools:

Branch tool behavior using `lc_agent_name` in the tool call metadata, so one tool behaves “strict” when called by a fact-checker subagent and more flexible otherwise. citeturn0search2turn5view4

Use namespaced context for agent-specific configuration, typically via a `context_schema` and invocation-time context payload, e.g. `fact-checker:strict_mode=True` or `researcher:max_results=10`. citeturn0search2turn11view0

## Middleware inventory, MCP tool attachment, and end-to-end composition

### Built-in middleware you should assume exists “today”
LangChain’s “Prebuilt middleware” catalog is the authoritative source for what’s production-ready and supported. At a high level it includes:

Summarization middleware for compressing long conversations. citeturn5view0turn10view0

Human-in-the-loop middleware for pausing tool calls with approve/edit/reject, requiring a checkpointer. citeturn5view1turn2view4turn13view0

Model call limit and tool call limit middleware for controlling cost and runaway loops; thread-level limits require persistence (checkpointer). citeturn2view8turn5view3turn5view1

Model fallback, model retry, and tool retry middleware for reliability. citeturn2view8turn5view3

PII detection middleware (and custom PII types) for redaction/handling. citeturn2view8turn5view1

To-do list middleware that adds the `write_todos` tool and planning instructions. citeturn5view2turn10view0

LLM tool selector and LLM tool emulator middleware for tool set reduction and testing. citeturn2view8turn0search7

Filesystem middleware (Deep Agents) for filesystem tools and for “short-term vs long-term filesystem” patterns via `CompositeBackend` + `StoreBackend`. citeturn5view3turn2view1turn9view3

Subagent middleware supporting both declarative subagents and compiled graphs. citeturn5view4turn0search2

Provider-specific middleware (examples include Anthropic prompt caching/bash/text editor/memory/file search middleware; OpenAI content moderation middleware; AWS prompt caching). citeturn5view4turn2view8

### Deep Agents “default stack” and what you override
The Deep Agents library/framework documentation explicitly describes that core harness features are attached automatically as middleware when you create a deep agent (planning/todos, filesystem, and subagents). In other words, **you generally should not manually “attach” these as external MCP tools**, and your filtering approach of reserving tool names like `write_todos`, filesystem tool names, and `task` is aligned with this philosophy. citeturn12search2turn5view3turn10view0turn12search7

### MCP: tools are “just tools,” but you can get richer behavior with sessions + interceptors
From a Deep Agents perspective, MCP tools are simply tools you can attach to the agent’s tool list. In LangChain, MCP tools can be loaded and passed into `create_agent` (or your wrapper) and behave like any other tool. citeturn11view0turn1search13

The MCP integration adds a few advanced capabilities that matter in agent systems:

Stateful MCP sessions: by default, tool calls are stateless (fresh MCP session per tool call), but you can manage a persistent `ClientSession` when you want a stateful server across tool calls. citeturn11view0turn1search13

Structured tool outputs: MCP tools can return structured content; LangChain wraps this into an artifact (`structuredContent` → `artifact`), which you can parse programmatically. citeturn11view0turn1search13

Tool interceptors: interceptors can access runtime context (`ToolRuntime`), including state, config, and store, enabling authentication gates, dynamic headers, retries, and memory access policies around MCP tools. citeturn11view0turn1search13

### Mapping the report concepts to your current server/agent template

Your current design already implements the critical “builder pattern” you described:

A `BaseAgent` validates config, holds `run_config` (including `thread_id`), filters MCP tools by cache keys, and attaches the resolved tool list to the instance. fileciteturn0file0

A `DeepAgent` extends `BaseAgent` to provide lazy `build()`, an `astream()` wrapper for streaming (plus your AG-UI normalization), and filters out reserved Deep Agents tool names (`write_todos`, filesystem tools, `execute`, `task`) so you do not duplicate built-ins via MCP. fileciteturn0file1

Your API endpoint creates an agent instance per request, loads MCP tools using an MCP session, attaches tools, and streams `agent.astream(...)` to the client via SSE. fileciteturn0file2

Where your stack is missing “official Deep Agents memory/skills semantics” is not in “tools parsing” but in **filesystem seeding and/or persistent backend + store wiring**:

If you keep default StateBackend semantics (thread-local virtual filesystem), you must pass `files={...}` in the invoke payload to seed `/AGENTS.md` and `/skills/.../SKILL.md`. That’s the documented mechanism for StateBackend. citeturn7view0turn8view1turn2view0

If you want persistence across threads, you need a `store` + `StoreBackend` (or `CompositeBackend` routing `/memories/` to `StoreBackend`). That is the documented long-term memory pattern. citeturn2view1turn9view3turn13view0

Finally, the checkpointer you create inside each DeepAgent instance (`MemorySaver()` in your current code) is not “cross-request persistence” if you instantiate a fresh agent per request. For true across-chat resume/HITL, the checkpointer must be shared and durable (application-scoped or external DB-backed), so a later request can resume the same thread’s checkpoints. citeturn2view4turn13view0turn1search23 fileciteturn0file1 fileciteturn0file2

In practice, the cleanest extension to your parent `DeepAgent` class is to add explicit hooks that declare:
- `memory_paths` and `skills_paths`
- `seed_files()` (for StateBackend mode)
- and optional `backend_factory` + shared `store` (for persistent mode)

This exactly mirrors how the official docs describe memory/skills being loaded with StateBackend vs StoreBackend vs FilesystemBackend. citeturn7view0turn8view2turn9view3