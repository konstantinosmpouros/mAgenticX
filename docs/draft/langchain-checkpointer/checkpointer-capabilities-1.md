# Agent Checkpointer Capabilities: The Complete Menu for Conversational AI

*Conceptual / framework-level research. Mechanics grounded in LangGraph (the de-facto reference implementation); capabilities framed generally for multi-turn, tool-using, multi-agent chat. Current as of June 21, 2026. Intended path: `docs/draft/agent-checkpointer-capabilities.md`.*

---

## 1. TL;DR

**Mental model.** A *checkpointer* is an autosave for an agent's entire runtime, not just a chat log. After every "super-step" of execution, it serializes the complete graph state — channel values, the live message objects, tool calls and their paired results, sub-agent/sub-graph state, the queue of next nodes, pending human-in-the-loop interrupts, and metadata — into an ordered series of immutable **checkpoints** keyed by a **thread_id** and chained by a parent pointer. Because the full runtime is durable and addressable (by `thread_id` + `checkpoint_id`), you can resume, rewind, fork, branch, edit, recover, audit, and parallelize a conversation with high fidelity by sending only the new input plus an ID — instead of re-sending reconstructed chat text. This is fundamentally different from, and complementary to, long-term cross-thread memory (the **Store**), which holds facts/preferences that should outlive any one conversation.

**Everything you can do with it (one line each):**
- **Cross-turn / cross-session resume** — continue with full runtime fidelity from `thread_id` alone.
- **Durable human-in-the-loop** — pause on `interrupt()`, survive restarts, resume with `Command(resume=...)`.
- **Time-travel / replay** — walk `get_state_history()`, re-run from any past checkpoint.
- **Branching / forking** — `update_state` at an old checkpoint to spawn an alternate timeline; the original is preserved.
- **What-if / parallel exploration** — run several continuations from one checkpoint (A/B, model arena, tree-of-thought).
- **Undo / redo** — navigate checkpoint lineage as conversational history.
- **State editing / steering** — `update_state` to fix a tool result, patch messages, or change routing mid-conversation.
- **Crash recovery / durable execution** — resume an in-flight run after a worker dies via pending writes.
- **Long-running / background / async runs** — detach, run while user is offline, reconnect/resume the stream.
- **Multi-agent / sub-agent continuity** — nested sub-graph state checkpointed under namespaces.
- **Memory & context-window management** — checkpoint as working memory; prune/summarize while staying resumable.
- **Cost & latency savings** — resume-not-replay; avoid re-tokenizing history every turn.
- **Observability / audit / debugging** — inspect, diff, and reproduce every step's state.
- **Cross-device continuity & collaboration** — same thread on any device/worker; concurrency control.
- **Caching / dedup** — node-level cache keyed on input, distinct from checkpointing.

> **Version sensitivity.** Mechanics below are grounded in LangGraph as of **June 2026**, primarily `langgraph` ≥ 1.x with the `langgraph-checkpoint` packages. LangGraph moves fast and has a history of breaking changes (e.g., v0.2 renamed `thread_ts`→`checkpoint_id`, `parent_ts`→`parent_checkpoint_id`; v0.6 restructured the `Interrupt` class and replaced `checkpoint_during` with `durability` modes). Each section flags **[verified from docs]** vs **[inference / needs validation]** with URLs.

---

## 2. Foundations

### 2.1 The core idea: persisting the runtime, not the transcript

Most chat systems persist a *list of messages* and re-send it to the model each turn. A checkpointer persists the **entire runtime state of the agent at each step of execution**, organized into threads. **[verified — docs.langchain.com/oss/python/langgraph/persistence]**: "When you compile a graph with a checkpointer, a snapshot of the graph state is saved at every step of execution, organized into threads. This enables human-in-the-loop workflows, conversational memory, time travel debugging, and fault-tolerant execution."

LangGraph's execution model is Pregel / Bulk-Synchronous-Parallel: work happens in **super-steps**. A super-step is a single "tick" where all nodes scheduled for that step execute (potentially in parallel); then a barrier applies all their writes and a checkpoint is committed. For a sequential graph `START → A → B → END`, you get separate checkpoints after the input, after A, and after B. **[verified from docs]**

**What a checkpoint (`StateSnapshot`) contains** **[verified from docs]**:

| Field | Meaning |
|---|---|
| `values` | State channel values at this checkpoint (includes the `messages` list, any custom keys, tool/agent scratch state). |
| `next` | Tuple of node names to execute next. Empty `()` = graph complete. |
| `config` | `thread_id`, `checkpoint_ns`, `checkpoint_id`. |
| `metadata` | `source` (`"input"`/`"loop"`/`"update"`), `writes` (node outputs that produced this checkpoint), `step` (super-step counter). |
| `created_at` | ISO-8601 timestamp. |
| `parent_config` | Config of the previous checkpoint (`None` for the first) — the **lineage pointer**. |
| `tasks` | Tuple of `PregelTask` (each has `id`, `name`, `error`, `interrupts`, and optionally `state` = subgraph snapshot when `subgraphs=True`). Pending interrupts live here. |

Beyond full super-step snapshots, LangGraph also persists **per-task writes** to a `checkpoint_writes` table as each node finishes within a super-step. These "pending writes" enable mid-super-step crash recovery: if node X succeeds and node Y fails in the same step, X's write is already durable and won't re-run on resume. **[verified from docs]**

**How large checkpoints get.** Because by default LangGraph writes the *full value of every state channel at every super-step*, long threads with accumulating message lists grow storage roughly quadratically with turns (every turn re-persists the whole growing list). LangChain's support docs flag that "database growth usually indicates missing TTL," that large binary objects in state cause "checkpoint bloat and database memory errors," and recommend keeping blobs out of state. **[verified — support.langchain.com]** The `DeltaChannel` (beta, requires `langgraph ≥ 1.2`) stores only incremental deltas for append-heavy channels to fight this. **[verified from docs]**

### 2.2 LangGraph specifics

**Compiling with a checkpointer:**
```python
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.store.memory import InMemoryStore

checkpointer = InMemorySaver()   # short-term, per-thread
store = InMemoryStore()          # long-term, cross-thread (optional)
graph = builder.compile(checkpointer=checkpointer, store=store)

config = {"configurable": {"thread_id": "thread-1"}}
graph.invoke({"messages": [{"role": "user", "content": "Hi, I'm Bob."}]}, config)
```

**`BaseCheckpointSaver` interface** **[verified — reference.langchain.com]**. Every saver implements:
- `.put(config, checkpoint, metadata, new_versions)` — store a checkpoint.
- `.put_writes(config, writes, task_id)` — store pending/intermediate writes.
- `.get_tuple(config)` — fetch a checkpoint tuple (powers `get_state`).
- `.list(config, filter, before, limit)` — list checkpoints (powers `get_state_history`).
- `.delete_thread(thread_id)` — delete all checkpoints + writes for a thread.
- `.get_next_version()` — monotonic channel version generator.
- Async variants: `.aput`, `.aput_writes`, `.aget_tuple`, `.alist`, `.adelete_thread`.

**Concrete savers:**
- **`InMemorySaver`** (a.k.a. `MemorySaver`) — RAM only; ephemeral, lost on process exit; great for tests/dev. Works with async execution. **[verified]**
- **`SqliteSaver` / `AsyncSqliteSaver`** (`langgraph-checkpoint-sqlite`) — local file DB; good for local/single-node. Caveat: write performance becomes a bottleneck under high concurrency. **[verified + practitioner reports]**
- **`PostgresSaver` / `AsyncPostgresSaver`** (`langgraph-checkpoint-postgres`, currently `3.x`) — production default; used by LangSmith Deployment. Requires `.setup()` on first use to create tables. Manual connections need `autocommit=True` and `row_factory=dict_row`. **[verified — pypi/langgraph-checkpoint-postgres]**
- **Redis** (`langgraph-checkpoint-redis`: `RedisSaver`/`AsyncRedisSaver`) — fast persistence; notably ships **native TTL** (`default_ttl` in minutes, `refresh_on_read`) and TTL "pinning" (set `ttl_minutes=-1` to make a checkpoint persistent). Requires RedisJSON+RediSearch (bundled in Redis ≥ 8.0). **[verified — github.com/redis-developer/langgraph-redis]**
- Community/cloud savers: Couchbase, Azure Cosmos DB (`langchain-azure-cosmosdb`), AWS DynamoDB, AWS Bedrock AgentCore (`AgentCoreMemorySaver`), MongoDB, Snowflake. **[verified — respective docs]**

**Identity concepts** **[verified from docs]**:
- **thread** — a unique `thread_id`; the primary key for all checkpoints of one conversation/task; the accumulated state of a sequence of runs. Without it the checkpointer cannot save or resume.
- **checkpoint** — one `StateSnapshot` at a super-step; identified by a monotonic `checkpoint_id`.
- **checkpoint_ns** — namespace identifying which graph/subgraph a checkpoint belongs to. `""` = root graph; `"node_name:uuid"` = a subgraph; nested namespaces join with `|`.
- **`StateSnapshot`** — the object returned from `get_state`/`get_state_history`.

**State APIs** **[verified from docs]**:
```python
graph.get_state({"configurable": {"thread_id": "1"}})                                  # latest
graph.get_state({"configurable": {"thread_id": "1", "checkpoint_id": "<id>"}})         # specific
list(graph.get_state_history({"configurable": {"thread_id": "1"}}))                    # full history, newest first
graph.update_state(config, values={"messages": [...]}, as_node="some_node")            # edit -> NEW checkpoint
```

**The `config = {"configurable": {"thread_id", "checkpoint_id"}}` mechanism.** Pass `thread_id` only → operate on the latest checkpoint. Add `checkpoint_id` → read/resume from that exact point. `invoke(input, config)` with a checkpoint_id replays/forks from there; `invoke(None, config)` resumes without new input. **[verified from docs]**

**How invoke/stream create and resume checkpoints.** On a run, the PregelLoop loads existing state via `get_tuple` at start, then writes a checkpoint via `put` after each super-step (plus per-task `put_writes`). Streaming runs behave the same on the persistence side. **[verified from docs]**

**Serialization (`JsonPlusSerializer`).** Default serializer uses `ormsgpack` with a fallback to an extended JSON that natively handles LangChain/LangGraph types, datetimes, enums, etc. **Pitfalls** **[verified from docs]**:
- Custom/non-standard objects (e.g., Pandas DataFrames) aren't supported by default — opt into `JsonPlusSerializer(pickle_fallback=True)`.
- Large blobs/binary (images, PDFs, base64) bloat every checkpoint and can cause DB memory errors; keep them in external storage (S3, etc.) and persist only a reference/URL in state.
- **Security:** by default the serializer will deserialize "any Python type found in checkpoint data." New apps should set `LANGGRAPH_STRICT_MSGPACK=true` or pass an explicit `allowed_msgpack_modules` allow-list to prevent code execution if the DB is compromised. Wrap any serializer with `EncryptedSerializer` (e.g., `from_pycryptodome_aes`, reading `LANGGRAPH_AES_KEY`) to encrypt state at rest. **[verified from docs]**

### 2.3 Threads vs checkpoints vs runs vs messages

- **Thread** = the container/identity for one conversation; holds accumulated state across runs. **[verified]**
- **Run** = a single invocation/execution of the agent (assistant). Stateful runs execute *on* a thread; stateless runs have no thread. One thread can have many sequential runs. On LangGraph Platform a run "pairs an assistant + thread." **[verified — docs.langchain.com/langsmith/runs]**
- **Checkpoint** = a snapshot at each super-step *within* a run; many checkpoints per run; chained by `parent_config`.
- **Message** = a single item *inside* the state's `messages` channel (`HumanMessage`, `AIMessage` with `tool_calls`, `ToolMessage`, …). Messages are the most visible part of `values`, but a checkpoint also carries next-nodes, interrupts, and tool/agent scratch.

Hierarchy: **thread ⊇ runs ⊇ checkpoints; checkpoints contain messages (+ everything else).**

### 2.4 Checkpointer (short-term) vs Store (long-term) — the distinction people get wrong

**[verified — docs.langchain.com/oss/python/langgraph/persistence]**: "LangGraph provides two complementary persistence systems: **Checkpointers** persist a thread's graph state as checkpoints. Use them for short-term, thread-scoped memory… **Stores** persist application-defined data outside the graph state. Use them for long-term, cross-thread memory, including user preferences, facts, and shared knowledge."

| | **Checkpointer** | **Store** |
|---|---|---|
| Scope | One **thread** | Across **all** threads (e.g., per `user_id`) |
| Keyed by | `thread_id` (+ `checkpoint_id`) | `namespace` tuple (e.g., `(user_id, "memories")`) + key |
| Holds | Full runtime state, message objects, tool state, interrupts | App-defined facts/preferences/knowledge |
| Lifecycle | Tied to conversation; can TTL/prune | Outlives conversations |
| API | `get_state`, `get_state_history`, `update_state` | `store.put/get/search/list_namespaces` (+ async, + semantic search via embeddings) |

They combine: compile with **both** (`builder.compile(checkpointer=..., store=...)`), pass `thread_id` for the conversation and `user_id` (via context) to namespace cross-thread memories. A node reads long-term memories from the Store (optionally via semantic search) and writes new facts back; the checkpointer independently snapshots the run. The Store is **not** a chat-history database — raw message logs belong in checkpoint history or a purpose-built conversation DB. **[verified from docs]**

---

## 3. The Capability Catalog

### 3.1 Cross-turn / cross-session resume
**(a) What it is / UX.** A returning user (next turn, or next week, on a new process) continues exactly where they left off. You send only the new message + `thread_id`; the agent rehydrates the *entire runtime*: the message list, the pairing between each `AIMessage.tool_calls` and its `ToolMessage` result, sub-agent state, intermediate reasoning kept in state, and any interrupt lineage. **[verified]**
**(b) Mechanic.** The checkpointer stores checkpoints keyed by `thread_id`; on the next `invoke`, the PregelLoop calls `get_tuple` to load the latest checkpoint and continues. Reuse the same `thread_id` to accumulate. **[verified]**
**(c) Sketch.**
```python
cfg = {"configurable": {"thread_id": "user-42-conv-7"}}
graph.invoke({"messages": [{"role": "user", "content": "As I said, my order is 9847."}]}, cfg)
# Prior turns, tool calls, and results are already in state — nothing re-sent.
```
**(d) Why higher-fidelity & cheaper than re-sending history.** Re-sending a reconstructed transcript loses non-text runtime structure (exact `tool_call` IDs, partial sub-agent progress, which node is next, pending interrupts) and forces re-serialize/re-tokenize of the whole history each turn. Resume-by-id restores the *objects*, preserving the `tool_call`↔result pairing that some model APIs strictly validate. **Pitfalls:** state still grows per turn (see §3.11); without a checkpointer, "every `graph.invoke()` starts with empty state — no memory of prior turns," a product-killing bug for support/coding agents. **[verified + practitioner]**

### 3.2 Durable human-in-the-loop (HITL)
**(a) What it is / UX.** The agent pauses to ask a human to **approve / reject / edit a proposed action / supply input** before continuing (e.g., before sending an email, running SQL, making a purchase). The pause survives process restarts and spans turns/sessions — you can resume a thread interrupted last week. **[verified]**
**(b) Mechanic.** Inside a node, `interrupt(payload)` raises a special `GraphInterrupt`; the executor checkpoints the full state (including where in the node it stopped) and surfaces `payload` to the caller via the `__interrupt__` key. The human's reply is delivered with `Command(resume=value)` on the **same `thread_id`**; the node re-executes from its start and `interrupt()` returns `value`. A checkpointer is mandatory — "without a checkpointer, the graph has no memory between the pause and the resume." **[verified]**
**(c) Sketch.**
```python
from langgraph.types import interrupt, Command
def approve_node(state):
    decision = interrupt({"type": "approval", "draft": state["draft"],
                          "actions": ["approve", "edit", "reject"]})
    ...
graph.invoke(Command(resume={"action": "reject", "feedback": "Make it shorter"}), cfg)
```
The prebuilt **`HumanInTheLoopMiddleware`** (LangChain agents) formalizes four decision types — **approve / edit / reject / respond** — and can gate interrupts per-tool with a `when` predicate on the `ToolCallRequest` (conditional interrupts require `langchain ≥ 1.3.3`). **[verified]**
**(d) Tradeoffs/pitfalls.** Resume re-runs the *whole node* from the top, so keep pre-interrupt side effects idempotent or place `interrupt()` early. If a node has multiple `interrupt()` calls, resume values are matched **by order** within the node. The older `interrupt_before`/`interrupt_after` + `NodeInterrupt` patterns still exist, but the `interrupt()`/`Command` API (introduced December 2024) is recommended; v0.6 changed `Interrupt` fields (`when`, `resumable`, `interrupt_id`), so pin versions. **[verified + changelog]**

### 3.3 Time-travel / replay
**(a) What it is / UX.** "Rewind this conversation to N steps ago." Inspect any past state, then **replay** (re-run forward) or fork. Used to debug non-deterministic agents, reproduce a decision, or let a user back up. **[verified]**
**(b) Mechanic.** `get_state_history(config)` returns all `StateSnapshot`s (most-recent first). Pick one and call `invoke(None, snapshot.config)`. Nodes **before** the checkpoint are skipped; nodes **after** re-execute — including LLM/API calls and interrupts, which "fire again and may return different results." Replaying from a final checkpoint (no `next`) is a no-op. **[verified — docs.langchain.com/oss/python/langgraph/use-time-travel]**
**(c) Sketch.**
```python
history = list(graph.get_state_history(cfg))
before_b = next(s for s in history if s.next == ("node_b",))
graph.invoke(None, before_b.config)   # re-runs node_b onward
```
**(d) Pitfalls.** "Deterministic replay" only holds for non-LLM nodes; LLM/tool calls re-fire, and interrupts are **always re-triggered**. A known bug class: replay-then-invoke on a fork historically reused identical checkpoint ids, breaking later history (open issue GitHub #4987) — validate on your version. With **default subgraphs**, the parent treats the whole subgraph as one super-step, so you can only time-travel to the parent boundary (see §3.10). **[verified + GitHub]**

### 3.4 Branching / forking
**(a) What it is / UX.** Fork an alternate timeline from a past point — the canonical "edit-a-message-and-retry" and "tree of conversations." The original branch is preserved. **[verified]**
**(b) Mechanic.** `update_state(checkpoint_config, values, as_node=...)` writes a **new** checkpoint that branches from the specified one (it "does **not** roll back a thread… The original execution history remains intact"). Then `invoke(None, fork_config)` continues down the new branch. Values pass through the channel's reducer (`add_messages` appends; to *replace* a message, reuse its `id`). **[verified]**
**(c) Sketch (edit-and-retry).**
```python
history = list(graph.get_state_history(cfg))
before_joke = next(s for s in history if s.next == ("write_joke",))
fork_cfg = graph.update_state(before_joke.config, values={"topic": "chickens"})
graph.invoke(None, fork_cfg)   # new timeline; original socks-joke branch still exists
```
**(d) Three strategies compared:**

| Strategy | How | Pros | Cons |
|---|---|---|---|
| **Fork via `checkpoint_id`** (`update_state` at old checkpoint) | New checkpoint in **same thread**, new lineage | Native; original preserved; shared prefix not duplicated | One thread holds a tree → you must track which checkpoint = which branch head; no built-in tree view |
| **`update_state` + `as_node`** | Same, with explicit producing-node and resume point | Precise control of what runs next | `InvalidUpdateError` if parallel branches make `as_node` ambiguous |
| **Per-branch `thread_id`** (copy/replay state into a fresh thread) | Each branch is its own thread | Clean isolation; "one thread = one branch"; easy per-branch TTL/ACL | Must seed state in; loses unified lineage; more threads |

ChatGPT/Claude/Google AI Studio expose this as "edit message → branch" / "Branch in new chat" — UX proof that fork-at-checkpoint maps onto a mainstream feature. **[verified — product reports]**

### 3.5 "What-if" / parallel exploration
**(a) What it is / UX.** From one checkpoint, launch several continuations concurrently: A/B two answers, compare models/agent variants ("agent arena"), tree-of-thought search, or test competing tool-fix paths side by side. **[verified — products + docs]**
**(b) Mechanic.** Fork N times from the same checkpoint (N `update_state` calls, or N per-branch threads) and run them in parallel. Each fork is independent state, so concurrency is safe across forks. **[inference from fork mechanic — validate for your concurrency model]**
**(c) Sketch.**
```python
seed = next(s for s in history if s.next == ("answer",))
forks = [graph.update_state(seed.config, {"style": s}) for s in ["formal","casual","terse"]]
results = [graph.invoke(None, f) for f in forks]   # compare three answers
```
**(d) Pitfalls.** Each fork re-runs LLM/tool calls → N× cost and N× side effects (gate write-tools!). Comparison/scoring is your own. Many forks on one thread accumulate checkpoints; consider per-branch threads with TTL.

### 3.6 Undo / redo
**(a) What it is / UX.** Conversational undo ("scratch that") and redo, implemented as navigation over checkpoint lineage. **[inference, built on verified primitives]**
**(b) Mechanic.** "Undo" = move the active pointer to `parent_config` (an earlier `checkpoint_id`) and present that state; "redo" = move forward along a remembered child. Because checkpoints are immutable and chained by `parent_config`, no data is lost — undo just chooses which checkpoint is "current," and continuing creates a fork. **[inference / needs validation]**
**(c) Sketch.**
```python
cur = graph.get_state(cfg)
prev_cfg = cur.parent_config          # one step back
graph.get_state(prev_cfg)             # show the undone state
graph.invoke(new_input, prev_cfg)     # continuing forks a new branch
```
**(d) Pitfalls.** True "redo" requires you to persist which child you came from (LangGraph doesn't track a single linear future once you branch). Reducer-based channels mean "undo" of an append is a pointer move, not an in-place delete.

### 3.7 State editing / steering (`update_state`)
**(a) What it is / UX.** Correct the agent mid-conversation: fix a wrong tool result, inject missing context, edit a pending tool call's args, override a routing decision, or patch the message list — then continue. Powers admin/operator tooling. **[verified]**
**(b) Mechanic.** `update_state(config, values, as_node=...)` applies `values` through the target node's writers/reducers and records a new checkpoint with `metadata.source == "update"`; execution resumes from `as_node`'s successors. `as_node` lets you make the graph "think" a particular node produced the update (or skip nodes). The Pregel runtime also exposes `bulk_update_state` for multi-checkpoint edits. **[verified + runtime internals]**
**(c) Sketch (fix a bad tool result, then continue).**
```python
graph.update_state(
    cfg,
    values={"messages": [ToolMessage(content="CORRECTED: balance=$0", tool_call_id="call_abc")]},
    as_node="tools",
)
graph.invoke(None, cfg)
```
**(d) Pitfalls.** Edits go through reducers — with `add_messages` you append unless you reuse the message `id` to replace. Ambiguous `as_node` on parallel branches raises `InvalidUpdateError`. Steering is powerful and dangerous: validate inputs; expose it as a controlled admin API, not raw DB pokes.

### 3.8 Crash recovery / durable execution
**(a) What it is / UX.** A worker dies mid-run (OOM, deploy, network); on restart the conversation resumes from the last good step rather than from scratch — no duplicated work or lost progress. **[verified]**
**(b) Mechanic.** Two layers: (1) **super-step checkpoints** let you re-invoke with the same `thread_id` and `None` input to resume from where execution stopped; (2) **pending writes** make recovery safe *within* a super-step — successful nodes' writes are durable so they aren't re-run. **Durability modes** (set per call; `langgraph ≥ 0.6`): per the LangChain durability reference, "Use the `durability` parameter instead of `checkpoint_during` (deprecated in v0.6.0)… `durability='async'` replaces `checkpoint_during=True`; `durability='exit'` replaces `checkpoint_during=False`." **[verified]**
- `"exit"` — persist only when the run exits; best performance, **no** mid-run crash recovery.
- `"async"` (default) — persist asynchronously while next step runs; good balance, "small risk that LangGraph does not write checkpoints if the process crashes."
- `"sync"` — persist before each next step; highest durability, some overhead.
Also (`langgraph ≥ 1.2`): cooperative **graceful shutdown** stops after the current super-step and saves a resumable checkpoint.
**(c) Sketch.**
```python
graph.stream(inputs, {"configurable": {"thread_id": "t1"}}, durability="sync")
# after a crash, same thread:
graph.invoke(None, {"configurable": {"thread_id": "t1"}})   # resumes from last good step
```
**(d) Idempotency & "exactly-continue-once."** Checkpointers save state **between** nodes, not **inside** a node — a long loop inside one node restarts from the loop top on resume, so external side effects (emails, payments, writes) must be **idempotent** (derive keys from `(thread_id, step_id)` / tool-call id). LangGraph "makes you the orchestrator": there is **no built-in failure detector, watchdog, or distributed lock** preventing two workers from resuming the same `thread_id` simultaneously — you must add that. This is the conceptual line between *checkpointing* and *durable-execution engines* (Temporal, Dapr Workflows, DBOS, Restate, AWS Step Functions): those provide automatic failure detection, guaranteed run-to-completion, deterministic event-history replay, and distributed coordination "for free." DBOS, for example, integrates directly: per the DBOS blog, "Since DBOS is built on top of Postgres, you can also leverage LangGraph's PostgresSaver to checkpoint the agent's state in the database. Combined with DBOS's durable execution, this provides a complete view of your agent's interactions with the LLM and external APIs" (pattern: `@tool @DBOS.workflow() def process_refund(...)`). **[verified — Diagrid, Temporal, DBOS, AppScale]**

### 3.9 Long-running / background / async runs
**(a) What it is / UX.** Kick off a long task, detach, and let it run server-side while the user is offline or navigates away; reconnect later to a live stream or just fetch the final state; scheduled/queued continuation; streaming reconnect mid-run. **[verified]**
**(b) Mechanic.** Persistence decouples compute from state, so "any worker node can pick up any task." On **LangGraph Platform / LangSmith Deployment** (which manages checkpointers/stores for you) **[verified — docs + Platform API]**:
- `client.runs.create(thread_id, assistant_id, input=...)` → returns immediately with `status: "pending"` (background run). REST: `POST /threads/{thread_id}/runs`.
- `client.runs.join(thread_id, run_id)` → "Block until a run is done. Returns the final state of the thread."
- `client.runs.join_stream(...)` / `GET /threads/{thread_id}/runs/{run_id}/stream` → "Stream output from a run in real-time… Output is not buffered, so any output produced before this call will not be received." Streaming runs are backed by the same job queue as background runs.
- **Join & rejoin** (client `useStream` `disconnect()`/remount): the agent "continues executing server-side while the client is away, and you pick up the stream exactly where you left off" — for mobile backgrounding, network hops, page navigation. Use `disconnect()` to rejoin later vs `stop()`/`client.runs.cancel` to actually cancel.
**(c) Sketch.**
```python
run = await client.runs.create(thread_id, "agent", input={"messages":[...]})  # detach
# ...user closes laptop...
final = await client.runs.join(thread_id, run["run_id"])   # later, fetch result
```
**(d) Pitfalls.** Background runs with no stream listeners have hit Redis-timeout/cancelled-error edge cases on Cloud; `BG_JOB_ISOLATED_LOOPS=true` is needed if nodes contain synchronous code. Always persist the `thread_id` client-side or rejoin is impossible. **[verified — docs + GitHub discussions]**

### 3.10 Multi-agent / sub-agent continuity
**(a) What it is / UX.** A supervisor with sub-agents (or nested sub-graphs/tools) keeps each sub-agent's progress across turns and resumes a half-finished sub-agent — e.g., a parallel research fan-out where each sub-researcher's state is preserved. **[verified]**
**(b) Mechanic.** Each subgraph's checkpoints get their own **`checkpoint_ns`** (`"node_name:uuid"`, nested joined by `|`), normalized via `recast_checkpoint_ns` so parent and child histories don't collide. You only pass the checkpointer to the **parent** at compile; LangGraph propagates it to subgraphs automatically. Two modes **[verified]**:
- **Inherited checkpointer (default):** the parent treats the entire subgraph as a **single super-step** → one parent-level checkpoint for the whole subgraph; time-travel only at the parent boundary.
- **`checkpointer=True` on the subgraph:** the subgraph gets its **own** checkpoint history → you can time-travel/fork *between* its internal nodes (e.g., between two interrupts). Access via `get_state(config, subgraphs=True)`, then `parent_state.tasks[0].state.config`.
**(c) Sketch.**
```python
sub = sub_builder.compile(checkpointer=True)         # own history
parent = parent_builder.compile(checkpointer=InMemorySaver())
ps = parent.get_state(cfg, subgraphs=True)           # inspect sub-agent state
sub_cfg = ps.tasks[0].state.config
parent.update_state(sub_cfg, {...})                  # fork inside the sub-agent
```
**(d) Pitfalls.** Subgraphs compiled with their **own** checkpointers create separate namespaces that **duplicate storage** — a known checkpoint-bloat source. Multi-agent handoffs via `Command(goto=Send(...))` for map-reduce parallelism interact with concurrency limits.

### 3.11 Memory & context-window management
**(a) What it is / UX.** Treat the checkpoint as **working memory**, combine it with long-term Store/vector memory, and keep thread state from overflowing the context window while staying resumable. **[verified]**
**(b) Mechanics & techniques:**
- **Trim** for the model call: `trim_messages(..., max_tokens, strategy="last", token_counter=...)` shapes what the LLM sees without deleting state. **[verified]**
- **Prune** state permanently: return `RemoveMessage(id=m.id)` (works with the `add_messages` reducer) or `RemoveMessage(id=REMOVE_ALL_MESSAGES)` to clear; commonly run in a `@before_model` hook. **[verified]**
- **Summarize-then-truncate:** replace old messages with a running summary in a state key. **Critical pitfall (verified):** if you keep a summary but *don't* also emit `RemoveMessage` for the summarized slice, the pre-cutoff messages stay in checkpointed state → **unbounded checkpoint growth** (this exact regression hit `deepagents` SummarizationMiddleware, GitHub #2876). Summarization that only changes what the model sees but not the persisted state does **not** shrink the checkpoint.
- **Offload large artifacts:** keep files/blobs in external storage (S3/etc.) or the **Store** (by id) and persist only a reference — keeps checkpoints "a few hundred bytes." **[verified]**
- **Reduce per-step duplication:** `DeltaChannel` (beta, ≥1.2); `durability="exit"` to skip intermediate checkpoints.
- **Combine layers:** checkpointer = this conversation's working state; Store = durable facts retrieved (optionally by semantic search) and injected each turn. **[verified]**
**(c) Sketch.**
```python
def before_model(state):
    keep = state["messages"][-6:]
    drop = [RemoveMessage(id=m.id) for m in state["messages"][:-6]]
    return {"messages": drop, "summary": summarize(state["messages"][:-6])}
```
**(d) Pitfalls.** Deleting messages can produce an *invalid* sequence for some providers (orphaned `tool` message or dangling `tool_call`); validate the result. Pruning is irreversible for resumability of dropped content unless summarized.

### 3.12 Cost & latency
**(a) What it is.** Resume-not-replay saves money and time: you don't re-send and re-tokenize the whole transcript each turn, and you don't recompute completed nodes after a failure. **[verified/practitioner]**
**(b) Mechanic.** State (including messages and completed tool results) already lives in the checkpoint; a new turn appends and runs only what's needed. Pending writes avoid recomputing succeeded nodes on resume. **Nuance for hosted-thread APIs:** even when chaining by id, *input tokens are still billed*. Per OpenAI's Conversation state guide: "Even when using `previous_response_id`, all previous input tokens for responses in the chain are billed as input tokens in the API." So persistence saves *transmission/recompute and engineering*, but the model still reads the context it's given. **[verified]**
**(c) Failure mode avoided.** Stuffing the entire history into context every turn (the no-checkpointer pattern) blows the context window, raises latency and cost, and degrades quality. Checkpoint + trim/summarize/offload keeps the *persisted* state complete while the *model-visible* context stays bounded.
**(d) Tradeoffs.** Durability isn't free: `sync` adds write latency per step; checkpoint writes cost I/O. The 2026 "Crab" study (arXiv:2604.28138, *Crab: A Semantics-Aware Checkpoint/Restore Runtime for Agent Sandboxes*) reports: "over 75% of agent turns produce no recovery-relevant state, so most checkpoints are unnecessary… Crab raises recovery correctness from 8% (chat-only) to 100%, cuts checkpoint traffic by up to 87%, and stays within 1.9% of fault-free execution time" — i.e., blanket checkpointing is mostly waste and semantics-aware checkpointing is far more efficient. A Temporal+LangGraph reference architecture (AppScale, 2026) puts durable-execution "cost economics (5–20% overhead at 100k runs/day reference workload)." **[verified — arXiv; secondary — AppScale]**

### 3.13 Observability / audit / debugging
**(a) What it is / UX.** Inspect every step's state, diff checkpoints, reproduce bugs deterministically (for non-LLM parts), and keep an audit trail of *what the agent did and why* — valuable in regulated domains (finance, healthcare). **[verified + practitioner]**
**(b) Mechanic.** `get_state_history` is a complete, ordered, replayable ledger; each `StateSnapshot.metadata` records `source`, `writes` (which node produced what), and `step`. You can find the exact checkpoint where an interrupt or error occurred (`s.tasks[*].interrupts` / `.error`). LangSmith tracing layers on top to visualize how an agent resumes across sessions. **[verified]**
**(c) Sketch.**
```python
for s in graph.get_state_history(cfg):
    print(s.metadata["step"], s.metadata["source"], s.metadata.get("writes"))
forks = [s for s in history if s.metadata["source"] == "update"]   # human edits
```
**(d) Pitfalls.** LLM/tool replays aren't reproducible; the trail is faithful to *state transitions*, not model internals. Checkpoint history is sensitive (full messages + tool I/O) — secure it (§4.6). LangSmith *traces* are separate from thread state and are **not** deleted by thread TTL. **[verified — support docs]**

### 3.14 Cross-device continuity & collaboration
**(a) What it is / UX.** Pick up the same `thread_id` on another device/worker (compute is stateless, state is in the DB); optionally multiple users on one thread. **[verified]**
**(b) Mechanic.** Because checkpoints are DB-backed and addressed by `thread_id`, any process can rehydrate. On LangGraph Platform, `GET /threads` and `/threads/search` return latest state and support filtering by state values and **thread status** (`idle`, `busy`, `interrupted`, `error`) — enabling "agent inbox" UIs. **[verified]**
**(c) Concurrency / locking.** Two writes to one thread is the "double-texting" problem. LangGraph Platform offers four **multitask strategies** (`MultitaskStrategy: Literal['reject','interrupt','rollback','enqueue']`) **[verified]**:
- **`enqueue`** (default) — let the current run finish; queue new input and run sequentially.
- **`reject`** — refuse new runs while one is in progress (raises an error; effectively 409 Conflict).
- **`interrupt`** — halt current execution, preserve progress to that point, insert new input and continue (a tool call may be mid-flight).
- **`rollback`** — halt and revert all progress (including initial input); treat new input as a fresh run; the prior run is deleted.
"Double texting… is not available in the LangGraph open source framework" — it's a Platform feature; self-hosted OSS must implement its own locking / last-writer / optimistic concurrency. **[verified]**
**(d) Pitfalls.** In raw OSS there's no built-in lock; concurrent resumes can double-execute. Decide last-writer-wins vs optimistic checks on `checkpoint_id` per thread. Multi-user-on-one-thread also raises auth questions (whose memories? whose ACL?).

### 3.15 Caching / dedup via checkpoints
**(a) What it is.** Avoid recomputing identical node work. **This is a *separate* mechanism from checkpointing** — worth distinguishing because people conflate them. **[verified]**
**(b) Mechanic.** **Node-level caching** (`langgraph ≥ 0.2`): `add_node(fn, cache_policy=CachePolicy(key_func=..., ttl=...))` plus a cache backend at compile (`compile(cache=InMemoryCache()|SqliteCache|RedisCache, checkpointer=...)`). `key_func` defaults to hashing the node input (pickle); `ttl` is in **seconds** (None = never expire). Each node can have its own TTL. Internally cached writes are retrieved via the checkpointer's `get_writes(task_id, ttl)`. Separately, **pending writes** dedup succeeded nodes on crash-resume. **[verified — docs + PR #2786]**
**(c) Sketch.**
```python
g = (StateGraph(State)
     .add_node(expensive, cache_policy=CachePolicy(key_func=lambda s: str(s["x"]), ttl=300))
     .compile(cache=InMemoryCache(), checkpointer=InMemorySaver()))
```
**(d) Pitfalls.** Cache hits skip the node entirely, so `custom` stream events from inside a cached node aren't re-emitted (GitHub #6265). Cache is input-keyed; non-deterministic-but-cacheable nodes need a careful `key_func`. Don't confuse node cache (perf) with checkpoint (state/recovery).

### 3.16 Capabilities I haven't listed (additional things runtime-state persistence unlocks)
- **Agent "inbox" / approval queues:** filter threads by `status == interrupted` to build a queue of conversations awaiting human action. **[verified]**
- **Deterministic tests / fixtures:** seed a fresh thread's state with `update_state(as_node=...)` (no execution history) to unit-test downstream nodes from an arbitrary state. **[verified]**
- **Encryption-at-rest & compliance:** `EncryptedSerializer` (AES) transparently encrypts all persisted runtime state; on LangSmith it auto-enables with `LANGGRAPH_AES_KEY`. **[verified]**
- **Multi-tenant isolation:** `thread_id` namespacing keeps tenants' state strictly separate within one backend. **[verified]**
- **Scheduled / "sleep-time" continuation:** a paused thread is fully durable, so an external scheduler can resume it later (cron, queue). **[inference from durable pause + background runs]**
- **Stateless ephemeral runs:** create a thread + run in one request and delete the thread after, for one-shot interactions that still want the run machinery. **[verified — agent-protocol]**
- **Resumable SSE streaming:** pair SSE `Last-Event-ID` with checkpoint/run ids to replay missed stream events after reconnect. **[secondary — AppScale]**

---

## 4. Patterns, Techniques & Design Space

### 4.1 Thread / checkpoint / branch identity schemes
- **thread_id allocation:** single-shot/independent runs → fresh UUID per run; conversational memory → reuse a stable `thread_id` per conversation. Common scheme: `f"{tenant}:{user_id}:{conversation_id}"`. **[verified]**
- **checkpoint_id:** assigned by LangGraph (monotonic, time-sortable; `uuid7` recommended for new threads). Don't mint your own; capture it from `StateSnapshot.config`.
- **Mapping a branching chat tree onto lineages — worked edit-and-retry example:**
  - **Option A — fork-at-checkpoint (same thread):** user edits message #4 → find the snapshot whose `next` is the node after #4 → `update_state(snapshot.config, {edited message, same id})` → `invoke(None, fork_cfg)`. *Pros:* original preserved, shared prefix not duplicated, single thread to load. *Cons:* one thread now holds a tree; store a side-table mapping `branch_label → head checkpoint_id` because LangGraph gives lineage but no human-named tree view. (Exactly how ChatGPT does in-place edit-branches.)
  - **Option B — per-branch thread:** copy state up to #4 into a **new** `thread_id`, apply the edit, run. *Pros:* clean isolation, trivial per-branch TTL/ACL/sharing. *Cons:* must seed state, lose unified history, more threads. Good when branches are long-lived, shared, or independently retained (Claude Code `/fork --fork-session`; ChatGPT "Branch in new chat").
  - **Rule of thumb:** ephemeral "what-ifs" → Option A; durable/shareable/separately-retained branches → Option B.

### 4.2 Retention / TTL / GC
- **Native TTL where available:** Redis saver supports `default_ttl` (minutes) + `refresh_on_read`, and `_apply_ttl_to_keys(..., ttl_minutes=-1)` to "pin" important threads. **[verified]**
- **LangGraph Platform TTL (managed):** configure in `langgraph.json` **[verified — docs.langchain.com/langsmith/configure-ttl]**:
  ```json
  {
    "checkpointer": { "ttl": { "strategy": "delete", "sweep_interval_minutes": 60, "default_ttl": 43200 } },
    "store":        { "ttl": { "refresh_on_read": true, "sweep_interval_minutes": 120, "default_ttl": 10080 } }
  }
  ```
  `default_ttl` is in **minutes** (43200 = 30 days; 10080 = 7 days). `strategy` is `"delete"` ("Removes the entire thread including all associated run and checkpoint data") or `"keep_latest"` ("Retains the thread and latest checkpoint, but deletes older checkpoint data"). `sweep_interval_minutes` = how often the sweeper checks. TTL applies only to data created after deployment; existing data is untouched. Per-thread override: `client.threads.create(ttl={"strategy":"delete","ttl":43200})` — a thread-level TTL also deletes that thread's checkpoints.
- **When a saver has no native TTL (raw Postgres/SQLite):** store your own `expires_at`/`last_used_at` column, run a background sweep (cron) calling `checkpointer.delete_thread(thread_id)` for expired threads; **refresh on use** so active conversations aren't GC'd; consider **time-partitioning** checkpoint tables by month for cheap drops, and **per-thread pruning** (summarize-then-truncate, §3.11) to bound size without deleting the thread. **[inference + verified primitives: delete_thread, support.langchain.com TTL guidance]**
- **Don't break legitimate resume/branch-from-old:** if you support time-travel/branching from old checkpoints, an aggressive `keep_latest`/prune policy silently kills that capability — exempt "pinned" or recently-branched threads.

### 4.3 Checkpoint vs Store — decision guide
Put in the **checkpoint** (per-thread): live message list, tool-call/result pairs, in-progress sub-agent state, routing/next-node, pending interrupts — anything needed to *resume this conversation*. Put in the **Store** (cross-thread): durable user facts/preferences, learned knowledge, anything you'd want in a *new* conversation. If data must survive thread deletion/TTL or be shared across a user's threads → Store. If it's only meaningful to continue *this* run → checkpoint. Raw chat logs are **not** Store data. **[verified]**

### 4.4 Serialization, large state, blobs
Keep checkpoints lean: store references (URLs/ids), not bytes; offload files to object storage or Store-by-id; prefer `DeltaChannel` for big append-only channels; avoid unbounded custom objects in state (or accept `pickle_fallback` risk). LangGraph uses a `ThreadPoolExecutor` (up to 32 threads) for serialization — bounded, not a leak, but contributes to memory. **[verified — docs/support]**

### 4.5 Concurrency
Two writes to one thread: choose a multitask strategy (`enqueue`/`reject`/`interrupt`/`rollback` on Platform) or implement locking in OSS. Interrupt-while-running and resume-races need a per-thread lock or optimistic check on `checkpoint_id` (last-writer-wins risks losing an edit). Ordering: checkpoints commit at super-step barriers (BSP), giving a clean consistency boundary, but the engine does **not** coordinate across processes by itself. **[verified]**

### 4.6 Security / isolation / privacy
Persisted runtime state contains *full message + tool data* (often PII/secrets). Controls: `EncryptedSerializer` for encryption-at-rest; `LANGGRAPH_STRICT_MSGPACK=true` / `allowed_msgpack_modules` to block deserialization code-execution; strict `thread_id` authorization — verify the end-user owns the thread before any read/write (OpenAI's thread guidance: "Before performing reads or writes… ensure that the end-user is authorized"); per-tenant DB isolation; TTL to limit retention; remember LangSmith traces are a *separate* copy not covered by thread TTL. **[verified]**

### 4.7 Anti-patterns & limits
- **Unbounded growth:** no TTL + full-state-per-step + large blobs in state → DB bloat and memory errors (the most common production failure). **[verified — support docs]**
- **Summaries that don't trim state:** updating model-visible context without `RemoveMessage` leaves everything in the checkpoint (deepagents #2876). **[verified]**
- **Subgraph checkpointers everywhere:** giving every subgraph its own checkpointer duplicates storage across namespaces. **[verified]**
- **Treating checkpoints as durable execution:** no failure detection / no distributed lock / no inside-node idempotency — don't assume "exactly once" for side effects. **[verified]**
- **Stale cross-branch state:** forking then reading the wrong branch head; track branch→checkpoint mapping explicitly.
- **Blanket high-durability:** `sync` everywhere adds latency where most steps have no recovery-relevant state (Crab: >75% of turns). **[verified/secondary]**
- **MemorySaver in production:** state lost on restart — the "3 AM crash" anti-pattern. **[verified/practitioner]**

---

## 5. Ecosystem & Comparison

| System | Runtime-state persistence model | Time-travel / branch | Notable for chat | Notes |
|---|---|---|---|---|
| **LangGraph (OSS)** | Full per-super-step checkpoints (`thread_id`+`checkpoint_id`), pending writes, durability modes, Store for cross-thread | **Yes** — `get_state_history` + `update_state` fork; native | The de-facto reference for runtime-state persistence | You orchestrate recovery/locks yourself. **[verified]** |
| **LangGraph Platform / LangSmith Deployment** | Managed PostgresSaver/Store; background runs, join/rejoin streams, thread status (`idle/busy/interrupted/error`), multitask strategies, `langgraph.json` TTL | Yes (same primitives) | Agent inbox, resumable SSE, double-texting control | Adds the operational layer OSS lacks. **[verified]** |
| **OpenAI Assistants API (threads)** | Server-side **Thread** stores messages (+ smart truncation); Runs lock the thread while in progress; "limit of 100,000 Messages per Thread" | No first-class branch/time-travel | Simple hosted chat memory | **Deprecated** — per OpenAI's deprecations page, notified Aug 26 2025 and "removal from the API one year later, on August 26, 2026." Migrate to Responses. **[verified]** |
| **OpenAI Responses API + Conversations** | `Conversations` store *items* (messages, tool calls/outputs); chain via `previous_response_id`; `background: true` for async; Compaction for long windows | No native branch/replay | Simpler stateful primitive; ZDR caveats | Input tokens still billed even when chaining by id. **[verified]** |
| **Microsoft AutoGen (AgentChat)** | `save_state()`/`load_state()` → serializable dict (the `model_context`/message thread) to file/DB; Core API factory + save/load | No built-in time-travel/fork | Multi-agent group chats | No built-in persistent layer/TTL (open feature request); memory via vector stores/Mem0. **[verified]** |
| **CrewAI** | Layered memory out-of-box: short-term (ChromaDB vectors), recent results (SQLite), long-term (SQLite), entity memory; background save w/ `drain_writes` | No checkpoint time-travel | Role-based crews | Memory-centric, not runtime-snapshot/replay; highest token/latency overhead in benchmarks. **[verified]** |
| **Letta / MemGPT** | **Memory-centric runtime**: OS-inspired tiers — core (in-context/RAM), recall (searchable history/disk, auto-persisted), archival (external DB); agent self-edits memory via tools; persistence by default | No checkpoint-style fork; state lives in tiers | Stateful agents that decide what to remember | "Most frameworks ship orchestration and bolt on memory; Letta ships memory and bolts on orchestration." **[verified]** |
| **LlamaIndex Workflows** | `Context.to_dict()/from_dict()` serializes global state store, event queues, buffers, broker log, running flag → resume later; `WorkflowCheckpointer` + `run_from(checkpoint)`; Json/JsonPickle serializers | **Yes** — checkpoint per step, `run_from` a checkpoint | Event-driven steps; `Memory` object separate (ChatMessages) | Context vs Memory mirrors checkpoint vs Store. **[verified]** |
| **Temporal (durable execution)** | **Event-history replay**, not snapshots: records every activity call/result; reconstructs state deterministically on restart; "never think about checkpoints" | Replay is the core mechanism; HITL via signals/timers | Crash-proof long-running agents (days/weeks) | Provides failure detection, retries, exactly-once activity semantics checkpointers don't; integrates with/around LangGraph. Similar class: Dapr Workflows, DBOS, Restate, AWS Step Functions. **[verified]** |
| **Chat products (ChatGPT, Claude, Google AI Studio)** | Server-side conversation trees; **edit-a-message forks the thread** / "Branch in new chat" copies context to a new path | **Yes** — branch/fork in UI (no merge-back) | Mainstream proof of fork-at-point UX | Claude Code has `/fork`/`--fork-session`; community requests add tree-view + merge-back. **[verified]** |

**Design ideas LangGraph doesn't natively emphasize, drawn from the survey:** Letta's *agent-self-managed* memory tiers (model decides what to keep hot); Temporal/Dapr's *automatic* failure detection + run-to-completion guarantees + deterministic event-replay; product-level *branch tree views + merge-back* (Claude Code feature requests); OpenAI's *Compaction* item (opaque encrypted summary preserving latent understanding); CrewAI's *consolidation* (LLM decides keep/merge on similar memories).

---

## 6. Sources & Rigor

**Primary — LangGraph / LangChain official docs (verified):**
- Persistence (core): docs.langchain.com/oss/python/langgraph/persistence — checkpoints, super-steps, StateSnapshot fields, get_state/get_state_history/update_state, durability modes, DeltaChannel (≥1.2), serializer/encryption, Store. (Retrieved Jun 2026.)
- Time travel: docs.langchain.com/oss/python/langgraph/use-time-travel — replay vs fork, `as_node`, interrupts re-trigger, subgraph time-travel.
- Interrupts / HITL: docs.langchain.com/oss/python/langgraph/interrupts; .../langchain/human-in-the-loop (HumanInTheLoopMiddleware: approve/edit/reject/respond, `when` predicate, langchain≥1.3.3); reference.langchain.com/python/langgraph/types/interrupt.
- Durable execution / fault tolerance: docs.langchain.com/oss/python/langgraph/durable-execution (exit/async/sync; `durability` replaces `checkpoint_during` deprecated v0.6.0; graceful shutdown ≥1.2).
- Short-term memory / trimming: docs.langchain.com/oss/python/langchain/short-term-memory (trim_messages, RemoveMessage, REMOVE_ALL_MESSAGES, @before_model).
- Add memory / Postgres setup: docs.langchain.com/oss/python/langgraph/add-memory; delete_thread.
- Reference API: reference.langchain.com/python/langgraph/checkpoints (JsonPlusSerializer, EncryptedSerializer, savers); .../langgraph.checkpoint/base/BaseCheckpointSaver; .../langgraph/types/CachePolicy (since v0.2).
- Packages: pypi.org/project/langgraph-checkpoint; .../langgraph-checkpoint-postgres (3.x, setup(), strict msgpack); langgraph-sdk (join/join_stream).
- Platform TTL & Runs: docs.langchain.com/langsmith/configure-ttl (checkpointer.ttl + store.ttl, minutes, delete/keep_latest); .../langsmith/runs; .../background-run; .../cancel-run; .../use-threads (idle/busy/interrupted/error); docs.langchain.com/langgraph-platform/double-texting (reject/interrupt/rollback/enqueue); join-rejoin (docs.langchain.com/oss/javascript/langchain/frontend/join-rejoin); LangChain changelog (join_stream, node-level caching).
- Redis TTL: github.com/redis-developer/langgraph-redis (default_ttl, refresh_on_read, pinning).
- Support/ops: support.langchain.com — checkpoint/DB/TTL bloat guidance; traces not affected by TTL.

**Primary — other ecosystems (verified):**
- OpenAI: developers.openai.com/api/docs/deprecations (Assistants removal Aug 26, 2026); Assistants API deep dive (100,000 messages/thread); developers.openai.com Conversation state guide (previous_response_id billing); assistants/migration.
- AutoGen: microsoft.github.io/autogen .../tutorial/state.html (save_state/load_state); discussions #6005, #6169 (TTL request).
- CrewAI: docs.crewai.com/en/concepts/memory.
- Letta/MemGPT: letta.com/blog/agent-memory, letta.com/blog/letta-v1-agent.
- LlamaIndex: developers.llamaindex.ai workflows Context (to_dict/from_dict), .../agent/state, Workflow.run_from/Checkpoint.
- Temporal: temporal.io/blog (durable-execution-meets-ai); docs.temporal.io/workflow-execution. Diagrid: diagrid.io/blog (checkpoints-are-not-durable-execution). DBOS: dbos.dev/blog (workflow-as-tool + PostgresSaver).
- Chat-product branching: OpenAI "Branch in new chat" (multiple reports); github.com/anthropics/claude-code/issues/32631 (fork/merge spec); Google AI Studio / Claude edit-branch.

**Secondary / directional (flagged, not load-bearing):** arXiv:2604.28138 "Crab: A Semantics-Aware Checkpoint/Restore Runtime for Agent Sandboxes" (">75% of agent turns produce no recovery-relevant state… recovery correctness from 8% to 100%, cuts checkpoint traffic by up to 87%"); appscale.blog (durable-execution reference architecture, "5–20% overhead at 100k runs/day"); various Medium/DEV tutorials used only to corroborate API usage.

**Rigor notes / version-specific flags:**
- Durability modes & graceful shutdown require **≥1.2 / ≥0.6**; `durability="exit"` == old `checkpoint_during=False` (<0.6). **[verified]**
- `DeltaChannel` is **beta, ≥1.2**; API may change. **[verified]**
- Node caching `CachePolicy` **since v0.2**; `ttl` in seconds. **[verified]**
- v0.2 renamed `thread_ts→checkpoint_id` / `parent_ts→parent_checkpoint_id`; v0.6 restructured `Interrupt`. Pin versions. **[verified]**
- Platform TTL `keep_latest` strategy is in the current docs.langchain.com page; an older langchain-ai.github.io mirror lists only `delete` — **version drift; verify against your deployment.** **[verified]**
- Undo/redo (§3.6) and parallel-fork concurrency (§3.5) are **inference built on verified primitives** — validate against your concurrency model and LangGraph version.
- The replay-fork identical-checkpoint-id bug (GitHub #4987) and cached-node custom-event gap (#6265) are **open issues** — confirm status on your version.

---

## Recommendations (staged, with thresholds)

1. **Start: get short-term persistence right.** Compile every chat graph with a real checkpointer (PostgresSaver in prod; InMemorySaver only in tests) and key by a stable `thread_id`. *Threshold to advance:* you have multi-turn threads holding more than a few KB of state, or any tool with side effects.
2. **Add HITL + durability deliberately.** Put `interrupt()` before any state-mutating/external action; make those tools idempotent (keys from `(thread_id, tool_call_id)`); choose `durability="sync"` only for steps where a missed checkpoint is costly, `"async"` elsewhere. *Threshold:* runs exceed seconds, hit external APIs, or require approvals.
3. **Separate working memory from long-term memory.** Keep resumable runtime state in the checkpoint; move durable user facts to a Store (namespaced by `user_id`, semantic search if needed). *Threshold:* you find yourself wanting data to survive across a user's threads or past TTL.
4. **Bound growth before launch.** Implement trim/summarize-with-`RemoveMessage`, offload blobs to external storage (reference-only in state), and set TTL/GC (native Redis TTL, Platform `langgraph.json` TTL, or a `delete_thread` sweep). *Threshold (red line):* checkpoint table growth outpaces active conversations, or any single checkpoint exceeds a few hundred KB.
5. **Design the branch model explicitly.** For ephemeral what-ifs use fork-at-checkpoint; for durable/shareable branches use per-branch threads — and store a `branch→head checkpoint_id` map. *Threshold:* you ship edit-message/retry or A/B exploration UX.
6. **Decide concurrency policy.** On Platform pick a multitask strategy (`enqueue` default); on OSS add per-thread locking/optimistic checks on `checkpoint_id`. *Threshold:* the same thread can receive concurrent input (multi-device, double-texting, parallel sub-agents).
7. **If you need true exactly-once / auto-recovery at scale, add a durable-execution layer** (Temporal/Dapr/DBOS/Restate/Step Functions) around or alongside LangGraph — checkpoints alone don't detect failures, prevent duplicate resumes, or guarantee inside-node progress. *Threshold:* thousands of concurrent long-running workflows, or workflows that must survive worker loss without operator intervention.
8. **Instrument and secure.** Use `get_state_history` + LangSmith for audit/repro; enable `EncryptedSerializer` and `LANGGRAPH_STRICT_MSGPACK=true`; enforce `thread_id` ownership checks. *Threshold:* any PII, regulated domain, or multi-tenant deployment.

---

## Caveats

- LangGraph's API surface changes frequently; verify every code-level detail against the docs for your exact version (`get_state_history`, `update_state`, `interrupt`/`Command`, `durability`, `DeltaChannel`, `CachePolicy`, Platform TTL keys). Sections §3.5 and §3.6 are inference built on verified primitives and should be validated against your concurrency model.
- Checkpointing is **not** durable execution: no failure detection, no distributed lock, no inside-node idempotency. Plan accordingly; don't assume "exactly once."
- "Deterministic replay" applies only to non-LLM/non-tool nodes — replays re-fire model and API calls and re-trigger interrupts.
- Hosted-thread persistence (OpenAI Conversations/threads) reduces transmission but does not reduce input-token billing; the model still reads its context window.
- Two open LangGraph issues touch capabilities here (replay-fork checkpoint-id reuse #4987; cached-node custom-event gap #6265) — confirm their status on your version.
- The Crab efficiency figures (arXiv:2604.28138) and AppScale overhead numbers are directional research/reference values, not guarantees for your workload.