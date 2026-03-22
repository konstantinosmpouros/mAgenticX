# Deep Agents Rewritten Deep-Dive: Store vs Checkpointer vs LangMem, Backends, Skills/AGENTS.md, and Middleware

## How Deep Agents composes an agent runtime

A Deep Agent is an **agent harness** that returns a **compiled LangGraph graph**, so you can stream it, checkpoint it, interrupt/resume it, and deploy it the same way you deploy other LangGraph graphs. citeturn26search12turn18search7

The harness is “batteries included” in two ways:

First, it provides a **standard capability set** out of the box: planning (TODOs), a filesystem surface for offloading and retrieval, and subagent delegation. citeturn26search12turn10view0

Second, these capabilities are largely delivered as middleware that injects both:
- tools (e.g., todo, filesystem, subagent spawning), and
- system-level instructions and context-management behaviors,
so the model is guided into using the capabilities correctly instead of you having to carefully hand-craft a single giant system prompt. citeturn10view0turn10view0

A core principle is: **the agent can do anything its tools/backends allow**, so “enterprise safety” should be enforced at tool/backends/middleware boundaries, not only by prompts. citeturn26search12turn14view0

## Store, checkpointer, LangGraph memory, and LangMem: what each does and how they fit together

You’re absolutely right that these are **different concepts**, and mixing them up leads to confusing architectures. Below is the clean separation.

### Checkpointer: thread continuity + resumability (short-term memory)

A **checkpointer** persists **execution state** for a conversation thread (messages, intermediate agent state). This is what makes:
- multi-turn chat continuity,
- interrupt/resume (human approval),
- time travel / replay,
possible. citeturn27view0turn0search3

In Deep Agents and LangGraph generally, human-in-the-loop requires a checkpointer and a stable `thread_id` on resume. citeturn27view0

Deep Agents HITL example (checkpointer required):
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
citeturn27view0

### Store: long-term persistence for documents/files (and also JSON “memory documents”)

A **store** (LangGraph `BaseStore`) is for **cross-thread persistence**—information that should be available across sessions and across different conversation threads. LangGraph stores long-term memory as **JSON documents** addressed by `(namespace, key)` (think “folder + filename”). citeturn0search0turn0search3

Deep Agents often use a store in two distinct ways:

**A. Persistent filesystem storage via StoreBackend**  
Deep Agents can route filesystem operations to a store. That lets you persist files like:
- `/memories/preferences.txt`
- `/memories/AGENTS.md`
- `/skills/.../SKILL.md`  
across threads. citeturn28view0turn28view1

**B. Persistent semantic memory (vector-like) via LangMem using the same store**  
LangMem uses LangGraph’s store as the underlying persistence mechanism for memory records (which can be stored/retrieved semantically). citeturn3view0turn1view5

### Deep Agents long-term filesystem memory (store-backed files)

Deep Agents’ official “long-term memory” pattern is: use a `CompositeBackend` to route `/memories/` to `StoreBackend` (persistent), while normal paths remain in a transient state backend. citeturn28view0turn28view1

Canonical setup:
```python
from deepagents import create_deep_agent
from deepagents.backends import CompositeBackend, StateBackend, StoreBackend
from langgraph.store.memory import InMemoryStore
from langgraph.checkpoint.memory import MemorySaver

checkpointer = MemorySaver()

def make_backend(runtime):
    return CompositeBackend(
        default=StateBackend(runtime),
        routes={"/memories/": StoreBackend(runtime)},
    )

agent = create_deep_agent(
    store=InMemoryStore(),
    backend=make_backend,
    checkpointer=checkpointer,
)
```
citeturn28view0

Key operational detail: **you do not need different filesystem tools** for persistent vs ephemeral. The same `ls/read_file/write_file/edit_file` tools operate over both; the routing is determined by path prefix + backend routing. citeturn28view1turn14view0

### LangMem: semantic long-term memory (RAG-like) integrated with LangGraph store

LangMem is a separate library from entity["company","LangChain","ai framework company"] focused on **agent long-term memory**: extracting information from conversations and storing it so it can be retrieved later, often via semantic similarity (embedding-backed). It supports “hot path” tools (the agent decides during chat) and also “background memory manager” patterns. citeturn1view5turn0search5

LangMem’s own docs show an end-to-end “agent with memory tools” example:

```python
from langgraph.prebuilt import create_react_agent
from langgraph.store.memory import InMemoryStore
from langmem import create_manage_memory_tool, create_search_memory_tool

store = InMemoryStore(
    index={
        "dims": 1536,
        "embed": "openai:text-embedding-3-small",
    }
)

agent = create_react_agent(
    "anthropic:claude-3-5-sonnet-latest",
    tools=[
        create_manage_memory_tool(namespace=("memories",)),
        create_search_memory_tool(namespace=("memories",)),
    ],
    store=store,
)
```
citeturn3view0

And then the agent can store and retrieve memories across chats:
```python
agent.invoke({"messages": [{"role": "user", "content": "Remember that I prefer dark mode."}]})
response = agent.invoke({"messages": [{"role": "user", "content": "What are my lighting preferences?"}]})
print(response["messages"][-1].content)
```
citeturn3view0

Two important architecture points (that match exactly what you asked):

**Hot-path memory creation is a tradeoff.**  
LangGraph’s memory overview describes that writing memories during runtime can add latency and complexity, and an alternative is background memory formation. citeturn0search0turn1view5

**Persistence needs a durable store in production.**  
LangMem’s docs explicitly call out that `InMemoryStore` is process-local and lost on restart, and recommends DB-backed stores (e.g., AsyncPostgresStore) for production durability. citeturn3view0

### File-based long-term memory (no embeddings): keeping “memories” as files

You asked for a non-embedding approach too: “write a memory, read it, rewrite it.”

This is essentially **filesystem memory** rather than semantic memory. In Deep Agents, the cleanest approach is:

- Use the standard filesystem tools (`write_file`, `edit_file`, `read_file`) against a persistent `/memories/` route.
- Define a convention like:
  - `/memories/user_profiles/{user_id}.md`
  - `/memories/preferences/{user_id}.md`
  - `/memories/episodes/{user_id}/{date}.md`

This is exactly what the Deep Agents long-term memory pattern enables: a persistent filesystem accessible across threads. citeturn28view1

A simple “memory ledger” system prompt rule (file-based memory):
```python
system_prompt = """
When the user expresses stable preferences (tone, format, tools, UI), append them to:
  /memories/preferences/{user_id}.md

When the user states stable facts about their work/project, append them to:
  /memories/profile/{user_id}.md

Before answering questions about preferences or history, read those files.
"""
```
This approach is supported by the same routed filesystem backend; the only difference is that retrieval is lexical (read/grep), not semantic. citeturn28view1turn14view0

## Backends: what “backend” means, backend factories, policy hooks, and persistent virtual filesystem

### What the backend is (in one sentence)

The backend is the implementation behind the **filesystem tools** (`ls/read_file/write_file/edit_file/glob/grep`) and optionally `execute`. The agent always uses the same tools; the backend decides *where* those paths read/write. citeturn28view1turn14view0

### Backend factory: why it exists

A backend often needs runtime objects (like the store, credentials, tenant context). So Deep Agents accepts either:
- a backend instance, or
- a backend factory callable that receives runtime and returns a backend. citeturn28view0turn14view0

This is how long-term memory routing works:
```python
def make_backend(runtime):
    return CompositeBackend(
        default=StateBackend(runtime),
        routes={"/memories/": StoreBackend(runtime)},
    )
```
citeturn28view0

### Policy hooks: enterprise rules at the storage boundary

Deep Agents docs recommend enforcing enterprise rules by wrapping/subclassing backends (deny writes under certain prefixes, add auditing, etc.). citeturn14view0turn10view2

Example (deny writes/edits under protected prefixes):
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

### “Virtual filesystem” is not “fake”; it’s an abstraction

The Deep Agents docs emphasize virtual filesystem conventions such as:
- absolute POSIX paths (`/x/y.txt`),
- consistent operations like `glob` and `grep`,
- efficient listing/searching,
- and clear semantics about when state is updated vs not (external backends shouldn’t pretend to update LangGraph state). citeturn14view0turn10view1

This same abstraction is what lets you build:
- State-only storage (scratchpad),
- Disk-backed storage (agent defined by folder),
- Store-backed (cross-thread persistent),
- Composite hybrid,
- Custom S3/Postgres backends. citeturn14view0turn28view1

## Skills and AGENTS.md: what they are, how they load, and how to persist them

### AGENTS.md: “always-on” memory sources

In Deep Agents, `memory=[...]` points to one or more `AGENTS.md` sources that are loaded into system context at startup. Official examples show this pattern directly (Text-to-SQL, Content Builder). citeturn22view0turn25view0

Text-to-SQL example:
```python
agent = create_deep_agent(
    memory=["./AGENTS.md"],
    skills=["./skills/"],
    backend=FilesystemBackend(root_dir=base_dir),
    ...
)
```
citeturn22view0

Content Builder example:
```python
return create_deep_agent(
    memory=["./AGENTS.md"],  # Loaded by MemoryMiddleware
    skills=["./skills/"],    # Loaded by SkillsMiddleware
    backend=FilesystemBackend(root_dir=EXAMPLE_DIR),
    ...
)
```
citeturn25view0

### Skills: progressive disclosure workflows (`SKILL.md`)

Skills are directories of folders where each folder contains `SKILL.md` + optional scripts/docs/assets. The system reads frontmatter first, and only loads full skill contents if relevant (“progressive disclosure”). citeturn29view0turn29view1

Skill structure:
```text
skills/
├── langgraph-docs/
│   └── SKILL.md
└── arxiv_search/
    ├── SKILL.md
    └── arxiv_search.py
```
citeturn29view0

A `SKILL.md` can include frontmatter fields like `allowed-tools` and metadata constraints (size limits, description truncation). citeturn29view1

### Three deployment modes for skills/AGENTS.md (and how to “scale” them)

There are three practical supply models, and you can mix them:

**A. FilesystemBackend (skills on disk)**  
Use paths like `skills=["./skills/"]` and `memory=["./AGENTS.md"]`. The Content Builder and Text-to-SQL examples are exactly this “agent = folder on disk” pattern. citeturn22view0turn25view0

**B. StateBackend (skills seeded per request)**  
Seed `files={...}` with virtual paths, so the state-backed filesystem contains `/skills/.../SKILL.md`. citeturn29view1

Official example seeding a skill into StateBackend:
```python
skills_files = {
    "/skills/langgraph-docs/SKILL.md": create_file_data(skill_content)
}

result = agent.invoke(
    {
        "messages": [{"role": "user", "content": "What is langgraph?"}],
        "files": skills_files
    },
    config={"configurable": {"thread_id": "12345"}},
)
```
citeturn29view1

**C. StoreBackend (skills + AGENTS.md persisted in a store)**  
If you route `/skills/` and `/memories/` (or separate prefixes) to a store backend, you can keep skills and memory files persistent across threads. That’s the same mechanism as Deep Agents long-term memory routing. citeturn28view0turn28view1

## Middleware expanded: every prebuilt middleware category with deep explanation + examples

Middleware is the main way you build “enterprise-grade” control planes around agents: cost limits, retries, security policies, context compression, tool gating, and more. The LangChain prebuilt middleware page enumerates the provider-agnostic middleware that works across models. citeturn1view1turn1view0

Below I group them by **what problem they solve**, and I include both the “why” and concrete code.

### Context growth control and long-running threads

**SummarizationMiddleware** compresses older messages while preserving recent context. It’s driven by a trigger (tokens/fraction/messages) and a keep policy. citeturn1view1turn1view2

```python
from langchain.agents import create_agent
from langchain.agents.middleware import SummarizationMiddleware

agent = create_agent(
    model="gpt-4.1",
    tools=[your_weather_tool, your_calculator_tool],
    middleware=[
        SummarizationMiddleware(
            model="gpt-4.1-mini",
            trigger=("tokens", 4000),
            keep=("messages", 20),
        ),
    ],
)
```
citeturn1view1turn1view2

**ContextEditingMiddleware** is more surgical: it edits conversation history based on configurable “edits,” such as clearing old tool outputs but preserving recent ones. This is critical when tools return large payloads. citeturn2view6turn10view0

```python
from langchain.agents import create_agent
from langchain.agents.middleware import ContextEditingMiddleware, ClearToolUsesEdit

agent = create_agent(
    model="gpt-4.1",
    tools=[],
    middleware=[
        ContextEditingMiddleware(
            edits=[
                ClearToolUsesEdit(
                    trigger=100000,
                    keep=3,
                ),
            ],
        ),
    ],
)
```
citeturn2view6

### Human control, approvals, and auditability

You can add approvals as middleware in generic agents or via `interrupt_on` in Deep Agents. Both rely on LangGraph interrupts and require a checkpointer. citeturn27view0turn1view3

Generic middleware usage:
```python
from langchain.agents import create_agent
from langchain.agents.middleware import HumanInTheLoopMiddleware
from langgraph.checkpoint.memory import InMemorySaver

agent = create_agent(
    model="gpt-4.1",
    tools=[your_read_email_tool, your_send_email_tool],
    checkpointer=InMemorySaver(),
    middleware=[
        HumanInTheLoopMiddleware(
            interrupt_on={
                "your_send_email_tool": {"allowed_decisions": ["approve", "edit", "reject"]},
                "your_read_email_tool": False,
            }
        ),
    ],
)
```
citeturn1view3

Deep Agents’ `interrupt_on` works similarly, and the docs show full resume handling with `Command(resume=...)`. citeturn27view0

### Cost, runaway prevention, and safety budgets

**ModelCallLimitMiddleware** limits model calls per run and per thread; thread limits require persistence via checkpointer. citeturn1view3

```python
from langchain.agents import create_agent
from langchain.agents.middleware import ModelCallLimitMiddleware
from langgraph.checkpoint.memory import InMemorySaver

agent = create_agent(
    model="gpt-4.1",
    checkpointer=InMemorySaver(),
    tools=[],
    middleware=[
        ModelCallLimitMiddleware(thread_limit=10, run_limit=5, exit_behavior="end"),
    ],
)
```
citeturn1view3

**ToolCallLimitMiddleware** limits tool usage globally or per tool, with configurable exit behaviors (`continue`, `error`, `end`). citeturn1view4turn1view3

```python
from langchain.agents import create_agent
from langchain.agents.middleware import ToolCallLimitMiddleware

global_limiter = ToolCallLimitMiddleware(thread_limit=20, run_limit=10)
search_limiter = ToolCallLimitMiddleware(tool_name="search", thread_limit=5, run_limit=3)
strict_limiter = ToolCallLimitMiddleware(tool_name="scrape_webpage", run_limit=2, exit_behavior="error")

agent = create_agent(
    model="gpt-4.1",
    tools=[search_tool, scraper_tool],
    middleware=[global_limiter, search_limiter, strict_limiter],
)
```
citeturn1view4

### Reliability: outages, flakiness, transient failures

**ModelFallbackMiddleware** tries alternate models when the primary fails (useful for cross-provider resilience). citeturn1view4turn2view0

```python
from langchain.agents import create_agent
from langchain.agents.middleware import ModelFallbackMiddleware

agent = create_agent(
    model="gpt-4.1",
    tools=[],
    middleware=[
        ModelFallbackMiddleware("gpt-4.1-mini", "claude-3-5-sonnet-20241022"),
    ],
)
```
citeturn1view4

**ToolRetryMiddleware** retries tool calls with exponential backoff and multiple control knobs (exception filtering, jitter, max delay, on-failure behavior). citeturn2view3turn2view4

```python
from langchain.agents import create_agent
from langchain.agents.middleware import ToolRetryMiddleware

agent = create_agent(
    model="gpt-4.1",
    tools=[search_tool, flaky_api_tool],
    middleware=[
        ToolRetryMiddleware(
            max_retries=4,
            tools=["flaky_api_tool"],
            backoff_factor=2.0,
            initial_delay=1.0,
            max_delay=30.0,
            jitter=True,
            on_failure="return_message",
        ),
    ],
)
```
citeturn2view3turn2view4

**ModelRetryMiddleware** retries failed model calls with backoff and exception filtering; useful for transient 429/503 or provider hiccups. citeturn2view5

```python
from langchain.agents import create_agent
from langchain.agents.middleware import ModelRetryMiddleware

agent = create_agent(
    model="gpt-4.1",
    tools=[search_tool],
    middleware=[ModelRetryMiddleware(max_retries=2)],
)
```
citeturn2view5

### Tool sprawl and “tool chooser” patterns

**LLMToolSelectorMiddleware** asks a smaller model to select a small subset of tools before running the main model. This is a major quality and cost improvement in tool-heavy agents. citeturn2view3turn1view1

```python
from langchain.agents import create_agent
from langchain.agents.middleware import LLMToolSelectorMiddleware

agent = create_agent(
    model="gpt-4.1",
    tools=[tool1, tool2, tool3, tool4, tool5],
    middleware=[
        LLMToolSelectorMiddleware(
            model="gpt-4.1-mini",
            max_tools=3,
            always_include=["search"],
        ),
    ],
)
```
citeturn2view3

### Compliance: PII detection and custom detectors

**PIIMiddleware** detects and handles sensitive patterns (redact, mask, block). This is a core enterprise requirement for regulated domains. citeturn2view0turn2view1

```python
from langchain.agents import create_agent
from langchain.agents.middleware import PIIMiddleware

agent = create_agent(
    model="gpt-4.1",
    tools=[],
    middleware=[
        PIIMiddleware("email", strategy="redact", apply_to_input=True),
        PIIMiddleware("credit_card", strategy="mask", apply_to_input=True),
    ],
)
```
citeturn2view0

Custom PII types are supported via regex / compiled regex / custom detector function with spans. citeturn2view1turn2view0

### Planning and operational structure

**TodoListMiddleware** equips agents with task planning via a `write_todos` tool and guiding prompts. Deep Agents use this style as a core harness capability. citeturn2view2turn10view0

```python
from langchain.agents import create_agent
from langchain.agents.middleware import TodoListMiddleware

agent = create_agent(
    model="gpt-4.1",
    tools=[read_file, write_file, run_tests],
    middleware=[TodoListMiddleware()],
)
```
citeturn2view2

### DevOps-style execution and codebase exploration

**ShellToolMiddleware** exposes a persistent shell session with explicit execution policies (host vs docker vs sandbox-like). It comes with strong security caveats and currently doesn’t compose with HITL interrupts. citeturn2view7turn2view8

```python
from langchain.agents import create_agent
from langchain.agents.middleware import ShellToolMiddleware, HostExecutionPolicy

agent = create_agent(
    model="gpt-4.1",
    tools=[search_tool],
    middleware=[
        ShellToolMiddleware(
            workspace_root="/workspace",
            execution_policy=HostExecutionPolicy(),
        ),
    ],
)
```
citeturn2view7

**FilesystemFileSearchMiddleware** provides glob/grep over a real filesystem root, commonly used for code exploration. citeturn2view8turn1view1

```python
from langchain.agents import create_agent
from langchain.agents.middleware import FilesystemFileSearchMiddleware

agent = create_agent(
    model="gpt-4.1",
    tools=[],
    middleware=[
        FilesystemFileSearchMiddleware(root_path="/workspace", use_ripgrep=True),
    ],
)
```
citeturn2view8

## Full implementations: four end-to-end Deep Agent builds (including LangMem + file-based memories)

Below are 4 implementations. The first three are official Deep Agents examples; the fourth is a maximal “enterprise memory” implementation that combines: store-backed filesystem persistence, checkpointer, LangMem semantic memory tools, file-based memory ledgers, and rich middleware.

### Deep Research deep agent (official)

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
    "description": "Delegate research; one topic at a time.",
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

### Text-to-SQL deep agent with AGENTS.md + skills + FilesystemBackend (official)

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
    sql_tools = SQLDatabaseToolkit(db=db, llm=model).get_tools()

    agent = create_deep_agent(
        model=model,
        memory=["./AGENTS.md"],
        skills=["./skills/"],
        tools=sql_tools,
        backend=FilesystemBackend(root_dir=base_dir),
    )
    return agent
```
citeturn22view0

### Content Builder deep agent configured by files on disk (official)

```python
from pathlib import Path
from deepagents import create_deep_agent
from deepagents.backends import FilesystemBackend

EXAMPLE_DIR = Path(__file__).parent

def load_subagents(config_path: Path):
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
citeturn25view0

### Maximal “memory-rich” Deep Agent: persistent filesystem + LangMem semantic memory + middleware

This one is designed to directly address your “three memory systems” requirement:

- **Checkpointer**: thread continuity + HITL resumability. citeturn27view0  
- **Store + CompositeBackend**: persistent file memory under `/memories/` across chats. citeturn28view1  
- **LangMem**: semantic “RAG-like” memory using `create_manage_memory_tool` and `create_search_memory_tool`. citeturn3view0turn1view5  

```python
import uuid
from dataclasses import dataclass

from deepagents import create_deep_agent
from deepagents.backends import CompositeBackend, StateBackend, StoreBackend
from langgraph.checkpoint.memory import MemorySaver
from langgraph.store.memory import InMemoryStore

# LangMem semantic memory tools (vector-like)
from langmem import create_manage_memory_tool, create_search_memory_tool

# Middleware (LangChain)
from langchain.agents.middleware import (
    PIIMiddleware,
    ToolRetryMiddleware,
    ModelRetryMiddleware,
    ModelFallbackMiddleware,
    ToolCallLimitMiddleware,
    ModelCallLimitMiddleware,
    LLMToolSelectorMiddleware,
    ContextEditingMiddleware,
    ClearToolUsesEdit,
)

@dataclass
class Context:
    user_id: str
    org_tier: str

def make_backend(runtime):
    # Ephemeral scratch (state) + persistent files (store) under /memories/
    return CompositeBackend(
        default=StateBackend(runtime),
        routes={"/memories/": StoreBackend(runtime)},
    )

store = InMemoryStore(
    # If you want LangMem semantic memory in this store, configure an index
    # (dims + embed model). This matches LangMem docs.
    index={"dims": 1536, "embed": "openai:text-embedding-3-small"},
)
checkpointer = MemorySaver()

# LangMem tools: semantic memory
semantic_memory_tools = [
    create_manage_memory_tool(namespace=("memories",)),
    create_search_memory_tool(namespace=("memories",)),
]

agent = create_deep_agent(
    model="claude-sonnet-4-6",
    tools=[
        *semantic_memory_tools,
        # plus your domain tools, MCP tools, etc...
    ],
    backend=make_backend,
    store=store,
    checkpointer=checkpointer,
    context_schema=Context,
    # Human approval for sensitive mutations (example)
    interrupt_on={
        "write_file": True,
        "edit_file": True,
    },
    system_prompt="""
You have TWO kinds of long-term memory:
1) Semantic memory via LangMem tools (manage/search), used for recall by similarity.
2) File-based memory under /memories/ files, used as canonical, human-auditable records.

Rules:
- If user states stable preferences, store them with manage-memory AND append to /memories/preferences/{user_id}.md.
- Before answering preference questions, read /memories/preferences/{user_id}.md and also search semantic memory.
""",
    middleware=[
        # Compliance: redact PII early
        PIIMiddleware("email", strategy="redact", apply_to_input=True),
        PIIMiddleware("api_key", detector=r"sk-[a-zA-Z0-9]{32}", strategy="block", apply_to_input=True),

        # Reliability
        ToolRetryMiddleware(max_retries=4, backoff_factor=2.0, jitter=True),
        ModelRetryMiddleware(max_retries=2),
        ModelFallbackMiddleware("gpt-4.1-mini", "claude-3-5-sonnet-20241022"),

        # Cost control
        ToolCallLimitMiddleware(thread_limit=50, run_limit=20),
        ModelCallLimitMiddleware(thread_limit=20, run_limit=8, exit_behavior="end"),

        # Tool sprawl control
        LLMToolSelectorMiddleware(model="gpt-4.1-mini", max_tools=6, always_include=["search_memory"]),

        # Context maintenance
        ContextEditingMiddleware(
            edits=[ClearToolUsesEdit(trigger=100000, keep=4)]
        ),
    ],
)

# Run (same thread_id across turns; different thread_id == different conversation)
thread_id = str(uuid.uuid4())
config = {"configurable": {"thread_id": thread_id}}

result = agent.invoke(
    {"messages": [{"role": "user", "content": "Remember: I prefer dark mode and short answers."}]},
    config=config,
    version="v2",
    context=Context(user_id="u_123", org_tier="enterprise"),
)
```

Why this satisfies your requirement:

- The **semantic memory** path uses LangMem tools operating over the store (“agent decides when to store and when to search”). citeturn3view0turn1view6  
- The **file memory ledger** path uses persistent `/memories/` files (auditable, readable, editable, not embedding-based). citeturn28view1  
- Middleware is used to enforce compliance (PII), reliability (retries/fallback), cost controls (limits), tool sprawl reduction (LLM tool selector), and context editing. citeturn2view0turn2view3turn2view4turn2view6turn1view3turn1view4  

---

If you want, I can also rewrite the last “maximal” example into **two clean variants** (one purely file-based memory, one purely LangMem semantic memory) so you can compare operational complexity and failure modes side-by-side, while keeping the rest identical (same backends, same middleware stack, same HITL).