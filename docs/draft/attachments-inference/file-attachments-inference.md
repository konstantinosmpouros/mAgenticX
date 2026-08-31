# File Attachments & Multimodal Content in Conversational AI Agent Inference — and Where They Live Across the AsyncPostgresSaver Checkpoint and the deepagents Filesystem

*Companion to the prior LangGraph checkpointer report. Scope: LangGraph + deepagents + LangChain core only. Verified against LangChain v1 / langchain-core content blocks, deepagents 0.6.10, langgraph-checkpoint-postgres 3.1.0, langgraph-checkpoint 3.0+ (June 21, 2026). Items marked **[INFERENCE]** are reasoned from verified primitives but not lifted verbatim from docs.*

## 1. TL;DR — the mental model

**The single most important decision is WHERE an attachment lives across turns, because that determines cost, context size, resume behavior, and whether it survives a fork.** There are three homes, and they have completely different persistence semantics:

- **In the checkpoint** (graph state / message list, serialized into Postgres by `AsyncPostgresSaver`): multimodal message blocks and deepagents `StateBackend` files live here. They persist across turns on a thread, fork *with* the checkpoint, and vanish when the checkpoint is reaped — but they bloat every checkpoint write.
- **On a disk/external filesystem** (deepagents `FilesystemBackend`) or **cross-thread store** (`StoreBackend` over a LangGraph `BaseStore`): files live *outside* the checkpoint. They survive checkpoint deletion, don't bloat checkpoints, but do **not** fork with the checkpoint — so a fork can desync from disk state.
- **At the provider** (a base64 data URL is still in-message; a provider file ID points to bytes held by OpenAI/Anthropic): only the *reference* (file ID) is cheap to persist; the bytes are billed as image/document tokens regardless of how you reference them.

**The five routes to get a user file into inference** (Section 4): (1) multimodal message block on a `HumanMessage`; (2) write the upload to the deepagents filesystem and let the agent `read_file`/`grep` it; (3) extract/summarize to text and inject that; (4) provider Files API + file-ID reference; (5) hybrid — file on the filesystem plus a short reference/summary in the message.

**The headline edge cases** (Section 5): the base64-as-text blowup (serializing a multimodal message to a string tokenizes the whole base64 — orders-of-magnitude cost); a multimodal image silently dropped (or kept) by `trim_messages`; orphaned disk files after a fork; checkpoint row/blob bloat from files-in-state; filesystem↔checkpoint desync on branch; re-upload needed on a checkpoint-miss; a non-vision model handed an image; tool-generated artifact files; a deepagents permission-deny firing on an `input/` write; an oversized state row in Postgres; a sub-agent writing files the parent checkpoint must capture; and binary that breaks `JsonPlusSerializer`.

---

## 2. Foundations

### 2.1 Foundations A — Multimodal & file content in LangChain messages

**The content-block model.** A `HumanMessage` / `AIMessage` / `ToolMessage` carries non-text content as a *list of content blocks* rather than a string. LangChain's `content` attribute may be either a plain string or a list of block dicts. Each block specifies a `type` (`text`, `image`, `file`/document, `audio`, `video`) and a payload.

**Version sensitivity (CRITICAL — this format moved between v0.3 and v1):**

- **v0.3 (legacy / provider-native):** you passed either the provider's own dict (e.g. OpenAI's `{"type": "image_url", "image_url": {"url": ...}}`) or a LangChain "v0" data block with `source_type` (`{"type": "image", "source_type": "base64", "data": ..., "mime_type": ...}` / `source_type: "url"` / `source_type: "id"`).
- **v1 (current, langchain-core ≥ 1.0):** LangChain introduced **standard, typed content blocks** exposed via the `.content_blocks` property on every message, and a `content_blocks=` constructor kwarg. The v1 image block is flatter: `{"type": "image", "url": ...}` OR `{"type": "image", "base64": ..., "mime_type": "image/jpeg"}` OR `{"type": "image", "file_id": "file-abc123"}`. `.content_blocks` lazily derives the standard representation from existing content, so old code keeps working. To *store* v1 blocks in `content`, set `output_version="v1"` on the model (`init_chat_model("gpt-5-nano", output_version="v1")`) or `LC_OUTPUT_VERSION=v1`.

Building a multimodal `HumanMessage` for an **image** (v1 standard blocks):

```python
from langchain.messages import HumanMessage

# Image by URL
msg = HumanMessage(content_blocks=[
    {"type": "text", "text": "Describe the weather in this image."},
    {"type": "image", "url": "https://example.com/photo.jpg"},
])

# Image as inline base64
import base64
b64 = base64.b64encode(open("photo.jpg", "rb").read()).decode("utf-8")
msg = HumanMessage(content_blocks=[
    {"type": "text", "text": "What's in this image?"},
    {"type": "image", "base64": b64, "mime_type": "image/jpeg"},
])
```

For a **PDF / document** (the `file` block type — for anything that isn't image/audio/plaintext):

```python
pdf_b64 = base64.b64encode(open("report.pdf", "rb").read()).decode("utf-8")
msg = HumanMessage(content_blocks=[
    {"type": "text", "text": "Summarize this PDF."},
    {"type": "file", "base64": pdf_b64, "mime_type": "application/pdf",
     "filename": "report.pdf"},   # OpenAI REQUIRES filename for PDFs
])
```

> **Gotcha — OpenAI requires `filename` on PDF file blocks.** Omitting it produces an opaque `400 Missing required parameter: 'messages[0].content[1].file.file_id'` (tracked in langchainjs issue #9512). Always set `filename` (or `metadata.filename`) for `application/pdf`.

**How files are referenced — three mechanisms, three tradeoffs:**

| Reference | What it is | When to use | Limits / support |
|---|---|---|---|
| **base64 inline** (`base64` + `mime_type`) | bytes embedded in the message | one-shot, file not hosted anywhere | bloats request payload ~33%; counts against request-size caps; the bytes ride in the checkpoint forever |
| **remote URL** (`url`) | model fetches the URL | file is already hosted and reachable | OpenAI **Chat Completions does not accept file URLs** (only the Responses API does — langchainjs #9895); images-by-URL widely supported |
| **provider file ID** (`file_id`) | reference to bytes uploaded via the provider's Files API | repeated reference to the same file; keep the checkpoint tiny | provider-specific; file IDs expire; OpenAI requires the file be uploaded with the correct `purpose` |

**Provider normalization — what's lossy.** The `BaseChatModel` abstraction is "leaky" for non-text content (per practitioner reports): there is **no universal cross-provider wire format**. LangChain's per-provider adapters translate standard blocks into provider-native JSON — OpenAI Chat Completions uses `{"type": "image_url", ...}` and `{"type": "file", "file": {...}}`; Anthropic uses `{"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": ...}}`. Consequences:
- **Images:** broadly supported by OpenAI, Anthropic, Gemini.
- **PDFs / documents:** supported by OpenAI, Anthropic, Gemini — but with provider quirks (Gemini has thrown `400 The document has no pages` via langchain-google; OpenAI needs `filename`).
- **Audio/video:** spotty; LangChain's OpenAI converter has historically missed video block conversion (langchain issue #33652).
- **File URLs:** only some APIs (OpenAI Responses, Anthropic URL source) accept them.

> **Verify per provider, per version.** The integration table on docs.langchain.com is authoritative for which model accepts images/audio/documents and as which reference type.

**Tokenization reality (the most important cost fact).** Images and documents are billed by the provider as **image/document tokens computed from the media itself**, *not* from the length of the base64 string. Per Anthropic's PDF support docs, the system "converts each page of the document into an image. The text from each page is extracted and provided alongside each page's image" — so each page incurs **both** extracted-text tokens ("Depending on content density, each page typically requires between 1,500 and 3,000 tokens. Standard input token pricing applies, with no extra fees for PDF processing") **and** per-page image tokens (a 1024×1024 image ≈ ~1,600 tokens per Anthropic's token-counting guidance). The catastrophic anti-pattern:

> **GOTCHA — the base64-as-text blowup.** If you `str()` / `json.dumps()` a multimodal message (or otherwise flatten a content-block list into a text prompt), the entire base64 blob becomes **text** and is tokenized character-by-character. A 5 MB image ≈ ~6.7 MB of base64 ≈ on the order of ~1.7M text tokens — instantly blowing the context window and producing context-length errors, at full text-token cost. The correct path keeps the bytes inside a proper `image`/`file` content block so the provider applies image/document token accounting. **Detection:** scan outgoing message content for long (>10k char) base64-looking strings sitting inside a `text` block. **Prevention:** never concatenate content blocks into a string; always pass the list form.

**Tool-produced files/artifacts.** A tool can return both a small text payload for the model and a large/binary artifact kept out of the prompt, via `response_format="content_and_artifact"`:

```python
from langchain_core.tools import tool

@tool(response_format="content_and_artifact")
def render_chart(spec: str) -> tuple[str, dict]:
    """Render a chart and return a short description + the image artifact."""
    png_b64 = make_chart(spec)
    return ("Rendered a bar chart of the top categories.",       # -> ToolMessage.content (model sees this)
            {"type": "image", "base64": png_b64, "mime_type": "image/png"})  # -> ToolMessage.artifact (downstream only)
```

The tool's output becomes a `ToolMessage(content=..., artifact=..., tool_call_id=...)`. The `artifact` field is **"not meant to be sent to the model"** — it stays in graph state and is available to downstream nodes/your app. Note: LangGraph's prebuilt `ToolNode`/`create_react_agent` historically surface only `content` into the loop, not `artifact` (langgraph discussion #4221) — the artifact is still stored on the message in state and reachable there.

### 2.2 Foundations B — Files as persistent agent state in deepagents

deepagents exposes a virtual filesystem to the agent through six tools — `ls`, `read_file`, `write_file`, `edit_file`, `glob`, `grep` (plus `execute` on sandbox/shell backends) — all routed through a pluggable **backend** implementing `BackendProtocol`. Pluggable backends arrived in **deepagents 0.2**; the crux for this report is *where each backend physically stores bytes*.

| Backend | Where files live | In the checkpoint? | Persistence |
|---|---|---|---|
| **`StateBackend`** (default) | the LangGraph `files` channel in agent state | **YES** — rides inside the checkpoint | per-thread; persists across turns via checkpoints; gone when thread/checkpoint is deleted |
| **`FilesystemBackend(root_dir=..., virtual_mode=...)`** | real files on host disk under `root_dir` | **NO** | survives independently of checkpoint; external |
| **`StoreBackend(namespace=...)`** | a LangGraph `BaseStore` (Postgres/Redis/cloud), namespaced | **NO** | cross-thread, durable, outside checkpoint |
| **`LocalShellBackend`** | host disk + `execute` shell | **NO** | external; unrestricted host access |
| **`CompositeBackend(default=..., routes={...})`** | routes path prefixes to different backends (longest-prefix wins) | **mixed** | per-route |

The canonical hybrid pattern routes ephemeral scratch to state and durable memory to a store:

```python
from deepagents import create_deep_agent
from deepagents.backends import CompositeBackend, StateBackend, StoreBackend
from langgraph.store.memory import InMemoryStore  # local dev; omit on LangSmith Deployment

agent = create_deep_agent(
    model="openai:gpt-5.5",
    backend=CompositeBackend(
        default=StateBackend(),                       # /workspace/plan.md -> checkpoint
        routes={"/memories/": StoreBackend()},        # /memories/* -> cross-thread store
    ),
    store=InMemoryStore(),
)
```

> **Backend factories are deprecated (deepagents 0.5.0).** Pass *instances* (`StateBackend()`), not `lambda rt: StateBackend(rt)`. Backends now resolve runtime context internally via `get_config()`/`get_store()`/`get_runtime()`. The factory form still works but warns.

**`FileData` and the `files` channel (verified against `protocol.py` and `filesystem.py`, deepagents 0.6.x).** State-backed files are stored as a `dict[str, FileData]` where:

```python
class FileData(TypedDict):
    content: str                    # utf-8 text OR base64-encoded binary
    encoding: str                   # "utf-8" or "base64"
    created_at: NotRequired[str]    # ISO 8601
    modified_at: NotRequired[str]   # ISO 8601
```

This is the **v2 format** (current default): `content` is a plain `str` plus an `encoding` field; binary files (images/PDF/audio/video) are stored base64 with `encoding="base64"`. The legacy **v1** format stored `content` as a `list[str]` (lines) with no `encoding`; the Mar 10 2026 changelog updated State/Store backends to support binary for multimodal. The `files` channel itself is declared:

```python
class FilesystemState(AgentState):
    files: Annotated[NotRequired[dict[str, FileData]],
                     DeltaChannel(_file_data_delta_reducer, snapshot_frequency=50)]
```

The reducer treats a **`None` value as a deletion marker** (the key is popped), and non-`None` values overwrite — so parallel `write_file` calls in one super-step merge cleanly, and deletes propagate. `DeltaChannel` (deepagents 0.6, beta) stores only the incremental delta per step rather than re-serializing the whole `files`/`messages` dict on every checkpoint, with a full snapshot every ~50 pregel steps "to bound read depth." LangChain reports this turns checkpoint growth from **O(N²) → O(N)**; per LangChain CEO Harrison Chase, "Deep Agents v0.6 brings Delta channels, reducing checkpoint storage by up to 100x for long-running agents, without sacrificing observability or resilience" — a vendor figure demonstrated on a 200-turn coding-agent session, not independently measured.

**`read_file` returns multimodal content for binary.** Across all backends, `read_file` natively recognizes images (`.png/.jpg/.jpeg/.gif/.webp`) and (in deepagents ≥ 1.9.0 JS / current Python) PDFs/audio/video, returning a `ToolMessage` whose content is a content block `{"type": <image|file>, "base64": ..., "mime_type": ...}` rather than a base64 *string*. This is what lets a vision model actually "see" a file the agent read — and it's exactly why you must not stringify it.

**`FilesystemPermission` — locking paths.** Permissions are evaluated in middleware (`wrap_tool_call`) *before* the backend is called:

```python
from deepagents import create_deep_agent, FilesystemPermission

agent = create_deep_agent(
    model="openai:gpt-5.5",
    permissions=[
        # read-only user uploads: deny all writes under /input/
        FilesystemPermission(operations=["write"], paths=["/input/**"], mode="deny"),
        # read-write agent artifacts under /output/ (allow is the default)
        FilesystemPermission(operations=["write"], paths=["/output/**"], mode="allow"),
    ],
)
```

`FilesystemPermission` is a dataclass with `operations: list[Literal["read","write"]]`, `paths: list[str]` (glob patterns, must start with `/`, no `..`/`~`), and `mode: Literal["allow","deny"] = "allow"`. The tool→operation map is fixed: `ls/read_file/glob/grep → read`, `write_file/edit_file → write`. A common lock-down idiom is allow-then-deny-rest: `FilesystemPermission(["write"], ["/memories/**"])` followed by `FilesystemPermission(["write"], ["/**"], mode="deny")`.

**Sub-agents share the filesystem.** A deepagents sub-agent (spawned via the `task` tool) gets an **isolated** message history and todos, but **shares the `files`/backend with the parent**. Per the docs: any file a sub-agent writes "will remain in the LangGraph agent state even after that subagent's execution is complete" and stays available to the supervisor and other sub-agents. **Consequence for the checkpoint:** because `StateBackend` files are a parent-state channel, **a sub-agent's file writes are captured in the parent thread's checkpoint** — this is how sub-agents coordinate (one writes notes, another reads them) and how their work survives. Sub-agent *skills* and *messages*, by contrast, are isolated and not propagated.

---

## 3. The core — Attachments × the persistent AsyncPostgresSaver checkpointer

`AsyncPostgresSaver` (async, `langgraph-checkpoint-postgres` 3.1.0) snapshots graph state every super-step into Postgres. `.setup()` creates `checkpoints` (JSONB core state), `checkpoint_blobs` (large serialized channel values as `BYTEA`), `checkpoint_writes` (intermediate writes), and `checkpoint_migrations`. Serialization is `JsonPlusSerializer` (ormsgpack + extended-JSON fallback). Connections must use `autocommit=True` and `row_factory=dict_row`.

```python
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

async with AsyncPostgresSaver.from_conn_string(DB_URI) as checkpointer:
    await checkpointer.setup()
    agent = create_deep_agent(model="openai:gpt-5.5", checkpointer=checkpointer)
    config = {"configurable": {"thread_id": "user-42"}}
    await agent.ainvoke({"messages": [msg]}, config)
```

### 3.1 What lives where — the decision map

| Thing | Home | In Postgres checkpoint? | Persists across turns (same thread)? | Forks with checkpoint? | Survives checkpoint reaping? |
|---|---|---|---|---|---|
| Multimodal message block (inline base64/URL/file_id) on a `HumanMessage` | message list channel | **YES** (bytes if base64; just the ref if URL/file_id) | **YES** | **YES** | **NO** (gone with the thread) |
| deepagents `StateBackend` file | `files` channel | **YES** | **YES** | **YES** | **NO** |
| deepagents `FilesystemBackend` file (disk) | host disk | **NO** | **YES** (if disk persists) | **NO** | **YES** (orphans unless GC'd) |
| deepagents `StoreBackend` file | LangGraph `BaseStore` | **NO** | **YES** (cross-thread) | **NO** | **YES** |
| Provider file ID (`file_id`) | provider servers; ref in message | ref **YES**, bytes **NO** | **YES** until provider expiry | ref forks, bytes shared | ref dies with thread; bytes at provider |
| Tool `artifact` (binary) | message list (on `ToolMessage`) | **YES** | **YES** | **YES** | **NO** |

### 3.2 Checkpoint bloat — quantify and mitigate

If files/images live in graph state — either as inline base64 message blocks **or** as `StateBackend` files — they serialize into `checkpoint_blobs` on **every super-step**. LangChain's own production guidance (support article "Understanding Checkpointers, Databases, API Memory and TTL") explicitly flags this: *"Large data objects (images, PDFs, videos, documents) stored directly in state as base64 or binary data can cause checkpoint bloat and database memory errors,"* and recommends *"External storage + reference: Upload files to external storage (S3, etc.) and store only the reference key and metadata in state, fetching the data on demand."* The mechanics in Postgres:

- LangGraph **inserts** a new checkpoint per super-step (immutable; no UPDATE). A multi-step run re-serializes the channel values it touches each step.
- PostgreSQL uses a fixed 8 KB page size and a `TOAST_TUPLE_THRESHOLD` of ~2 KB; when a serialized channel value exceeds it, the row is compressed and pushed out-of-line into TOAST storage, generating WAL in ~2 KB chunks — so a 100 KB state payload across a 15-step graph can write ~1.5 MB and spike WAL. (Multi-agent RAG state keys "frequently exceed 100KB.")
- Real-world scale: the Tiendanube production write-up ("Scaling LangGraph's Postgres Checkpointer in Production") reports processing "more than 120,000 conversations per week," where "an average conversation… generates around 93 records across the four tables," and "after a week of testing in a staging environment with controlled traffic, the checkpoint_blobs table grew up to 56 MB with almost 18,000 records" — and that was *without* attachments. Inlining a few MB of base64 per turn multiplies this dramatically.

**Mitigations (in priority order):**
1. **Store references, not bytes.** Keep large files on a `FilesystemBackend`/`StoreBackend` (or object store) and keep only a path/handle + short summary in state.
2. **Use provider file IDs** instead of inline base64 so the message channel holds `{"type": "image", "file_id": "..."}` (a few bytes) not megabytes.
3. **Extract/summarize** (Route 3) — convert PDF→text/summary; never persist the raw bytes.
4. **deepagents large-result eviction** auto-dumps any tool result exceeding `tool_token_limit_before_evict` (default 20,000 tokens) to `/large_tool_results/{tool_call_id}` and replaces it with a truncated preview + file reference — keeping the message channel lean.
5. **DeltaChannel** (deepagents 0.6) stops re-serializing the whole `files`/`messages` dict each step.
6. **Size thresholds:** gate inlining at a small ceiling (e.g. a few hundred KB) and route anything larger to disk/store + reference. **[INFERENCE]** the exact threshold is an application choice; the principle (keep per-checkpoint payload well under TOAST/WAL pain) is from the LangChain bloat guidance above.

### 3.3 Resume (cross-turn) — the delta-only input pattern

When you resume a thread (same `thread_id`, no `checkpoint_id`), `AsyncPostgresSaver` restores the latest checkpoint — which already contains the full message history **and** the `StateBackend` `files`. Therefore:

- **Attachments already in state/filesystem do NOT need to be re-supplied.** You send only the *new* turn's input (the delta), e.g. `await agent.ainvoke({"messages": [HumanMessage("now compare it to last quarter")]}, config)`. The prior image/PDF (if inlined in an earlier `HumanMessage`, or sitting in `StateBackend`) is restored from the checkpoint and remains in context. This is the **delta-only input pattern**.
- **Failure mode (disk-backed):** if the file was on a `FilesystemBackend` and the disk/volume was lost (pod recycled, ephemeral container), the checkpoint restores fine but `read_file` now fails — the *handle* survived in state, the *bytes* did not. State-backed files don't have this problem (they're in the checkpoint); disk-backed files require durable volumes or a store.

### 3.4 Branching / fork — the hard part

Forking from a past `checkpoint_id` (edit-and-retry, what-if) is done with `update_state`, which writes a **new checkpoint descending from the chosen one** (`source="fork"`). The original timeline stays intact.

```python
# find a past checkpoint
history = [s async for s in agent.aget_state_history(config)]
target = history[3]                                  # some earlier point

# fork: edit the user's prompt and branch
fork_config = await agent.aupdate_state(
    target.config,
    {"messages": [HumanMessage("Re-analyze, but treat the PDF as a contract.")]},
)
await agent.ainvoke(None, fork_config)               # runs forward on the new branch
```

The consequence for attachments:

- **State-backed files & inline message blocks fork WITH the checkpoint.** Because they are channel values captured in the forked checkpoint, the new branch sees the file state *as it was at the fork point*. Edit-and-retry "just works." **[INFERENCE — confirmed by subagent]:** there is no explicit doc statement on `update_state`+files, but it follows directly from `files` being a checkpoint channel.
- **Disk-backed (`FilesystemBackend`) and `StoreBackend` files do NOT fork.** They live outside the checkpoint, so both branches read/write the *same* live disk/store. Forking the checkpoint does not branch the disk → the filesystem and the checkpoint **desync**: branch B can see file edits made by branch A, or files that "shouldn't exist yet" on B's timeline.

**Keeping them consistent (strategies):**
- **Prefer `StateBackend` for fork-sensitive files** so they ride the checkpoint and fork automatically.
- **Per-branch namespacing:** route store files by `checkpoint_id`/branch id (`StoreBackend(namespace=lambda rt: (rt.execution_info.thread_id, branch_id))`) so each branch gets isolated storage. **[INFERENCE]**
- **Copy-on-fork:** on `update_state`, snapshot the relevant disk/store paths into a branch-specific prefix before resuming. **[INFERENCE]**
- **Content-addressing:** store immutable blobs by content hash and keep only the hash in state; forks then reference the same immutable blob safely (no mutation desync). **[INFERENCE]**

> **GOTCHA — fork IDs.** A LangGraph issue (#4987) noted that replaying with a given `checkpoint_id` could fail to mint a new id in some versions, breaking subsequent history. Verify your langgraph version forks to a fresh `checkpoint_id`.

### 3.5 TTL / GC interaction

**There is no native TTL in the OSS Postgres checkpointer.** TTL is a LangGraph Platform / LangSmith Deployment feature configured in `langgraph.json` (`checkpointer.ttl` with `strategy: "delete"`, `default_ttl` minutes, `sweep_interval_minutes`); a background sweeper deletes expired threads (and all their checkpoints/writes) — but only for threads created after the config is deployed, and Postgres itself has no native expiry (Redis/DynamoDB savers do). Self-hosted OSS users build their own: a cron running `DELETE` by age, or `await checkpointer.adelete_thread(thread_id)`.

Implications for attachments:
- **State-backed files & inline blocks vanish *with* the checkpoint** when a thread is reaped — clean, no orphans.
- **Disk-backed / store files orphan** unless you GC them in lockstep. **Design:** tie attachment cleanup to checkpoint lifecycle — when you delete/expire a thread, also delete its disk prefix / store namespace. Namespacing store files by `thread_id` makes this a single-prefix delete. **[INFERENCE]** for the lockstep design; the "orphan unless GC'd" risk is the direct corollary of files-outside-checkpoint.

### 3.6 Cold-path / checkpoint-miss

If a turn arrives but the checkpoint is gone (TTL reaped, wrong `thread_id`, DB wiped):
- **Re-seed a fresh checkpoint.** The very first `ainvoke` on a new `thread_id` creates a new checkpoint.
- **Re-establish attachments:** for the model to see prior files again you must re-inject them — re-attach as message blocks (re-upload base64 or re-reference a still-valid provider `file_id`), or **rehydrate the filesystem** by re-writing the uploads into `StateBackend`/disk before the agent runs. If you used durable disk/store + references, the bytes may still be there and you only re-seed the *handles*.
- **Detection:** `await agent.aget_state(config)` returning empty/`next=()` for a thread you expected to exist signals a miss.

### 3.7 Serialization specifics on Postgres

`JsonPlusSerializer` first tries **ormsgpack** (binary msgpack) and falls back to an extended JSON for LangChain/LangGraph types, datetimes, enums, etc. Key facts for attachment-bearing state:
- **Multimodal content blocks** are plain dicts of JSON-safe primitives (`type`, `url`/`base64`/`file_id`, `mime_type`, strings) → they msgpack cleanly into `checkpoint_blobs`.
- **`StateBackend` `FileData`** stores binary as a **base64 `str`** with `encoding="base64"` → also JSON/msgpack-safe. (This is *why* deepagents base64-encodes binary into state rather than storing raw `bytes`.)
- **Raw `bytes`/`bytearray`** are handled by the serializer as dedicated types, but **arbitrary non-serializable Python objects in state break serialization** — e.g. forum reports of `Object of type AIMessage is not JSON serializable` when objects are mishandled. **Rule:** keep state values to JSON/msgpack-safe types (or LangChain message objects); never stash an open file handle, a numpy array, a PIL `Image`, etc. directly in state.

> **GOTCHA — binary that breaks the serializer.** A non-serializable object (PIL image, custom class without `Serializable`) placed in a state channel will fail the checkpoint write. Convert to base64 `str` + `mime_type` (a content block or `FileData`) first.

> **GOTCHA — `JsonPlusSerializer` security.** Pre-3.0 the JSON fallback had an RCE — GitHub Advisory GHSA-wwqv-p2pp-99h5 / **CVE-2025-64439** (CVSS 7.4 High, published 2025-11-07), affecting langgraph-checkpoint <3.0: "if illegal Unicode surrogate values caused serialization to fail, it would fall back to using the 'json' mode," enabling RCE via the `_reviver` (e.g. `{"id":["os","system"]}`). It is **fixed in langgraph-checkpoint==3.0.0** (which "introduces an allow-list for constructor deserialization") and in langgraph-api ≥ 0.5. Per the langgraph-checkpoint-postgres 3.1.0 README, "Set `LANGGRAPH_STRICT_MSGPACK=true` or pass an explicit `allowed_msgpack_modules` list when creating your checkpointer. This restricts checkpoint deserialization to known-safe types, preventing code execution if the database is compromised" — especially important now that checkpoints hold user-uploaded bytes.

**At-rest encryption of attachment-bearing state.** Because checkpoints will contain user files (base64 images/PDFs), wrap the serializer with `EncryptedSerializer`:

```python
from langgraph.checkpoint.serde.encrypted import EncryptedSerializer
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

serde = EncryptedSerializer.from_pycryptodome_aes(encryption_key)  # key from env/KMS
checkpointer = AsyncPostgresSaver(conn, serde=serde)
```

This encrypts the serialized blobs (including the attachment bytes) before they hit Postgres.

---

## 4. Flow catalog — getting a user file into inference

### Route 1 — Multimodal message block (attach directly to a `HumanMessage`)
**Mechanic:** build a content-block list (Section 2.1) and pass it to a vision/doc-capable model.
**Code:** as in §2.1.
**Persistence:** the block is part of the `messages` channel → **in the checkpoint**, persists across turns, forks with it. If `base64`, the bytes bloat every checkpoint; if `url`/`file_id`, only the ref persists.
**`trim_messages`/pruning effect:** if a trimming/summarization step drops or `RemoveMessage`s the human turn that held the image, the image leaves context (and, if it was the only copy, is gone from the model's view on resume). `trim_messages` counts tokens via the model and can keep/drop whole messages; a multimodal message is kept or dropped as a unit (it won't half-keep the image). **When to use:** single vision/doc question, model is multimodal, file small enough to inline or hosted/uploaded.

### Route 2 — Filesystem file the agent reads via tools
**Mechanic:** write the upload into deepagents `input/`, let the agent `read_file`/`grep`/`glob` it. `read_file` returns images/PDF as multimodal blocks (so a vision model sees them).
**Code:**
```python
agent = create_deep_agent(
    model="anthropic:claude-...",
    permissions=[FilesystemPermission(operations=["write"], paths=["/input/**"], mode="deny")],
)
# host writes the upload into state-backed /input/ before the run (or via a seeding tool)
await agent.ainvoke({"messages":[HumanMessage("Read /input/report.pdf and summarize")]}, config)
```
**Persistence:** `StateBackend` → in checkpoint (forks, vanishes with thread); `FilesystemBackend`/`StoreBackend` → external (survives, doesn't fork). **Permissions:** lock `input/` read-only, `output/` read-write. **When to use:** multi-step/agentic work over the file, partial reads, sub-agent coordination.

### Route 3 — Extracted / summarized text
**Mechanic:** parse the file outside the model (PDF→text, CSV→rows/stats) and inject the text/summary as a normal `text` block or tool result.
**Persistence:** only text in state → smallest checkpoint, cheapest context. **When to use:** non-vision model; large docs where you don't need pixel-level fidelity; cost/checkpoint minimization. **Tradeoff:** loses visual layout/charts/figures.

### Route 4 — Provider Files API / file-ID reference
**Mechanic:** upload bytes to the provider once, pass `{"type": "image"|"file", "file_id": "file-abc123"}`.
**Persistence:** the *reference* persists in the checkpoint (tiny); the *bytes* live at the provider and **expire** per provider policy. **Support:** provider-specific (OpenAI Files API, Anthropic Files API beta). **When to use:** the same file is referenced across many turns and you want the checkpoint tiny. **Gotcha:** on a checkpoint-miss far in the future, the file ID may have expired → re-upload.

### Route 5 — Hybrid (file on filesystem + short reference/summary in the message)
**Mechanic:** keep bytes on `FilesystemBackend`/`StoreBackend`/object store; put only a path + 1–2 line summary in the message/state.
**Persistence:** best of both — small checkpoint, durable bytes, agent can `read_file` on demand (lazy load). **When to use:** production default for large/repeated files. **Tradeoff:** fork desync (mitigate per §3.4).

**deepagents vs plain LangGraph agents.** A deepagents agent *has* a filesystem mount (Routes 2 & 5 available out of the box, plus auto-eviction). A **plain LangGraph/`create_agent`** agent has **no filesystem** — it receives files only as message content blocks (Route 1), provider file IDs (Route 4), or via your own custom tool that fetches bytes from your store and returns a content block / `content_and_artifact`. You can add the filesystem to a plain agent by attaching `FilesystemMiddleware(backend=...)`.

**Vision vs non-vision models.** A vision/doc model consumes `image`/`file` blocks directly (Routes 1, 2, 4). A **non-vision model handed an image** will error or ignore it — for those, you must go through Route 3 (extract/caption to text), or have a vision sub-agent/tool describe the image and pass the *text* back (LangChain's multimodality concept doc explicitly suggests tools that process media by reference for non-multimodal models).

---

## 5. Patterns, techniques & edge cases

**Avoiding context + checkpoint bloat (consolidated):** never inline raw bytes as *text*; prefer references/extraction/summarization; offload large binaries to disk/store/object store and keep a handle; set a size threshold for inlining; lean on deepagents eviction (default 20k-token threshold) and DeltaChannel; use provider file IDs to keep the message channel tiny. Detect the base64-as-text anti-pattern by scanning `text` blocks for long base64-looking runs.

**Large files:** chunk and **partial-read** via `read_file(offset=, limit=)` (default ~2000 lines); use `grep`/`glob` to locate before reading; run an extraction pipeline (PDF→text) rather than feeding raw bytes; lazy-load (Route 5) so bytes enter context only when needed. Respect provider caps — confirmed by Anthropic's PDF support docs, **Anthropic PDFs are limited to 32 MB and ≤100 pages per request** (limits apply to the entire request payload; over-limit yields `400 ... A maximum of 100 PDF pages may be provided`); over-limit requires splitting/extraction.

> **GOTCHA — eviction read-loop.** deepagentsjs #82: a tool result of a few enormous lines gets evicted to disk, then `read_file` returns it whole (line limit doesn't help long lines), re-triggering eviction → infinite loop. Mitigation: pre-format/split long lines (e.g. `jq` for JSON), or lower the eviction threshold.

**Input/output workspace pattern:** read-only `input/` for user uploads (`FilesystemPermission(["write"], ["/input/**"], mode="deny")`) + read-write `output/` for agent artifacts. Permissions fire in `wrap_tool_call` before the backend; a denied `write_file` to `input/` returns an error the model can recover from.

**Filesystem↔checkpoint consistency across branches/forks/TTL:** use `StateBackend` for fork-sensitive files (they fork with the checkpoint); namespace store/disk by branch or content-hash for fork isolation; GC disk/store in lockstep with checkpoint deletion to avoid orphans (§3.4–3.5).

**Enumerated edge cases WITH handling:**
1. **Base64-image-serialized-as-text blowup** → never stringify content-block lists; keep proper `image`/`file` blocks; scan-and-reject long base64 in text blocks.
2. **Multimodal image dropped/kept by `trim_messages`/`RemoveMessage`** → messages are kept/dropped whole; pin the upload turn (don't trim it) or re-anchor the file via the filesystem so trimming the message doesn't lose the bytes.
3. **Orphaned disk files after a fork** → branch-namespacing or copy-on-fork; or use `StateBackend`.
4. **Checkpoint row/blob bloat from files-in-state** → references + eviction + DeltaChannel + provider file IDs (§3.2).
5. **Filesystem/checkpoint desync on branch** → §3.4 strategies.
6. **Re-upload needed on checkpoint-miss** → re-inject blocks or rehydrate filesystem; keep bytes in durable store so only handles need re-seeding (§3.6).
7. **Non-vision agent handed an image** → Route 3 (extract/caption) or a vision tool/sub-agent returns text.
8. **Tool-generated artifact files & where they persist** → `content_and_artifact`: text→model, artifact→message-in-state (checkpoint); or write to `output/` and return a path.
9. **deepagents permission-deny on an `input/` write** → expected; surfaced as a tool error string; tell the agent to write to `output/`.
10. **Oversized state row in Postgres** → TOAST/WAL amplification; offload bytes, keep state small (§3.2).
11. **Sub-agent writing files the parent checkpoint must capture** → `StateBackend` files are a parent-state channel, so sub-agent writes *are* captured in the parent checkpoint (§2.2).
12. **Binary that breaks `JsonPlusSerializer`** → convert to base64 `str` + `mime_type`; never put raw non-serializable objects in state; set `LANGGRAPH_STRICT_MSGPACK=true`.

---

## 6. LangChain-suite coverage

**LangChain core:** message types (`HumanMessage`/`AIMessage`/`ToolMessage`/`RemoveMessage`); multimodal/file/document content-block APIs — v0.3 provider-native + v0 data blocks (`source_type`) vs **v1 standard typed blocks** (`.content_blocks`, `content_blocks=`, `output_version="v1"`); image/file/audio/video block fields (`url`/`base64`/`file_id`/`mime_type`/`filename`); `tool_calls`↔`ToolMessage(tool_call_id=...)`; `@tool(response_format="content_and_artifact")` and `ToolMessage.artifact`; message-management utilities — `trim_messages` (token/message-count trimming, keeps/drops whole multimodal messages) and `RemoveMessage` (prune history; affects whether an attachment stays in context).

**deepagents (0.6.10):** `StateBackend`/`FilesystemBackend`/`StoreBackend`/`LocalShellBackend`/`CompositeBackend`; `virtual_mode` (path sandboxing on `FilesystemBackend`); the six file tools + `execute`; `read_file` multimodal return; `FileData` v2 (`content` str + `encoding`); `FilesystemState.files` as `DeltaChannel(_file_data_delta_reducer, snapshot_frequency=50)` with `None`-as-delete reducer; `FilesystemPermission(operations, paths, mode)`; large-tool-result eviction (`tool_token_limit_before_evict`, default 20k); sub-agents (shared filesystem, isolated messages/todos); middleware (`FilesystemMiddleware`, `SummarizationMiddleware`, `wrap_tool_call` permission enforcement).

**LangGraph:** `AsyncPostgresSaver` (`checkpoints`/`checkpoint_blobs`/`checkpoint_writes`/`checkpoint_migrations`, `.setup()`, `autocommit=True`+`dict_row`); per-super-step immutable checkpoint INSERTs; state reducers for message channels (`add_messages`) and the deepagents `files` channel; `update_state`/`get_state_history` for fork/replay (`source="fork"`); `BaseStore` for cross-thread/long-term file-derived memory; `JsonPlusSerializer` (ormsgpack + JSON fallback, strict-msgpack allow-list, CVE-2025-64439 fixed in checkpoint 3.0) and `EncryptedSerializer` for at-rest encryption; no native Postgres TTL (Platform TTL via `langgraph.json`, or DIY sweep / `adelete_thread`).

---

## 7. Sources (URLs + versions/dates)

*Verified from docs/source (June 21, 2026):*
- LangChain Messages & multimodal content blocks — docs.langchain.com/oss/python/langchain/messages ; github.com/langchain-ai/langchain `docs/docs/concepts/multimodality.mdx` (v1 standard blocks; `output_version="v1"`).
- "Standard message content" (v1 `.content_blocks`) — blog.langchain.com/standard-message-content/.
- `FileContentBlock`/`ImageContentBlock` fields — reference.langchain.com/python/langchain-core/messages/content/* .
- `ToolMessage`/`artifact`, `response_format` — reference.langchain.com/python/langchain-core/messages/tool/ToolMessage ; .../tools/base/BaseTool/response_format ; langgraph discussion #4221.
- `trim_messages` / `RemoveMessage` — reference.langchain.com/python/langchain-core/messages/utils/trim_messages ; .../messages/modifier/RemoveMessage.
- OpenAI image/PDF reference modes & `filename` requirement — developers.openai.com/api/docs/guides/images-vision ; langchainjs issues #9512, #9895.
- Anthropic PDF support (32 MB / 100 pages, base64/url/Files API, per-page text+image tokens) — platform.claude.com/docs/en/build-with-claude/pdf-support.
- deepagents Backends (StateBackend/FilesystemBackend/StoreBackend/CompositeBackend/LocalShellBackend, `virtual_mode`, `read_file` multimodal, permissions) — docs.langchain.com/oss/python/deepagents/backends ; reference.langchain.com/python/deepagents/* .
- deepagents `FileData`, `FilesystemState.files`, reducers, `DeltaChannel` — github.com/langchain-ai/deepagents `libs/deepagents/deepagents/middleware/filesystem.py` and `graph.py`; reference.langchain.com/python/deepagents/backends/protocol/FileData.
- deepagents subagents (shared filesystem) — docs.langchain.com/oss/python/deepagents/subagents ; github.com/langchain-ai/deepagents README.
- deepagents 0.2 backends / eviction — blog.langchain.com/doubling-down-on-deepagents/ ; v0.6 DeltaChannel — langchain.com/blog/deep-agents-0-6 (and Harrison Chase, X) ; changelog — docs.langchain.com/oss/python/releases/changelog. deepagents 0.6.10 on PyPI.
- `AsyncPostgresSaver` / serializer / setup — reference.langchain.com/python/langgraph.checkpoint.postgres/aio/AsyncPostgresSaver ; pypi.org/project/langgraph-checkpoint-postgres/ (3.1.0) ; pypi.org/project/langgraph-checkpoint/.
- `JsonPlusSerializer` + RCE/strict-msgpack — github.com/langchain-ai/langgraph `serde/jsonplus.py` ; advisory GHSA-wwqv-p2pp-99h5 (CVE-2025-64439, CVSS 7.4, fixed checkpoint 3.0) ; GHSA-g48c-2wqr-h844.
- TOAST/WAL write-amplification analysis — azguards.com "The Checkpoint Bloat."
- `EncryptedSerializer` — reference.langchain.com/python/langgraph/checkpoints.
- Time travel / fork (`update_state`, `get_state_history`, `source="fork"`) — docs.langchain.com/oss/python/langgraph/use-time-travel ; langgraph issue #4987.
- TTL (Platform only; no native Postgres TTL) — docs.langchain.com/langsmith/configure-ttl ; support.langchain.com TTL & checkpointer articles (incl. "Understanding Checkpointers, Databases, API Memory and TTL") ; langgraphjs issues #1138, #1272.
- Checkpoint bloat in production — tadeodonegana.com "Scaling LangGraph's Postgres Checkpointer in Production."

*Inference / needs validation:* fork-vs-store file behavior under `update_state` (reasoned from `files` being a checkpoint channel and store being cross-thread — subagent-confirmed but not a verbatim doc statement); copy-on-fork / per-branch namespacing / content-addressing strategies; specific inlining size thresholds; lockstep GC design. Flagged **[INFERENCE]** inline.

*Version-specific behavior to re-verify (these move fast):* the v0.3→v1 content-block format and `.content_blocks`; deepagents `FileData` v1(list[str])→v2(str+encoding); DeltaChannel default status; provider PDF/image/file-URL support per integration.