# Building Fully-Customized Deep Agents in LangChain

## What a Deep Agent is in the LangChain ecosystem

A Deep Agent is best understood as a **batteries-included agent “harness”** that returns a **compiled LangGraph graph** (so you can use LangGraph features such as streaming, checkpointing, and interrupts) while shipping an opinionated default stack: planning (TODOs), file-based context offloading (a filesystem surface), and sub-agent delegation. citeturn9search0turn6search3turn10view0

Concretely, `create_deep_agent(...)` assembles a LangChain `create_agent(...)` under the hood and wires a default middleware stack that teaches the model how to:
- plan using a TODO list tool,
- store and retrieve context via filesystem tools,
- delegate multi-step work to subagents (and keep the supervisor context small),
- keep long conversations manageable via summarization,
- optionally apply human approval gates on tool calls (“human-in-the-loop”). citeturn10view0turn5view2turn27view0

A key design choice is that the Deep Agent’s “filesystem” is **not inherently “fake”**—it is an **abstracted path interface** (`/notes.md`, `/memories/preferences.txt`, etc.) exposed to the LLM via tools (`ls`, `read_file`, `write_file`, `edit_file`, `glob`, `grep`). The same tool surface can be backed by:
- ephemeral in-state storage,
- local disk,
- durable LangGraph stores,
- routed composites (hybrids),
- or custom virtual backends (S3/Postgres/etc). citeturn12view0turn14view0turn10view1

## The complete customization surface of `create_deep_agent`

As currently implemented in the Deep Agents SDK, `create_deep_agent` exposes (at least) the following top-level parameters, and these are the **core knobs** you can use to build “deep” multi-agent systems without rewriting the harness. citeturn10view0

### Identity, reasoning, and output shaping

**`system_prompt`**  
Prepended/combined with the Deep Agent base prompt (the Deep Agents SDK ships a built-in base prompt with operational guidance). Use this for **your app-specific policy**, style, workflow rules, and domain constraints—without re-implementing planning/subagents/filesystem instructions yourself. citeturn10view0turn21view0

**`response_format`**  
Enables **structured output** for the *agent’s final response* (validated and returned under a structured key in agent state in LangChain agents). In practice this is how you get “must be JSON/dict/dataclass/Pydantic” behavior, rather than parsing natural language. citeturn26search0turn10view0

Example (schema-first agent output):
```python
from dataclasses import dataclass
from deepagents import create_deep_agent

@dataclass
class FinalAnswer:
    summary: str
    risk_level: str  # e.g. "low" | "medium" | "high"
    next_actions: list[str]

agent = create_deep_agent(
    response_format=FinalAnswer,
    system_prompt="Return a structured response that is directly usable by downstream code."
)
```
citeturn10view0turn26search0

**`context_schema`**  
Defines a typed **runtime context object** you can pass at invocation time (e.g., authenticated user info, org policy tier, tenant id). This is how you thread “enterprise context” through tool selection, backend namespace, policy checks, etc. citeturn10view0turn9search1turn18search2

Minimal example:
```python
from dataclasses import dataclass
from deepagents import create_deep_agent

@dataclass
class Context:
    user_id: str
    org_tier: str

agent = create_deep_agent(context_schema=Context)

result = agent.invoke(
    {"messages": [{"role": "user", "content": "What can I do?"}]},
    context=Context(user_id="u_123", org_tier="enterprise"),
)
```
citeturn10view0turn18search2

### Model and tool layer

**`model`**  
Accepts either a model instance or a provider string. Deep Agents requires **tool-calling capability**. The SDK defaults to an Anthropic model if you don’t supply one; production systems should always set it explicitly. citeturn10view0turn6search3turn21view0

**`tools`**  
Your custom tools, merged with Deep Agents built-ins (planning/filesystem/subagent spawning, and execution if the backend supports it). You typically add domain tools here (search, DB, Slack, ticketing, etc.). citeturn10view0turn21view0turn28view0

### Subagents and delegation

**`subagents`**  
List of subagent specs (each with its own `name`, `description`, `system_prompt`, and optionally tool/model/middleware overrides). Deep Agents also adds a “general purpose” subagent unless you override it. This is central for: **context quarantine**, parallelism, specialization, and “deep work” that shouldn’t bloat the supervisor’s thread. citeturn10view0turn21view0turn28view0

A real official example (Deep Research) defines a dedicated research subagent:
```python
research_sub_agent = {
  "name": "research-agent",
  "description": "Delegate research to the sub-agent researcher. Only give this researcher one topic at a time.",
  "system_prompt": "...",
  "tools": [tavily_search, think_tool],
}

agent = create_deep_agent(
  model=model,
  tools=[tavily_search, think_tool],
  system_prompt=INSTRUCTIONS,
  subagents=[research_sub_agent],
)
```
citeturn21view0

**`async_subagents`**  
Optional list of “async/remote” subagent specs that run as **background jobs** (queue-like semantics) with lifecycle tools (launch/check/cancel/list). This is the knob for pushing heavy work off-thread or onto remote deployments, while still managing them via the Deep Agent harness. citeturn10view0

### Storage and persistence

**`backend`**  
This is the **filesystem backend**: the pluggable implementation behind `ls/read_file/write_file/edit_file/glob/grep` and (optionally) `execute`. It accepts either:
- a backend instance implementing `BackendProtocol`, or
- a **backend factory** `Callable[[ToolRuntime], BackendProtocol]` for backends that need runtime context (like store access). citeturn12view0turn14view0turn10view1turn10view0

**`store`**  
A LangGraph `BaseStore` used for **durable cross-thread persistence** (required if your backend is `StoreBackend`, and commonly used via `CompositeBackend` to persist only `/memories/*`). In hosted deployments, a store may be provisioned by the platform and you omit `store=` in code. citeturn12view0turn14view0turn28view0turn11view3

**`checkpointer`**  
Checkpointing is about **thread continuity and resumability**: it persists agent state across turns and is mandatory for human-in-the-loop interrupts (because you must resume *the same state*). It is conceptually different from `store` (store is for durable “files/knowledge,” checkpointer is for “execution state and conversation continuity”). citeturn27view0turn28view0turn10view0

### Human approval and reliability

**`interrupt_on`**  
The Deep Agents SDK exposes human-in-the-loop approval by mapping tool names to interrupt configurations (allow approve/edit/reject per tool). This requires a checkpointer and stable thread ids across resumes. citeturn27view0turn10view0

**`middleware`**  
You can append custom middleware after the default stack. This is the primary “enterprise customization” mechanism: add guardrails, logging, retries, PII filtering, summarization strategy, tool selection strategies, etc. citeturn10view0turn5view2

### Debugging and performance knobs

**`debug`**, **`name`**, **`cache`**  
Passed through to the underlying LangChain agent creation. `cache` (a LangGraph cache) is a lever for cost/latency reduction in repeated calls, `name` is useful for labeling/tracing/metadata, and `debug` enables additional internal diagnostics. citeturn10view0turn5view2

## Storage, “virtual filesystem,” long-term memory, and enterprise policy hooks

### The precise meaning of “virtual filesystem”

In Deep Agents, “filesystem” means: **a namespace of absolute paths** (e.g. `/drafts/post.md`, `/memories/preferences.txt`) that the model can manipulate via tools. The filesystem is “virtual” because the *path interface is abstract*, not because it is “fake.” The same path surface can map to different underlying storage implementations (state, disk, store, S3, DB). citeturn12view0turn14view0turn10view1

This abstraction is what enables:
- **ephemeral scratchpads** for large intermediate results (avoid context window overflow),
- **durable memory** across chats/threads (store-backed),
- **policy enforcement** at the storage boundary (deny writes/edits, path allowlists),
- **tenancy isolation** by routing/namespacing. citeturn28view0turn14view0turn11view3

### Built-in backends and when to use them

**StateBackend (ephemeral, per-thread)**  
Default. Stores files in LangGraph agent state for the current thread; great for scratchpads and tool output offloading. citeturn12view0turn14view0turn28view0

**FilesystemBackend (local disk)**  
Reads/writes real files under a configurable `root_dir`. It can be set to `virtual_mode=True` for stable virtual path semantics and to block path traversal; however, this is not full sandboxing. This backend is powerful but dangerous in server contexts; it’s recommended for controlled environments. citeturn14view0turn10view2

**LocalShellBackend (local shell execution)**  
Adds host shell execution; extremely risky outside local dev because it runs commands on your machine. citeturn14view0

**StoreBackend (durable store)**  
Stores files in a LangGraph `BaseStore` (durable, cross-thread). The backend uses a namespace scheme and supports storage formats; it requires a store available in the runtime. citeturn12view0turn11view3turn28view0

**CompositeBackend (router / hybrid storage)**  
Routes paths by prefix (e.g. `/memories/` persisted, everything else ephemeral). This is the canonical “short-term vs long-term filesystem” pattern. citeturn12view0turn28view0turn11view0

### Long-term memory across chats: store vs checkpointer (and why you usually need both)

A correct production mental model is:

- **Checkpointer**: makes the *current conversation/execution thread* resumable (multi-turn continuity, interrupts, time travel). citeturn27view0turn28view0  
- **Store** (via StoreBackend): makes *selected files* durable across threads/sessions (true long-term memory). citeturn28view0turn11view3  
- **CompositeBackend**: ties these together by routing durable paths (commonly `/memories/`) to the store while leaving scratchpad paths ephemeral. citeturn28view0turn11view0

Official long-term memory setup:
```python
from deepagents import create_deep_agent
from deepagents.backends import CompositeBackend, StateBackend, StoreBackend
from langgraph.store.memory import InMemoryStore
from langgraph.checkpoint.memory import MemorySaver

checkpointer = MemorySaver()

def make_backend(runtime):
    return CompositeBackend(
        default=StateBackend(runtime),          # Ephemeral (thread-only)
        routes={"/memories/": StoreBackend(runtime)}  # Persistent (cross-thread)
    )

agent = create_deep_agent(
    store=InMemoryStore(),   # dev; omit in hosted deployments that provision a store
    backend=make_backend,
    checkpointer=checkpointer,
)
```
citeturn28view0turn12view0turn11view0turn11view3

### Implementing a real “virtual filesystem” backend (S3/Postgres)

Deep Agents documents the contract: you implement `BackendProtocol` (for `ls/read/grep/glob/write/edit`, plus upload/download and optional execute if you implement the sandbox protocol). This is how you map `/x/y.txt` to your storage keys/rows and enforce your own invariants. citeturn10view1turn14view0

Skeleton (S3-style outline):
```python
from deepagents.backends.protocol import BackendProtocol, WriteResult, EditResult

class S3Backend(BackendProtocol):
    def __init__(self, bucket: str, prefix: str = ""):
        self.bucket = bucket
        self.prefix = prefix.rstrip("/")

    def _key(self, path: str) -> str:
        return f"{self.prefix}{path}"

    def ls_info(self, path: str):
        ...

    def read(self, file_path: str, offset: int = 0, limit: int = 2000):
        ...

    def grep_raw(self, pattern: str, path: str | None = None, glob: str | None = None):
        ...

    def glob_info(self, pattern: str, path: str = "/"):
        ...

    def write(self, file_path: str, content: str) -> WriteResult:
        # For external persistence backends: files_update=None
        return WriteResult(path=file_path, files_update=None)

    def edit(self, file_path: str, old_string: str, new_string: str, replace_all: bool = False) -> EditResult:
        ...
```
citeturn14view0turn10view1

### Enterprise rules: policy hooks at the backend boundary

Deep Agents explicitly recommends enforcing “enterprise rules” by **wrapping or subclassing** a backend and blocking/rewriting operations (deny prefixes, read-only areas, audit trails). citeturn14view0

Subclass example (deny writes/edits under protected prefixes):
```python
from deepagents.backends.filesystem import FilesystemBackend
from deepagents.backends.protocol import WriteResult, EditResult

class GuardedBackend(FilesystemBackend):
    def __init__(self, *, deny_prefixes: list[str], **kwargs):
        super().__init__(**kwargs)
        self.deny_prefixes = [p if p.endswith("/") else p + "/" for p in deny_prefixes]

    def write(self, file_path: str, content: str) -> WriteResult:
        if any(file_path.startswith(p) for p in self.deny_prefixes):
            return WriteResult(error=f"Writes are not allowed under {file_path}")
        return super().write(file_path, content)

    def edit(self, file_path: str, old_string: str, new_string: str, replace_all: bool = False) -> EditResult:
        if any(file_path.startswith(p) for p in self.deny_prefixes):
            return EditResult(error=f"Edits are not allowed under {file_path}")
        return super().edit(file_path, old_string, new_string, replace_all)
```
citeturn14view0turn10view2

Wrapper example (backend-agnostic policy wrapper) is also documented. citeturn14view0

## Skills and `AGENTS.md`: how “skills” and “memory” really work

Deep Agents distinguishes two related but different concepts:

### `memory` sources (`AGENTS.md`)

The `memory=[...]` parameter points to one or more `AGENTS.md` files that are loaded at agent startup and injected into the system prompt as persistent guidance (“identity,” “operating rules,” “brand voice,” “project instructions,” etc.). Paths are resolved relative to the backend root (and are virtual paths under state-backed backends). citeturn10view0turn25view0turn22view0

Two official examples use this pattern explicitly:
- Text-to-SQL example: `memory=["./AGENTS.md"]` citeturn22view0  
- Content Builder example: `memory=["./AGENTS.md"]` citeturn25view0  

### Skills (`skills/*/SKILL.md`) and the “progressive disclosure” model

Skills are directories containing one or more skill folders. Each skill folder contains a `SKILL.md` with frontmatter metadata + instructions; skills may also include scripts/docs/assets referenced by the `SKILL.md`. The agent loads frontmatter at startup and only loads full skill contents when relevant (“progressive disclosure”). citeturn29view0turn29view1

A canonical skill structure:
```text
skills/
├── langgraph-docs/
│   └── SKILL.md
└── arxiv_search/
    ├── SKILL.md
    └── arxiv_search.py
```
citeturn29view0turn29view1

An official `SKILL.md` pattern (frontmatter + instructions) is documented, including optional metadata fields like `allowed-tools`. citeturn29view1

### Skill paths and why POSIX paths matter

Deep Agents expects skill source paths to be specified in POSIX form (forward slashes) and treats them as paths relative to the backend’s root. With the default StateBackend you typically **seed the “filesystem” state** at invoke time. citeturn10view0turn29view1

Official example: seeding skills into the StateBackend using `files={...}` and `create_file_data`:
```python
from urllib.request import urlopen
from deepagents import create_deep_agent
from deepagents.backends.utils import create_file_data
from langgraph.checkpoint.memory import MemorySaver

checkpointer = MemorySaver()

skill_url = "https://raw.githubusercontent.com/langchain-ai/deepagents/refs/heads/main/libs/cli/examples/skills/langgraph-docs/SKILL.md"
with urlopen(skill_url) as response:
    skill_content = response.read().decode("utf-8")

skills_files = {
    "/skills/langgraph-docs/SKILL.md": create_file_data(skill_content)
}

agent = create_deep_agent(
    skills=["/skills/"],
    checkpointer=checkpointer,
)

result = agent.invoke(
    {
        "messages": [{"role": "user", "content": "What is langgraph?"}],
        # Seed StateBackend’s filesystem
        "files": skills_files,
    },
    config={"configurable": {"thread_id": "12345"}},
)
```
citeturn29view1

This is the practical bridge between:
- **virtual FS** (StateBackend: you must provide file state), and
- **persistent FS** (FilesystemBackend: files come from disk; StoreBackend: files come from store). citeturn14view0turn12view0turn11view3

### Skills vs memory: when to use each

A reliable rule is:
- Use **`AGENTS.md`** (`memory=[...]`) for always-on system-level guidance (identity, policy, project constraints). citeturn25view0turn22view0turn10view0  
- Use **skills** for **task-specific workflows** that should only be loaded when needed (reduce prompt bloat; keep the agent “lean” until the skill matches). citeturn29view0turn29view1turn25view0  

## Tools, subagents, middleware, MCP, and human approval

### Tools: local functions, domain APIs, and MCP servers are all “tools”

Deep Agents treats your tools the same way LangChain agents do: you pass a list of tools/functions, and the agent chooses them during execution. Deep Agents then adds its built-ins (planning/filesystem/subagents). citeturn10view0turn21view0turn12view0

**MCP integration**: MCP tools can be loaded from one or more MCP servers using `langchain-mcp-adapters`, then passed into an agent (including Deep Agents) as tools. The official docs show MCP tools being loaded with `MultiServerMCPClient` and used in a LangChain agent; the same `tools` list can be passed to `create_deep_agent`. citeturn15view0turn15view2turn10view0

Example (MCP tools → Deep Agent):
```python
import asyncio
from deepagents import create_deep_agent
from langchain_mcp_adapters.client import MultiServerMCPClient

async def build_agent():
    client = MultiServerMCPClient(
        {
            "math": {
                "transport": "stdio",
                "command": "python",
                "args": ["/abs/path/to/math_server.py"],
            },
            "weather": {
                "transport": "http",
                "url": "http://localhost:8000/mcp",
            },
        }
    )
    mcp_tools = await client.get_tools()

    agent = create_deep_agent(
        tools=mcp_tools,
        system_prompt="Use MCP tools when they provide authoritative information.",
    )
    return agent

if __name__ == "__main__":
    asyncio.run(build_agent())
```
citeturn15view0turn15view2turn10view0

### Subagents: specialization, context quarantine, and “queue-like” background jobs

Deep Agents’ `task` tool allows the supervisor to hand off independent multi-step tasks to subagents with isolated context and (optionally) narrower toolsets. The official Deep Research example uses a dedicated researcher subagent to do focused research, then return a clean summary. citeturn21view0turn28view0

Deep Agents also supports **background-job-style** subagents via `async_subagents`, allowing long-running tasks to run asynchronously and be polled/cancelled. This is the closest built-in concept to a “queue” in the Deep Agents harness itself. citeturn10view0

### Middleware: the real “enterprise customization layer”

Deep Agents’ default harness is largely implemented as middleware. The SDK composes a default stack that includes (among others) TODO planning, filesystem, subagents, summarization, prompt caching, and tool-call patching; then it allows you to append your custom middleware afterward. citeturn10view0turn5view2

Separately, LangChain provides a broad set of production-ready middleware components (provider-agnostic) such as:
- Summarization middleware (token-limit management),
- Human-in-the-loop middleware,
- model/tool call limits,
- model fallback and retry,
- tool retry,
- PII detection,
- context editing,
- filesystem and subagent middleware building blocks, etc. citeturn5view2

Example (LangChain summarization middleware pattern):
```python
from langchain.agents import create_agent
from langchain.agents.middleware import SummarizationMiddleware

agent = create_agent(
    model="gpt-4.1",
    tools=[...],
    middleware=[
        SummarizationMiddleware(
            model="gpt-4.1-mini",
            trigger=("tokens", 4000),
            keep=("messages", 20),
        ),
    ],
)
```
citeturn5view2

### Human-in-the-loop: interrupts, decisions, approvals, and edits

Deep Agents exposes HITL via `interrupt_on={tool_name: ...}` and requires a checkpointer. The docs show:
- how to configure per-tool decisions (approve/edit/reject),
- how interrupts are returned,
- how to resume with `Command(resume=...)`,
- and why you must keep the same `thread_id` to resume correctly. citeturn27view0turn27view2turn28view0

Minimal Deep Agent HITL setup:
```python
from langchain.tools import tool
from deepagents import create_deep_agent
from langgraph.checkpoint.memory import MemorySaver

@tool
def send_email(to: str, subject: str, body: str) -> str:
    return "ok"

checkpointer = MemorySaver()

agent = create_deep_agent(
    model="claude-sonnet-4-6",
    tools=[send_email],
    interrupt_on={"send_email": {"allowed_decisions": ["approve", "reject"]}},
    checkpointer=checkpointer,
)
```
citeturn27view0turn10view0

## Full end-to-end Deep Agent implementations

Below are **four full implementations** you can use as reference. The first three are official examples from entity["company","GitHub","code hosting platform"] in the Deep Agents repository; the last one is a “maximal customization” template that combines the official patterns into a single agent.

### Deep Research agent with delegated researcher subagent (official)

This is the official Deep Research `agent.py` example: it builds a Deep Agent with custom research instructions, a web-search tool, and a specialized research subagent. citeturn21view0

```python
from datetime import datetime

from langchain.chat_models import init_chat_model
from deepagents import create_deep_agent

from research_agent.prompts import (
    RESEARCHER_INSTRUCTIONS,
    RESEARCH_WORKFLOW_INSTRUCTIONS,
    SUBAGENT_DELEGATION_INSTRUCTIONS,
)
from research_agent.tools import tavily_search, think_tool

max_concurrent_research_units = 3
max_researcher_iterations = 3
current_date = datetime.now().strftime("%Y-%m-%d")

INSTRUCTIONS = (
    RESEARCH_WORKFLOW_INSTRUCTIONS
    + "\n\n"
    + "=" * 80
    + "\n\n"
    + SUBAGENT_DELEGATION_INSTRUCTIONS.format(
        max_concurrent_research_units=max_concurrent_research_units,
        max_researcher_iterations=max_researcher_iterations,
    )
)

research_sub_agent = {
    "name": "research-agent",
    "description": "Delegate research to the sub-agent researcher. Only give this researcher one topic at a time.",
    "system_prompt": RESEARCHER_INSTRUCTIONS.format(date=current_date),
    "tools": [tavily_search, think_tool],
}

model = init_chat_model(model="anthropic:claude-sonnet-4-5-20250929", temperature=0.0)

agent = create_deep_agent(
    model=model,
    tools=[tavily_search, think_tool],
    system_prompt=INSTRUCTIONS,
    subagents=[research_sub_agent],
)
```
citeturn21view0

### Text-to-SQL deep agent using `AGENTS.md` + skill workflows + persistent local filesystem (official)

This official example shows a Deep Agent that:
- loads agent identity/instructions from `AGENTS.md`,
- loads skills from a `skills/` directory,
- and uses a `FilesystemBackend` for persistent file storage. citeturn22view0turn14view0

```python
import os
from deepagents import create_deep_agent
from deepagents.backends import FilesystemBackend
from langchain_anthropic import ChatAnthropic
from langchain_community.agent_toolkits import SQLDatabaseToolkit
from langchain_community.utilities import SQLDatabase

def create_sql_deep_agent():
    base_dir = os.path.dirname(os.path.abspath(__file__))

    db_path = os.path.join(base_dir, "chinook.db")
    db = SQLDatabase.from_uri(f"sqlite:///{db_path}", sample_rows_in_table_info=3)

    model = ChatAnthropic(model="claude-sonnet-4-5-20250929", temperature=0)
    toolkit = SQLDatabaseToolkit(db=db, llm=model)
    sql_tools = toolkit.get_tools()

    agent = create_deep_agent(
        model=model,
        memory=["./AGENTS.md"],
        skills=["./skills/"],
        tools=sql_tools,
        subagents=[],
        backend=FilesystemBackend(root_dir=base_dir),
    )
    return agent
```
citeturn22view0turn14view0

### Content Builder agent defined via files on disk (official)

This official example demonstrates the “agent as a folder” pattern:
- `AGENTS.md` (memory) for voice/style,
- `skills/*/SKILL.md` for workflows,
- `subagents.yaml` for delegated work (loaded by a helper),
- a persistent filesystem backend. citeturn25view0turn23view0

```python
from pathlib import Path
from deepagents import create_deep_agent
from deepagents.backends import FilesystemBackend

EXAMPLE_DIR = Path(__file__).parent

def load_subagents(config_path: Path):
    # This example externalizes subagent config to YAML (a helper),
    # then returns a list[dict] compatible with create_deep_agent(subagents=...).
    ...

def create_content_writer():
    return create_deep_agent(
        memory=["./AGENTS.md"],
        skills=["./skills/"],
        tools=[generate_cover, generate_social_image],
        subagents=load_subagents(EXAMPLE_DIR / "subagents.yaml"),
        backend=FilesystemBackend(root_dir=EXAMPLE_DIR),
    )
```
citeturn25view0turn23view0

### Maximal customization template: store-backed long-term memory, policy wrapper, HITL approvals, MCP tools, structured output

This template combines the official patterns into a single “enterprise-grade” Deep Agent configuration:
- **CompositeBackend** for ephemeral + `/memories/` persistence
- **StoreBackend** + `store=...` for cross-thread durable memory
- **policy wrapper** that blocks writes in protected directories
- **interrupt_on** for human approval on sensitive tool calls
- **MCP tools** added to Deep Agent tools
- **structured output** via `response_format`
- typed **runtime context** via `context_schema`

```python
import uuid
import asyncio
from dataclasses import dataclass

from deepagents import create_deep_agent
from deepagents.backends import CompositeBackend, StateBackend, StoreBackend
from deepagents.backends.protocol import BackendProtocol, WriteResult, EditResult
from langgraph.checkpoint.memory import MemorySaver
from langgraph.store.memory import InMemoryStore

from langchain_mcp_adapters.client import MultiServerMCPClient
from langgraph.types import Command

@dataclass
class AppContext:
    user_id: str
    org_tier: str

@dataclass
class FinalAnswer:
    summary: str
    artifacts_written: list[str]
    followups: list[str]

class PolicyWrapper(BackendProtocol):
    """Backend-agnostic policy wrapper: deny writes/edits under protected prefixes."""
    def __init__(self, inner: BackendProtocol, deny_prefixes: list[str] | None = None):
        self.inner = inner
        self.deny_prefixes = [p if p.endswith("/") else p + "/" for p in (deny_prefixes or [])]

    def _deny(self, path: str) -> bool:
        return any(path.startswith(p) for p in self.deny_prefixes)

    def ls_info(self, path: str): return self.inner.ls_info(path)
    def read(self, file_path: str, offset: int = 0, limit: int = 2000): return self.inner.read(file_path, offset=offset, limit=limit)
    def grep_raw(self, pattern: str, path: str | None = None, glob: str | None = None): return self.inner.grep_raw(pattern, path, glob)
    def glob_info(self, pattern: str, path: str = "/"): return self.inner.glob_info(pattern, path)

    def write(self, file_path: str, content: str) -> WriteResult:
        if self._deny(file_path):
            return WriteResult(error=f"Writes are not allowed under {file_path}")
        return self.inner.write(file_path, content)

    def edit(self, file_path: str, old_string: str, new_string: str, replace_all: bool = False) -> EditResult:
        if self._deny(file_path):
            return EditResult(error=f"Edits are not allowed under {file_path}")
        return self.inner.edit(file_path, old_string, new_string, replace_all)

async def build_enterprise_agent():
    # 1) MCP tool loading (optional)
    mcp = MultiServerMCPClient(
        {
            "internal-tools": {
                "transport": "http",
                "url": "http://localhost:8000/mcp",
                "headers": {"Authorization": "Bearer YOUR_TOKEN"},
            }
        }
    )
    mcp_tools = await mcp.get_tools()

    # 2) Long-term memory (store) + thread continuity (checkpointer)
    store = InMemoryStore()
    checkpointer = MemorySaver()

    # 3) Hybrid storage: StateBackend for scratch + StoreBackend for /memories
    def backend_factory(runtime):
        base = CompositeBackend(
            default=StateBackend(runtime),
            routes={"/memories/": StoreBackend(runtime)},
        )
        # Deny writes/edits under protected prefixes
        return PolicyWrapper(base, deny_prefixes=["/memories/admin/", "/secrets/"])

    agent = create_deep_agent(
        tools=mcp_tools,
        backend=backend_factory,
        store=store,
        checkpointer=checkpointer,
        context_schema=AppContext,
        response_format=FinalAnswer,
        memory=["/memories/AGENTS.md"],   # persisted identity/policy file (optional)
        skills=["/skills/"],             # if you seed skills into the backend
        interrupt_on={
            # approve/edit/reject for filesystem mutations:
            "write_file": True,
            "edit_file": True,
            # approval only:
            "execute": {"allowed_decisions": ["approve", "reject"]},
        },
        system_prompt=(
            "Follow org policy. Store reusable preferences under /memories/.\n"
            "Never write secrets. Write artifacts under /workspace/."
        ),
    )
    return agent

def run_once(agent):
    thread_id = str(uuid.uuid4())
    config = {"configurable": {"thread_id": thread_id}}

    result = agent.invoke(
        {"messages": [{"role": "user", "content": "Draft an onboarding summary and save it to /memories/onboarding.md"}]},
        config=config,
        version="v2",
        context=AppContext(user_id="u_123", org_tier="enterprise"),
    )

    # HITL: resume if interrupted
    if getattr(result, "interrupts", None):
        # In a real UI, you'd surface action_requests to a reviewer and collect decisions.
        decisions = [{"type": "approve"} for _ in result.interrupts[0].value["action_requests"]]
        result = agent.invoke(Command(resume={"decisions": decisions}), config=config, version="v2")

    return result
```

This composition is directly grounded in the documented patterns for:
- composite long-term memory routing, store usage, and cross-thread persistence, citeturn28view0turn11view0turn11view3turn12view0  
- backend policy hooks/wrappers for enterprise rules, citeturn14view0turn10view1  
- HITL interrupts (`interrupt_on`, checkpointer requirement, resume via `Command`), citeturn27view0turn27view2  
- MCP tool loading and headers/auth, citeturn15view0turn15view2  
- and the Deep Agents customization surface (parameters, middleware stack behavior). citeturn10view0turn5view2