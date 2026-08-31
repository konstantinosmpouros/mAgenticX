# Agent-Runtime Checkpointers for Conversational AI — Second-Pass Technical Report (LangGraph / langgraph-checkpoint / deepagents)

*Target file: `docs/draft/agent-checkpointer-capabilities.md`. Primary substrate: **AsyncPostgresSaver** (`langgraph.checkpoint.postgres.aio`), psycopg3 + psycopg_pool, in a long-lived async FastAPI service running `langgraph` + `deepagents`. OSS self-hosted is the primary target; LangGraph Platform appears only as a contrast with OSS replications.*

Versions referenced (verified against docs/PyPI, June 2026): `langgraph-checkpoint-postgres` 3.1.0; `langgraph-checkpoint` 4.1.1 (requires `ormsgpack>=1.12.0`); durability modes since v0.6; graceful shutdown since v1.2; `deepagents` ≥0.6.6 (DeltaChannel). Marked **[verified]** vs **[inference]** throughout.

## 1. TL;DR

- **Mental model:** A *checkpointer* is short-term, per-thread working memory — it snapshots the full graph state at every super-step into Postgres, keyed by `thread_id`/`checkpoint_ns`/`checkpoint_id`, and that is what powers resume, HITL, time-travel, branching and crash recovery. It is NOT durable execution, NOT a distributed lock, and NOT long-term memory (that is the *Store*). With AsyncPostgresSaver you must run it as a long-lived `psycopg_pool.AsyncConnectionPool` wired into FastAPI lifespan — never `from_conn_string` per request.
- **Every capability, one line each:** (1) cross-turn/session resume; (2) durable HITL interrupts; (3) time-travel replay; (4) branching/forking; (5) what-if parallel exploration; (6) undo/redo via lineage; (7) state editing/steering; (8) crash recovery via pending writes; (9) long-running/background runs; (10) multi-agent/sub-agent continuity; (11) memory & context-window management; (12) cost/latency control; (13) observability/audit; (14) cross-device continuity & agent inbox; (15) node caching/dedup.
- **What's new/corrected in this second pass (vs a typical first pass):** (a) **Corrected:** `from_conn_string` is an async *context manager that closes the connection on block exit* — wrong for a server; use a persistent pool. (b) **Added:** exact verified DDL for all four tables incl. the `task_path` column and the three `_thread_id_idx` indexes. (c) **Corrected:** there is **no native TTL** in the OSS saver — real GC requires your own SQL; partitioning/`adelete_thread` shown. (d) **Added/corrected:** pgbouncer historically broke prepared statements; PgBouncer ≥1.21 (psycopg3 needs ≥1.22) supports them in transaction mode, but the safe default for self-hosted is still `prepare_threshold=None`. (e) **Corrected:** double-texting is **Platform-only**; OSS replications (advisory locks + optimistic `checkpoint_id` checks) provided. (f) **Added:** deepagents `SummarizationMiddleware` historically did **not** emit `RemoveMessage` (issue #2876) → unbounded checkpoint growth; DeltaChannel keeps growth O(N) not O(N²). (g) **Added:** v0.6 `Interrupt` field changes (`id`/`resumable`); graceful shutdown `RunControl`/`GraphDrained` (v1.2). (h) **Added:** node-cache vs InMemorySaver bug (#5980) and cached-node custom-stream-event gap (#6265). (i) **Added:** subagent interrupt edit/reject bug in deepagents (issue #554). (j) **Corrected:** the relevant deserialization advisories are **CVE-2025-64439 / GHSA-wwqv-p2pp-99h5** (RCE in JsonPlusSerializer `json` mode, patched in langgraph-checkpoint 3.0) and **GHSA-g48c-2wqr-h844** (unsafe msgpack deserialization).

## 2. Foundations

### 2.1 What a checkpoint captures [verified]
At every super-step the checkpointer persists a `Checkpoint` (snapshot) plus `CheckpointMetadata`. A `CheckpointTuple` returned by `aget_tuple` contains: `config` (thread_id, checkpoint_ns, checkpoint_id), the `checkpoint` dict, `metadata`, `parent_config`, and `pending_writes`. The checkpoint dict has: `v` (format version, currently 4), `ts`, `id`, `channel_values` (your state: the `messages` list with tool-call↔result pairing, sub-agent/subgraph values, scratch keys), `channel_versions`, and `versions_seen`. A `StateSnapshot` (from `aget_state`) exposes `values`, `next` (next nodes to run), `config`, `metadata` (source/step/writes/parents), `created_at`, `parent_config`, `tasks` (a tuple of `PregelTask`, each with `interrupts` and an optional `.state` pointing to a subgraph checkpoint), and `interrupts`.

**Why it gets large:** the full state is re-serialized into a new checkpoint *every super-step*. With an append-only `messages` list, turn *n* re-stores all *n* prior messages → roughly **quadratic (O(N²)) storage growth** with turns. deepagents mitigates this with a `DeltaChannel` reducer on `messages` (≥0.6.6) that keeps growth **linear (O(N))** by storing deltas and walking the parent chain to reconstruct (`get_delta_channel_history`). [verified — deepagents context-engineering docs; DeltaChannel is beta and requires recent versions]

### 2.2 threads vs checkpoints vs runs vs messages [verified]
- **Thread** — a unique `thread_id`; the container/primary key for a series of checkpoints (one conversation/task).
- **Checkpoint** — one immutable snapshot within a thread, identified by monotonically increasing `checkpoint_id` (sortable UUID).
- **Run** — one invocation (`ainvoke`/`astream`) over a thread; a run produces one or more checkpoints (one per super-step).
- **Message** — an element of the `messages` channel inside a checkpoint's `channel_values`; NOT a first-class persistence object.

### 2.3 Checkpointer (short-term) vs Store (long-term) [verified]
- **Checkpointer** = thread-scoped working memory; vanishes from a *different* `thread_id`. Wire with `builder.compile(checkpointer=...)`.
- **Store** (`BaseStore`/`AsyncPostgresStore`) = cross-thread long-term memory, namespaced by tuples, with optional semantic search via embeddings. Wire with `builder.compile(store=...)`. Combine both:

```python
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from langgraph.store.postgres.aio import AsyncPostgresStore

graph = builder.compile(checkpointer=checkpointer, store=store)
```

Store API: `await store.aput(namespace, key, value)`, `await store.aget(ns, key)`, `await store.asearch(ns, query=..., limit=k)`. With an index config (`dims`, `embed`, `fields`) the Postgres store does pgvector cosine similarity. **Raw chat logs are NOT Store data** — chat history lives in the checkpointer's `messages` channel; the Store is for distilled facts/preferences/episodic records you deliberately write. [verified]

Inside a node, access the store via `runtime.store` (the `Runtime` injection), e.g. `memories = await runtime.store.asearch((user_id, "memories"), query=state["messages"][-1].content, limit=3)`.

## 3. AsyncPostgresSaver Integration (the deep section)

### 3.1 Install & the long-lived-server wiring problem [verified]
```bash
pip install langgraph langgraph-checkpoint-postgres "psycopg[binary,pool]" deepagents
```

**WRONG for a server** — `AsyncPostgresSaver.from_conn_string(...)` returns an **async context manager that opens a single connection and CLOSES it when the `async with` block exits.** It is fine for a one-shot script or a single scoped operation, but in a FastAPI service the connection is dead the moment the block exits, so requests served later hit `psycopg.OperationalError: the connection is closed` and the graph holds references to a closed connection. [verified — multiple FastAPI postmortems]

```python
# ❌ DO NOT do this in a long-lived server
async with AsyncPostgresSaver.from_conn_string(DB_URI) as checkpointer:
    graph = builder.compile(checkpointer=checkpointer)
    # connection is alive ONLY inside this block
# <- here the connection is closed; graph is now broken for later requests
```

**RIGHT** — create a persistent `AsyncConnectionPool` in the FastAPI lifespan and pass it to `AsyncPostgresSaver(conn=pool)`:

```python
from contextlib import asynccontextmanager
from fastapi import FastAPI
from psycopg_pool import AsyncConnectionPool
from psycopg.rows import dict_row
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

DB_URI = "postgresql://user:pass@host:5432/agents?sslmode=verify-full&sslrootcert=/etc/ssl/root.crt"

CONN_KWARGS = {
    "autocommit": True,          # REQUIRED: setup() and checkpoint writes must commit
    "row_factory": dict_row,     # REQUIRED: rows must be dicts or reads raise TypeError
    "prepare_threshold": None,   # disable client-side prepared statements (pgbouncer-safe)
}

@asynccontextmanager
async def lifespan(app: FastAPI):
    pool = AsyncConnectionPool(
        conninfo=DB_URI,
        min_size=2,
        max_size=20,
        max_idle=300,
        open=False,              # do not open in constructor (deprecated to do so)
        kwargs=CONN_KWARGS,
    )
    await pool.open()
    await pool.wait()
    app.state.pool = pool
    checkpointer = AsyncPostgresSaver(pool)
    await checkpointer.setup()                    # idempotent; run once at startup/deploy
    app.state.graph = build_graph(checkpointer)   # compile ONCE, reuse across requests
    try:
        yield
    finally:
        await pool.close()

app = FastAPI(lifespan=lifespan)
```

Then every request reuses the compiled graph: `await app.state.graph.ainvoke(payload, config)`.

**Gotchas:** Without `autocommit=True`, `setup()` may not persist tables (silent). Without `row_factory=dict_row` reads fail with `TypeError: tuple indices must be integers or slices, not str`. Opening an async pool in the constructor is deprecated — use `open=False` + `await pool.open()`. Do NOT use `async with` for shared resources inside request handlers.

### 3.2 .setup(), migrations, and multi-replica races [verified]
`await checkpointer.setup()` creates the tables if missing and applies any pending migrations, tracked by a version integer in `checkpoint_migrations`. It is **idempotent** (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`), so re-running on every boot is safe for a single replica. **Multi-replica race:** several replicas calling `setup()` concurrently can collide, and the index migrations use `CREATE INDEX CONCURRENTLY` which **cannot run inside a transaction block** and can deadlock/error if two run at once. **Mitigation:** run `setup()` as a one-shot migration *job* (init container / deploy step) before scaling app replicas, OR serialize it behind a Postgres advisory lock:

```python
async with pool.connection() as conn:
    await conn.execute("SELECT pg_advisory_lock(hashtext('langgraph_setup'))")
    try:
        await AsyncPostgresSaver(conn).setup()
    finally:
        await conn.execute("SELECT pg_advisory_unlock(hashtext('langgraph_setup'))")
```

### 3.3 Exact schema created by .setup() [verified — base.py MIGRATIONS, commit b674dd46]
```sql
CREATE TABLE IF NOT EXISTS checkpoint_migrations (
    v INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS checkpoints (
    thread_id TEXT NOT NULL,
    checkpoint_ns TEXT NOT NULL DEFAULT '',
    checkpoint_id TEXT NOT NULL,
    parent_checkpoint_id TEXT,
    type TEXT,
    checkpoint JSONB NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}',
    PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
);

CREATE TABLE IF NOT EXISTS checkpoint_blobs (
    thread_id TEXT NOT NULL,
    checkpoint_ns TEXT NOT NULL DEFAULT '',
    channel TEXT NOT NULL,
    version TEXT NOT NULL,
    type TEXT NOT NULL,
    blob BYTEA,                       -- nullable (a later no-op migration dropped a never-set NOT NULL)
    PRIMARY KEY (thread_id, checkpoint_ns, channel, version)
);

CREATE TABLE IF NOT EXISTS checkpoint_writes (
    thread_id TEXT NOT NULL,
    checkpoint_ns TEXT NOT NULL DEFAULT '',
    checkpoint_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    channel TEXT NOT NULL,
    type TEXT,
    blob BYTEA NOT NULL,
    task_path TEXT NOT NULL DEFAULT '',   -- added by a later migration
    PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
);

CREATE INDEX CONCURRENTLY IF NOT EXISTS checkpoints_thread_id_idx ON checkpoints(thread_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS checkpoint_blobs_thread_id_idx ON checkpoint_blobs(thread_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS checkpoint_writes_thread_id_idx ON checkpoint_writes(thread_id);
```
The `MIGRATIONS` list has 10 entries: the four `CREATE TABLE`s, an `ALTER ... DROP not null` on `checkpoint_blobs.blob` (effectively a no-op), a `SELECT 1;` placeholder (to keep version numbering consistent), the three index creations, and the `ADD COLUMN ... task_path` ALTER. Notes: `checkpoints.checkpoint` holds the JSONB snapshot (small/primitive channel values inline); large/complex channel values (e.g. the message list) are serialized to `checkpoint_blobs.blob` (BYTEA), with `checkpoints` referencing them by channel+version. `checkpoint_writes` is the per-task pending-writes log used for crash recovery. **Gotcha (issue #3557):** upgrading the library against an un-migrated DB causes `column cw.task_path does not exist` — always run `setup()` after upgrades.

### 3.4 Pool configuration & pgbouncer caveats [verified]
- `min_size`/`max_size`/`max_idle` size the pool; `max_size` is the hard ceiling on concurrent DB-touching operations.
- **Required kwargs:** `autocommit=True`, `row_factory=dict_row`.
- **`prepare_threshold`:** psycopg3 auto-creates a server-side prepared statement once a query is seen more than `prepare_threshold` times (proposed/actual default **5**, named `f"pg3_{hash(query)}"`; up to ~100 kept per connection), per psycopg maintainer Daniele Varrazzo (psycopg Discussion #21). Setting `prepare_threshold=None` disables preparing. The psycopg 3.3 docs state verbatim: *"Using external connection poolers, such as PgBouncer, is not compatible with prepared statements... If such middleware is used you should disable prepared statements, by setting the `Connection.prepare_threshold` attribute to `None`."* PgBouncer added transaction-mode prepared-statement support in **v1.21** (via a non-zero `max_prepared_statements`; Crunchy Data, *"Prepared Statements in Transaction Mode for PgBouncer"*), and psycopg3 (3.2+) supports it only with **PgBouncer ≥1.22**. For a self-hosted service, the robust default is `prepare_threshold=None` (many LangGraph examples use `prepare_threshold=0`); direct Postgres or session pooling can keep prepared statements. Symptom when misconfigured: `prepared statement "_pg3_0" already exists` / `... does not exist`.
- **Pipeline mode:** AsyncPostgresSaver can use psycopg pipeline mode for batched writes; mixing a single shared connection across concurrent tasks can raise `cannot send pipeline when not in pipeline mode` (issue #3193) — pass the *pool*, not a single borrowed connection, and let the saver manage connections.

### 3.5 Async API end-to-end [verified]
Driven by the graph:
```python
config = {"configurable": {"thread_id": "tenant:user:conv-1"}}
# new turn — send ONLY the new input
async for chunk in app.state.graph.astream({"messages": [{"role": "user", "content": "hi"}]}, config):
    ...
# resume from a specific checkpoint
config_at = {"configurable": {"thread_id": "tenant:user:conv-1", "checkpoint_id": "<id>"}}
await app.state.graph.ainvoke(None, config_at)
```
Direct checkpointer usage (rarely needed; the graph calls these for you):
- `await checkpointer.aput(config, checkpoint, metadata, new_versions)` — store a checkpoint.
- `await checkpointer.aput_writes(config, writes, task_id, task_path="")` — store pending per-task writes.
- `await checkpointer.aget_tuple(config)` — fetch latest (or by `checkpoint_id`) as a `CheckpointTuple`.
- `[c async for c in checkpointer.alist(config, filter=..., before=..., limit=...)]` — list newest-first.
- `await checkpointer.adelete_thread(thread_id)` — delete all checkpoints/blobs/writes for a thread.

### 3.6 Production concerns
- **Isolation:** put checkpoint tables in their own database or schema (e.g. `search_path=langgraph`); keep them off the OLTP primary's hot path.
- **TLS:** `sslmode=verify-full&sslrootcert=/path/root.crt` in the conninfo; never `sslmode=disable` in prod.
- **Secrets:** inject `DB_URI`/`LANGGRAPH_AES_KEY` via env/secret manager, never source.
- **Table growth / VACUUM:** high checkpoint churn + frequent updates cause bloat; ensure autovacuum is aggressive on these tables (lower `autovacuum_vacuum_scale_factor`), and consider periodic `VACUUM (ANALYZE)`.
- **No native TTL — implement GC yourself.** The OSS saver has **no TTL/GC**. Real sweep (don't break legitimate resume/branch-from-old — key on last activity, not creation):

```sql
-- option A: per-thread sweep using a side table of last activity
-- maintain threads(thread_id, last_used_at) updated on each turn
WITH stale AS (
  SELECT thread_id FROM threads WHERE last_used_at < now() - interval '30 days'
)
DELETE FROM checkpoint_writes  WHERE thread_id IN (SELECT thread_id FROM stale);
-- repeat for checkpoint_blobs, checkpoints; then DELETE FROM threads ...
```
Prefer `await checkpointer.adelete_thread(thread_id)` per stale thread so all three tables stay consistent. **Refresh-on-use:** update `threads.last_used_at` each turn so active long threads are never swept. For very high volume, **native time partitioning** beats row deletes: partition `checkpoints`/`checkpoint_blobs`/`checkpoint_writes` by a time column and `DROP` whole partitions (O(1), no bloat) — this requires custom DDL since the stock `.setup()` schema is not partitioned [inference].

### 3.7 At-rest encryption & serializer choices [verified]
Wrap the serializer with `EncryptedSerializer`:
```python
import os
from langgraph.checkpoint.serde.encrypted import EncryptedSerializer
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

serde = EncryptedSerializer.from_pycryptodome_aes()   # reads LANGGRAPH_AES_KEY (16/24/32 bytes)
checkpointer = AsyncPostgresSaver(pool, serde=serde)
```
- Default serializer is `JsonPlusSerializer`, which (per reference.langchain.com) *"uses ormsgpack with a fallback to an extended JSON format that handles LangChain/LangGraph types, datetimes, enums, and more"* (`ormsgpack>=1.12.0`).
- **Strict msgpack security:** the langgraph-checkpoint 4.1.1 README states verbatim: *"By default the serializer allows any Python type found in checkpoint data. New applications should set the environment variable `LANGGRAPH_STRICT_MSGPACK=true` or pass an explicit `allowed_msgpack_modules` list to JsonPlusSerializer to restrict deserialization to known-safe types."* Relevant advisories: **CVE-2025-64439 / GHSA-wwqv-p2pp-99h5** (RCE in the `json` mode of `JsonPlusSerializer`, patched in langgraph-checkpoint 3.0, where `allowed_msgpack_modules` defaults to `None`/strict) and **GHSA-g48c-2wqr-h844** (unsafe msgpack deserialization during checkpoint loading). The Postgres saver is not affected by the SQLite SQL-injection CVE (CVE-2025-67644), but the strict flag is still recommended.
- `pickle_fallback=True` enables pickling arbitrary objects but is a **code-execution risk** on read — avoid for untrusted data.
- Pass a custom `serde=` to `AsyncPostgresSaver(pool, serde=...)`.

### 3.8 Postgres failure & edge cases WITH handling [verified unless noted]
- **Pool exhaustion:** more concurrent runs than `max_size` → callers block then fail with `PoolTimeout`. Mitigate: raise `max_size`, shorten per-run DB work, use `durability="async"`/`"exit"` to cut write frequency, add backpressure (a semaphore on concurrent runs).
- **Dropped connection mid-run:** `psycopg.OperationalError: server closed the connection unexpectedly` (common behind NAT/Supabase poolers). Mitigate: pool health-check, TCP keepalives (`keepalives=1, keepalives_idle=30, keepalives_interval=10, keepalives_count=5`), and let the pool re-establish; resume the run with `ainvoke(None, config)`.
- **Concurrent `.setup()` on multi-replica boot:** see §3.2 (advisory lock or migration job).
- **Oversized state rows:** large artifacts (PDFs/images/base64) in state bloat `checkpoint_blobs` and can cause DB memory errors; **keep blobs external** (object storage) and store only a URL/reference in state.
- **Pending-writes replay after crash:** within a super-step, as each node/task finishes, its writes are persisted to `checkpoint_writes` via `aput_writes`. If another node in the same super-step crashes, on resume (`ainvoke(None, config)`) LangGraph **re-uses the already-persisted writes for completed tasks and only re-runs the unfinished ones** — completed nodes are not re-executed. This is per-task, idx-ordered (`PRIMARY KEY (..., task_id, idx)`). [verified — langgraph-checkpoint README]

## 4. BaseCheckpointSaver contract [verified]
A checkpointer implements (async variants used throughout):
- `aput(config, checkpoint, metadata, new_versions)` → stores a snapshot, returns the next config (with new `checkpoint_id`).
- `aput_writes(config, writes, task_id, task_path="")` → stores pending per-task writes (the crash-recovery log).
- `aget_tuple(config)` → `CheckpointTuple(config, checkpoint, metadata, parent_config, pending_writes)`.
- `alist(config, *, filter=None, before=None, limit=None)` → async iterator, newest-first.
- `adelete_thread(thread_id)` → delete all rows for a thread.
- `get_next_version(current, channel)` → monotonic channel version (default integer sequence from 1; Postgres uses a string version).

**Channel versions** track which channel values changed; `versions_seen` records which versions each node has already consumed, which is how LangGraph decides which nodes are "stale" and must run. Relationship: `checkpoints` holds the snapshot + channel_versions; `checkpoint_blobs` holds the actual serialized channel values keyed by `(channel, version)`; `checkpoint_writes` holds pending writes not yet folded into a checkpoint.

## 5. State APIs [verified]
- `await graph.aget_state(config, subgraphs=False)` → `StateSnapshot`.
- `async for s in graph.aget_state_history(config)` → snapshots newest-first; each `s.config` carries its `checkpoint_id`.
- `await graph.aupdate_state(config, values, as_node=None)` → writes `values` through the named node's writers/reducers, creating a NEW checkpoint; returns the new config.
- `bulk_update_state` — apply multiple sequential updates in one call [verified it exists; exact signature version-sensitive — inference].

**Reducer semantics (`add_messages`):** appends by default; **replace** a message by emitting one with the **same `id`**; **delete** with `RemoveMessage(id=...)`, or clear all with `RemoveMessage(id=REMOVE_ALL_MESSAGES)`.
```python
from langchain_core.messages import RemoveMessage
from langgraph.graph.message import REMOVE_ALL_MESSAGES
await graph.aupdate_state(config, {"messages": [RemoveMessage(id=REMOVE_ALL_MESSAGES), summary_msg]})
```
**`as_node` resolution:** LangGraph infers the producing node from version history (almost always correct when forking from a checkpoint). Specify `as_node` explicitly when (a) parallel branches updated state in the same step (otherwise `InvalidUpdateError` — ambiguous), (b) no execution history (fresh-thread test fixtures), (c) skipping nodes (set a later node to make the graph think it already ran). Execution resumes at the *successors* of `as_node`.

## 6. Interrupts / HITL [verified]
**Re-execution semantics:** `interrupt(value)` raises a resumable `GraphInterrupt`; state is checkpointed and `value` is surfaced to the caller. On resume with `Command(resume=...)`, **the whole node re-runs from the top**, and the `interrupt()` call now *returns* the resume value instead of raising. **Therefore put `interrupt()` early in the node or make pre-interrupt side effects idempotent**, or they will be repeated.

**Multiple interrupts in one node** are matched to resume values **by order** within the node (the resume list is scoped to that task, not shared across tasks).

**Command semantics:**
- `Command(resume=value)` — supply the value for the pending `interrupt()` and continue.
- `Command(update={...})` — write state updates then continue.
- `Command(goto="node" | [Send(...), ...])` — jump/route (incl. map-reduce fan-out).

**Static vs dynamic:** `interrupt_before=[...]`/`interrupt_after=[...]` at compile/invoke are static breakpoints (pause around whole nodes); `interrupt()` is dynamic and conditional anywhere in code. Always resume on the **same thread**: `await graph.ainvoke(Command(resume=...), config)`.

**v0.6 `Interrupt` field changes [verified]:** the modern `Interrupt` carries `id` (a.k.a. `interrupt_id`), `value`, and `resumable`; older code used `when`/`ns`, and there are version-mismatch errors like `Interrupt.__init__() got an unexpected keyword argument 'interrupt_id'` when SDK and runtime versions disagree (issue #5620). The older `NodeInterrupt` (raise-based) is superseded by `interrupt()`. Pin `langgraph`, `langgraph-sdk`, and `langchain` together.

**Prebuilt `HumanInTheLoopMiddleware`** (`langchain.agents.middleware`) gates tool calls; decisions: **approve / edit / reject / respond**.
```python
from langchain.agents import create_agent
from langchain.agents.middleware import HumanInTheLoopMiddleware

agent = create_agent(
    model="gpt-5.5",
    tools=[write_file, execute_sql, read_data],
    middleware=[HumanInTheLoopMiddleware(interrupt_on={
        "write_file": True,                                   # all decisions
        "execute_sql": {"allowed_decisions": ["approve", "reject"]},
        "read_data": False,                                   # no gate
    }, description_prefix="Tool execution pending approval")],
    checkpointer=checkpointer,   # AsyncPostgresSaver in prod
)
# resume:
await agent.ainvoke(Command(resume={"decisions": [{"type": "approve"}]}), config)
await agent.ainvoke(Command(resume={"decisions": [{"type": "edit",
    "edited_action": {"name": "execute_sql", "args": {"query": "SELECT 1"}}}]}), config)
```
**Per-tool `when` predicate** (conditional interrupts) requires a recent `langchain` (1.x): `"write_file": {"allowed_decisions": [...], "when": writes_outside_workspace}` where `when(request: ToolCallRequest) -> bool`.

**Gotchas:** `edit` does not always cancel the model's original intent → the agent may re-attempt the un-edited call (langchain issue #33787). In **deepagents**, subagent interrupt resume currently works for `approve` but **edit/reject can silently fail** because the subagent isn't passed the parent checkpointer/resume context (deepagents issue #554) — gate at the main-agent level or pass a shared checkpointer. Avoid `interrupt()` inside `Send`-parallel branches (undefined ordering).

## 7. Durability + double-texting / concurrency (self-hosted)

### 7.1 Durability modes (≥0.6) [verified]
`durability` replaces the old `checkpoint_during`. Pass to `ainvoke`/`astream`:
- `"exit"` — persist only when the run exits (success/error/interrupt). Fastest; **no mid-run crash recovery**.
- `"async"` (default) — persist asynchronously while the next step runs. Good balance; small risk a checkpoint is lost if the process dies mid-write.
- `"sync"` — persist synchronously before each step. Highest durability; adds write latency.
```python
await graph.ainvoke(payload, config, durability="sync")
```
The deprecated `AsyncShallowPostgresSaver` is replaced by `AsyncPostgresSaver` + `durability="exit"` for shallow-like behavior (but `"exit"` weakens interrupt/crash durability — don't blanket-apply).

**Graceful shutdown (≥1.2) [verified]:** cooperative drain between super-steps on SIGTERM, saving a resumable checkpoint:
```python
import signal
from langgraph.runtime import RunControl
from langgraph.errors import GraphDrained

control = RunControl()
signal.signal(signal.SIGTERM, lambda *_: control.request_drain("sigterm"))
try:
    result = await graph.ainvoke(inputs, config, control=control)
except GraphDrained as e:
    log.info("drained: %s", e.reason)   # resume later with ainvoke(None, config)
```
`request_drain()` does not cancel running tasks; pair with a timeout for a hard bound.

### 7.2 Double-texting is Platform-only — replicate it in OSS [verified that it's Platform-only]
LangGraph's `multitask_strategy` (`reject`/`enqueue`/`interrupt`/`rollback`) lives in **LangGraph Platform** because it needs deployment-level run control (the docs explicitly say this can't be in OSS since OSS doesn't know how the graph is deployed). **OSS has no built-in distributed lock or run manager — you build it.** Pattern: a **Postgres advisory lock keyed on a hash of `thread_id`** plus optimistic concurrency on `checkpoint_id`.

```python
import asyncio
from contextlib import asynccontextmanager

@asynccontextmanager
async def thread_lock(pool, thread_id: str):
    # session-level advisory lock; serializes runs on one thread across replicas
    async with pool.connection() as conn:
        await conn.execute("SELECT pg_advisory_lock(hashtext(%s))", (thread_id,))
        try:
            yield
        finally:
            await conn.execute("SELECT pg_advisory_unlock(hashtext(%s))", (thread_id,))

async def run_turn(graph, pool, thread_id, payload, strategy="reject"):
    config = {"configurable": {"thread_id": thread_id}}
    if strategy == "reject":
        async with pool.connection() as conn:
            row = await (await conn.execute(
                "SELECT pg_try_advisory_lock(hashtext(%s)) AS got", (thread_id,))).fetchone()
            if not row["got"]:
                raise RuntimeError("thread busy")  # reject the second input
            try:
                return await graph.ainvoke(payload, config)
            finally:
                await conn.execute("SELECT pg_advisory_unlock(hashtext(%s))", (thread_id,))
    # enqueue: serialize behind the blocking lock
    async with thread_lock(pool, thread_id):
        return await graph.ainvoke(payload, config)
```
- **enqueue** = blocking advisory lock (runs serialize in arrival order).
- **reject** = `pg_try_advisory_lock`; fail fast if held.
- **interrupt** = cancel the in-flight `asyncio.Task` for that thread (keep a registry `dict[thread_id, Task]`, call `task.cancel()`), then start the new input from the saved checkpoint — handle dangling/partial tool calls.
- **rollback** = interrupt + `aupdate_state`/delete the in-flight checkpoint before the new input.

**Optimistic concurrency on `checkpoint_id`:** before committing a turn, read the current head (`(await graph.aget_state(config)).config["configurable"]["checkpoint_id"]`); if it changed since you started, another writer won → reconcile or retry. **Last-writer-wins risk:** without the lock, two concurrent runs on one `thread_id` both append, producing interleaved/forked lineages and lost updates. There is **no built-in coordination** — you must add it.

## 8. Subgraph namespaces + deepagents

### 8.1 checkpoint_ns [verified]
Each subgraph invocation runs under a `checkpoint_ns` of the form `node:uuid`, nested levels joined by `|` (NS_SEP `|`, NS_END `:`). All parent and subgraph checkpoints share the **same `thread_id`**, differing by `checkpoint_ns`.

**Inherited vs own checkpointer:**
- **Default (inherited):** subgraph writes go through the parent's checkpointer distinguished by `checkpoint_ns`; the parent treats the whole subgraph as **one super-step** → you can only time-travel at the parent boundary (re-running the subgraph from scratch), not between its internal nodes. This is what enables `interrupt()` inside a subgraph to resume via the parent thread_id.
- **`compile(checkpointer=True)`:** the subgraph gets its **own checkpoint history** → time-travel *between* its internal nodes (e.g. between two interrupts). Inspect/fork:
```python
parent_state = await graph.aget_state(config, subgraphs=True)
sub_cfg = parent_state.tasks[0].state.config   # RunnableConfig into the subgraph ns
sub_state = await graph.aget_state(sub_cfg, subgraphs=True)
```
**WARNING (bloat):** subgraph-own-checkpointers create separate namespaces and **duplicate storage**; the LangChain support docs explicitly flag this as a cause of DB growth/OOM. Also, `checkpointer=True` + `interrupt()` has historically conflicted (issue #3206) — test carefully.

### 8.2 deepagents specifics [verified]
`deepagents` (`create_deep_agent`) builds a supervisor + sub-agents (each a `create_agent`/LangGraph graph, or a `CompiledSubAgent` wrapping a custom graph that must expose a `messages` state key). Sub-agents run as subgraphs, so their state — including the **virtual filesystem** — is checkpointed under subgraph namespaces on the AsyncPostgresSaver substrate when you pass `checkpointer=` to the deep agent.
- **Filesystem backends:** `StateBackend` (default, ephemeral — files live in graph state, **checkpointed** with the thread, shared between supervisor and subagents); `FilesystemBackend(root_dir=...)` (real disk, not in state); `StoreBackend` (cross-session, in the Store); `CompositeBackend` (hybrid). Because `StateBackend` files live in `state`, **large files inflate the checkpoint** — keep big artifacts in `FilesystemBackend`/object storage and store references.
- **Checkpoint-size implication:** custom deepagents state schemas must subclass `DeepAgentState` to preserve the `DeltaChannel` reducer on `messages` (keeps growth O(N) not O(N²)).
- **Summarization regression class [verified — issue #2876]:** `SummarizationMiddleware` historically tracked a `_summarization_event` and computed "effective messages" on the fly but **did not emit `RemoveMessage` for the pre-cutoff slice**, so `state["messages"]` was never trimmed → **unbounded checkpoint growth**. The fix/pattern is to emit `Command(update={"messages": [RemoveMessage(REMOVE_ALL_MESSAGES), *summary, *preserved]})`. **Flag this as a real regression class:** summarization that doesn't trim persisted state grows the checkpoint forever even though the model context looks small.

## 9. CachePolicy + serialization

### 9.1 Node caching (separate from checkpointing) [verified]
```python
from langgraph.types import CachePolicy
from langgraph.cache.memory import InMemoryCache

builder.add_node("expensive", fn, cache_policy=CachePolicy(key_func=lambda s: str(s["x"]), ttl=120))
graph = builder.compile(cache=InMemoryCache(), checkpointer=checkpointer)
```
`CachePolicy(key_func=default_cache_key, ttl=None)` — `key_func` builds the cache key from node input (default hashes input with pickle); `ttl` in seconds (None = never expire). Backends: `InMemoryCache`, `SqliteCache`. **Three distinct mechanisms, do not conflate:** node cache (perf — skip recompute on identical input), checkpoint (state/recovery), pending-writes (crash dedup within a super-step). **Gotchas:** (a) cached nodes don't re-emit custom stream events (`get_stream_writer` payloads) on a cache hit (issue #6265); (b) a bug where `InMemoryCache` + `InMemorySaver` together broke caching (issue #5980) — validate on your versions; (c) the default cache serializer's `pickle_fallback` is an RCE vector if the cache backend is attacker-writable (GHSA-mhr3-j7m5-c7c9).

### 9.2 Serialization [verified]
`JsonPlusSerializer` (default): ormsgpack (`>=1.12.0`) + extended-JSON fallback for LangChain/LangGraph types, datetimes, enums. `pickle_fallback=True` handles arbitrary objects but is risky. Keep large bytes external (store references). `EncryptedSerializer` (§3.7) for at-rest encryption. `LANGGRAPH_STRICT_MSGPACK=true` / `allowed_msgpack_modules` allow-list for deserialization safety (see CVE-2025-64439 / GHSA-g48c-2wqr-h844, §3.7).

## 10. Capability Catalog

**1. Cross-turn / cross-session resume.** Send only the new input + `thread_id`; the saver rehydrates full runtime state (tool_call↔result pairing intact). Higher fidelity and cheaper than re-sending a reconstructed history. *Note: the model still reads (and is billed for) the input tokens of whatever history is in context.* Code: §3.5. *Gotcha:* a new `thread_id` starts an empty state — persist the id client-side.

**2. Durable HITL.** Interrupts survive process restarts and span turns/sessions because state is in Postgres; resume in a later session with `ainvoke(Command(resume=...), config)` on the same `thread_id`. *Gotcha:* node re-runs from top (§6).

**3. Time-travel / replay.** Walk `aget_state_history`, then `ainvoke(None, snapshot.config)`. Nodes *before* the checkpoint are skipped (results saved); nodes *after* re-run — **LLM/tool calls re-fire and may differ; interrupts always re-trigger**. Deterministic only for non-LLM nodes. *Gotcha:* replaying the final checkpoint (no `next`) is a no-op.

**4. Branching / forking.** `aupdate_state` at an old checkpoint creates a NEW lineage in the SAME thread without rolling back the original:
```python
hist = [s async for s in graph.aget_state_history(config)]
target = next(s for s in hist if s.next == ("write_joke",))
fork_cfg = await graph.aupdate_state(target.config, {"topic": "chickens"}, as_node="generate_topic")
await graph.ainvoke(None, fork_cfg)
```
*Edit-a-message-and-retry* (same-thread fork): re-emit the user message with its existing `id` to replace it, then resume. **fork-via-checkpoint_id** (one thread, many lineages — compact, shared history, needs a branch→head map) vs **per-branch-thread_id** (copy state into a fresh thread — clean isolation, duplicated storage, simpler authz). *Gotcha (issue #4987):* after time-travel-then-invoke, `checkpoint_id` can fail to update for true forks — capture the returned config explicitly.

**5. What-if / parallel exploration.** Fork N times from one checkpoint and run continuations concurrently (separate thread_ids or distinct fork configs). **N× cost and N× side effects** — gate write tools (HITL/feature-flag) so parallel explorations don't all send emails.

**6. Undo / redo.** Navigate `parent_config` lineage to step back; continuing from an older snapshot **forks** a branch (the original is preserved). **Redo requires remembering which child** you forked to (keep your own branch→checkpoint_id map).

**7. State editing / steering.** `aupdate_state` to fix a wrong tool result, inject context, edit a pending tool call's args, change routing, or patch messages, then `ainvoke(None, config)` to continue. Use `as_node` to attribute the edit.

**8. Crash recovery / durable execution.** Resume an in-flight run after a worker crash via `ainvoke(None, config)`; pending writes mean completed nodes aren't re-run (§3.8). **"Exactly-continue-once" caveats:** checkpoints save *between* nodes, not *inside* a node — a long loop inside one node restarts from the loop top, so external side effects inside a node **must be idempotent** (wrap them in `@task` for memoized results). **There is no built-in failure detector or distributed lock** — you orchestrate detection (heartbeats), resumption, and dedup (§7.2). Checkpoints are a save-point, not guaranteed completion.

**9. Long-running / background / async runs (OSS replication of Platform background runs).** Don't use Platform `runs.create/join`. Launch the run server-side so it survives client disconnect:
```python
import asyncio
from fastapi.responses import StreamingResponse
RUNS: dict[str, asyncio.Task] = {}

@app.post("/threads/{thread_id}/runs")
async def start_run(thread_id: str, payload: dict):
    config = {"configurable": {"thread_id": thread_id}}
    async def _run():
        async with thread_lock(app.state.pool, thread_id):
            await app.state.graph.ainvoke(payload, config, durability="async")
    RUNS[thread_id] = asyncio.create_task(_run())   # continues after the client leaves
    return {"thread_id": thread_id, "status": "started"}

@app.get("/threads/{thread_id}/runs/stream")        # reconnect & resume the stream
async def resume_stream(thread_id: str):
    config = {"configurable": {"thread_id": thread_id}}
    async def gen():
        async for chunk in app.state.graph.astream(None, config, stream_mode="values"):
            yield f"data: {chunk}\n\n"
    return StreamingResponse(gen(), media_type="text/event-stream")
```
Persist `thread_id` client-side to rejoin. For durability beyond one process use a task queue (Celery/Arq/RQ) whose worker calls `ainvoke`; the checkpoint in Postgres is the source of truth. (Platform's `runs.create` is the managed equivalent — contrast only.)

**10. Multi-agent / sub-agent continuity.** §8 — subgraph/sub-agent state (incl. deepagents supervisor + sub-agents + virtual FS) checkpointed under namespaces on the same thread.

**11. Memory & context-window management.** Checkpoint = working memory; combine with Store/vector memory for cross-thread facts. **`trim_messages` only trims the model's view for one call; it does NOT prune persisted state** — to actually shrink the checkpoint you must emit `RemoveMessage`. Summarize-then-truncate **must** emit `RemoveMessage` or the checkpoint grows unbounded (deepagents issue #2876). Offload large artifacts external; use `DeltaChannel` for append-heavy channels.

**12. Cost & latency.** Resume-not-replay saves recompute; but stuffing all history into context still costs input tokens every turn. `durability="sync"` adds write latency per step; `"async"`/`"exit"` reduce it at a recovery-risk cost. Tune durability per workload.

**13. Observability / audit / debugging.** `aget_state_history` is an ordered, replayable ledger; `metadata` carries `source`/`step`/`writes`/`parents`. Find the checkpoint where an interrupt/error occurred via `snapshot.tasks[*].interrupts`/`.error`. LangSmith tracing layers on top — **traces are separate from thread state and are NOT deleted by your TTL/GC**, so audit history persists independently.

**14. Cross-device continuity & collaboration.** State is DB-backed, so any worker rehydrates by `thread_id`. **Replicate Platform's thread-status "agent inbox" in OSS** by maintaining your own status (a `threads` table column, or by querying checkpoints): a thread is "awaiting human" if its latest `StateSnapshot.next` is non-empty and `tasks[*].interrupts` is populated.
```python
async def inbox(graph, thread_ids):
    out = []
    for tid in thread_ids:
        s = await graph.aget_state({"configurable": {"thread_id": tid}})
        if s.interrupts:                      # pending human input
            out.append({"thread_id": tid, "interrupt": s.interrupts[0].value})
    return out
```
Add concurrency/locking from §7.2.

**15. Caching / dedup.** Node cache (§9) — separate from checkpoint and pending-writes.

### Capabilities I haven't listed
- **Approval queues / agent inbox** built on interrupt status (above).
- **Deterministic test fixtures** via `aupdate_state(..., as_node=...)` to seed state on a fresh thread.
- **Encryption-at-rest** (§3.7) and **multi-tenant isolation** via `thread_id` namespacing + authz.
- **Scheduled / sleep-time continuation:** OSS replication of Platform crons — a scheduler (APScheduler/cron) that calls `ainvoke(None, config)` or a new input on a thread after a delay (Platform uses `after_seconds`/cron).
- **Resumable SSE streaming** pairing HTTP `Last-Event-Id` with `checkpoint_id`/run id so a reconnecting client resumes the stream from the right point.

## 11. Patterns & design space
- **Thread/checkpoint identity:** allocate `thread_id = f"{tenant}:{user_id}:{conversation_id}"` for natural multi-tenant isolation + authz. Capture `checkpoint_id` from `StateSnapshot.config["configurable"]["checkpoint_id"]` after each turn for branching.
- **Branching chat tree → lineages:** keep a `branch_name → head_checkpoint_id` map in your own table; fork-at-checkpoint for compactness (shared prefix) vs per-branch-thread_id for isolation. Worked example in §10 capability 4.
- **Retention/TTL/GC:** §3.6 — real SQL sweep keyed on `last_used_at`, `adelete_thread`, or time partitioning; refresh-on-use; never break branch-from-old (key on activity, not creation).
- **Checkpoint vs Store decision guide:** thread-scoped conversation/run state → checkpointer; cross-thread durable facts/preferences/semantic memory → Store. Raw logs → checkpointer, never Store.
- **Serialization/large state:** keep bytes external; `EncryptedSerializer` + strict msgpack.
- **Concurrency:** advisory locks + optimistic `checkpoint_id` checks (§7.2).
- **Security/isolation/privacy:** at-rest encryption, strict msgpack, `thread_id` authz, per-tenant isolation, TLS `verify-full`.
- **Anti-patterns & limits:** unbounded growth (no trim); summaries that don't `RemoveMessage`; subgraph-own-checkpointers duplicating storage; treating checkpoints as durable execution; stale cross-branch state; blanket high durability; **MemorySaver/InMemorySaver or SqliteSaver in production** (mentioned once for contrast — not restart-durable / poor write concurrency; use AsyncPostgresSaver).

## 12. LangGraph Platform contrast + OSS replication summary
| Platform feature | OSS self-hosted replication |
|---|---|
| Background runs (`runs.create`/`join`) | `asyncio.create_task` / task queue + reconnect via `astream(None, config)` (§10 capability 9) |
| Thread-status "agent inbox" | Query `aget_state(...).next`/`.interrupts` or a `threads` status column (§10 capability 14) |
| Double-texting `multitask_strategy` | Postgres advisory lock + optimistic `checkpoint_id` (§7.2) |
| Cron / scheduled runs | APScheduler/cron calling `ainvoke(None, config)` (§10) |
| TTL config | Your own SQL sweep / partition drops / `adelete_thread` (§3.6) |
| Managed encryption (`LANGGRAPH_AES_KEY`/JSON keys) | `EncryptedSerializer.from_pycryptodome_aes()` (§3.7) |
| Managed Postgres + pgvector | Your AsyncPostgresSaver pool + AsyncPostgresStore (§3) |

## 13. Sources
**Verified from docs/source:**
- langgraph-checkpoint-postgres PyPI (3.1.0); reference.langchain.com AsyncPostgresSaver; `base.py` MIGRATIONS (github commit b674dd46) — schema, setup, kwargs, strict msgpack.
- docs.langchain.com: durable-execution (durability modes, graceful shutdown ≥1.2), interrupts, time-travel, memory/Store, human-in-the-loop middleware, deepagents subagents/context-engineering.
- reference.langchain.com: CachePolicy, checkpoints, deepagents, EncryptedSerializer.
- psycopg.org (psycopg 3.3 prepared-statements + connection-pool docs); psycopg Discussion #21 (prepare_threshold default 5); pgbouncer.org / Crunchy Data (transaction-mode prepared statements, v1.21/1.22).
- Security advisories: CVE-2025-64439 / GHSA-wwqv-p2pp-99h5; GHSA-g48c-2wqr-h844; GHSA-mhr3-j7m5-c7c9; CVE-2025-67644 (SQLite — not Postgres).
- GitHub issues (version-specific, flagged): #3557 task_path, #3193 pipeline, #5980/#6265 cache, #2876 deepagents summarization, #554 deepagents subagent interrupt, #5620 Interrupt.interrupt_id, #4987 fork checkpoint_id, #3206 subgraph checkpointer+interrupt.
- langgraph `double_texting.md` — Platform-only confirmation.

**Inference / needs validation:** `bulk_update_state` exact signature; native partitioning of stock tables (must be custom DDL); pool `check`/keepalive specifics per driver version.

**Version-sensitive:** durability modes (≥0.6), graceful shutdown `RunControl`/`GraphDrained` (≥1.2), DeltaChannel/`DeepAgentState` (deepagents ≥0.6.6), `Interrupt` fields (v0.6), HITL `when` predicate (langchain 1.x), strict-msgpack default flip + JsonPlusSerializer RCE patch (langgraph-checkpoint 3.0), PgBouncer prepared-statement support (≥1.21; psycopg3 needs ≥1.22).