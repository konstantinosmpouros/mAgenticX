# Sandboxing the Filesystem for a `deepagents` Deep Agent: Per-User / Per-Agent Scoping with Defense in Depth

*Full edition — includes async backends, conversation-id provisioning, middleware/HITL enforcement, symlink defense, a verification harness, and the verified SKILL.md spec.*

---

## TL;DR

- **Primary mechanism: a dynamic `CompositeBackend` at the application layer**, mounting three virtual prefixes — shared user memory (`/memories/AGENT.md`), the per-agent subtree (`/agent/...`), and a read-only skills registry (`/skills_registry/`) — each backed by a `FilesystemBackend(root_dir=..., virtual_mode=True)` whose `root_dir` is computed *at tool-call time* from `user_id`/`agent_id` resolved off the LangGraph `Runtime`. Layer declarative `permissions=[FilesystemPermission(...)]` for read-only/deny rules, and harden the Docker container (non-root, scoped bind mount, read-only rootfs, dropped caps, seccomp) so the OS enforces the same boundary even if the app layer fails.
- **The app layer is NOT a security boundary by itself.** deepagents follows an explicit "trust the LLM" model — its README states: *"Deep Agents follows a 'trust the LLM' model. The agent can do anything its tools allow. Enforce boundaries at the tool/sandbox level, not by expecting the model to self-police."* `virtual_mode=True` gives path-traversal guardrails (blocks `..`, `~`, absolute paths) but the source itself warns it "does not provide sandboxing or process isolation." You therefore need **both** layers.
- **Never give this agent a shell/sandbox `execute` tool or a `LocalShellBackend`.** Permissions and path guardrails do not apply to shell execution, and `execute` is *not* path-routable — `CompositeBackend.execute` always delegates to the `default` backend. Keep the agent on file-only backends; put real isolation in the container.
- **New in this edition:** custom backends must override **both** sync and async methods or async invocation silently bypasses your policy; the per-`<conversation-id>` folder is auto-provisioned from `rt.execution_info.thread_id`; symlink escape needs an explicit `realpath` check; a `wrap_tool_call` middleware + `Command(resume=...)` flow is shown; and a pytest harness proves cross-agent denial.

---

## 1. Architecture: how the deepagents filesystem actually works

deepagents is an "agent harness" on top of LangChain's `create_agent` / LangGraph. Filesystem capability comes from **`FilesystemMiddleware`**, which contributes the tools `ls`, `read_file`, `write_file`, `edit_file`, `glob`, `grep` (plus `execute` *only* if the backend implements `SandboxBackendProtocol`). `create_deep_agent()` auto-attaches `TodoListMiddleware`, `FilesystemMiddleware`, and `SubAgentMiddleware`.

All file operations route through a pluggable **`BackendProtocol`** (`deepagents.backends.protocol`). Built-in backends:

| Backend | Storage | Persistence | Use for |
|---|---|---|---|
| `StateBackend` | LangGraph state (in-memory) | Single thread, ephemeral | Scratch, internal artifacts |
| `StoreBackend` | LangGraph `BaseStore` | Cross-thread, namespaced, DB-backed | Persistent multi-tenant memory |
| `FilesystemBackend` | Real disk under `root_dir` | Durable on disk | Your scoped on-disk subtrees |
| `LocalShellBackend` | Disk **+ unrestricted host shell** | Durable | **Avoid here** (no sandbox) |
| `CompositeBackend` | Routes by path prefix to others | Depends on routes | Mounting multiple scopes |
| Sandbox (Modal/Daytona/Runloop/LangSmith) | Remote sandbox | Remote | Untrusted code exec |

### The protocol surface (important nuance for custom backends)

At the **protocol** level the methods are `ls_info` / `als_info`, `read` / `aread`, `write` / `awrite`, `edit` / `aedit`, `grep_raw` / `agrep_raw`, `glob_info` / `aglob_info`, plus `upload_files` / `download_files` (and async variants). The DeepWiki protocol reference confirms *"All BackendProtocol methods have both synchronous and asynchronous variants. The async methods are prefixed with `a`."* The default async implementations simply wrap the sync one via `asyncio.to_thread` — e.g. `awrite` calls `asyncio.to_thread(self.write, ...)`.

**But `CompositeBackend`'s public surface exposes the friendlier names** `ls`, `read`, `grep`, `glob`, `write`, `edit`, `execute` (+ `a`-prefixed). So there is real **naming drift** between the low-level protocol (`ls_info`/`grep_raw`/`glob_info`, returning `FileInfo`/`GrepMatch`) and the composite/tool-facing layer (`ls`/`grep`/`glob`). The only names stable across both layers and across recent versions are **`read`/`write`/`edit`** (and their `a*` variants).

**Practical consequence:** a custom guarded/audit backend should **delegate generically** (e.g. `__getattr__` passthrough) and intercept only the mutating operations whose names are stable (`write`/`awrite`/`edit`/`aedit`), rather than hand-enumerate `ls`/`ls_info`/`grep`/`grep_raw` and risk missing one on a version bump. The full wrapper below does exactly that.

### Backend factories — the dynamic-scoping hook

Backends can be passed as a **factory** `backend=lambda rt: ...`, where `rt` is the LangGraph `Runtime`. The factory runs at tool-call time and can read:

- `rt.context` — your typed context (`user_id`, `agent_id`),
- `rt.server_info` — e.g. `rt.server_info.user.identity`, `assistant_id`,
- `rt.execution_info` — including `thread_id` (your conversation id).

Each filesystem tool internally calls `_get_backend(runtime)` to resolve the backend at execution time. This is what lets one agent definition serve many users/agents with different scopes.

---

## 2. CompositeBackend routing semantics

- `CompositeBackend(default=..., routes={"/prefix/": backend, ...})` matches the **longest prefix first** (so `/memories/projects/` overrides `/memories/`).
- The matched prefix is **stripped** before delegating (e.g. `/memories/notes.txt` under route `/memories/` → the routed backend sees `/notes.txt`), and re-added in `ls`/`glob`/`grep` results. Unmatched paths fall to `default`.
- Internal artifacts (large-tool-result eviction under `/large_tool_results/`, conversation history) are written to the **default** backend — so make the default a `StateBackend` to keep them ephemeral and off disk.
- `execute` is **not** path-routable: `CompositeBackend.execute` always delegates to the `default` backend. (Another reason to keep `default` a `StateBackend` with no shell.)

---

## 3. Memory & the AGENT(S).md convention

- Long-term memory is "filesystem-backed": pass `memory=["/memories/AGENT.md"]` and the agent loads those files into the system prompt at startup (`MemoryMiddleware.before_agent`).
- **Cross-conversation persistence comes from routing `/memories/` to a persistent backend** (a disk `FilesystemBackend` or a `StoreBackend`). Scope is controlled by the backend *namespace/root*, not by the agent. deepagents' own docs show `namespace=lambda rt: (rt.server_info.user.identity,)` for per-user isolation and `(assistant_id,)` for per-agent isolation — which maps directly onto your requirement that *all* of a user's agents share `AGENT.md` while each agent's own subtree stays isolated.

---

## 4. Skills — verified SKILL.md spec & override resolution

### File format (verified against the Agent Skills specification)

A skill is a **directory** containing `SKILL.md`: YAML frontmatter between `---` markers, then a Markdown body.

```markdown
---
name: invoice-parser            # REQUIRED. lowercase, hyphens. MUST match the parent folder name exactly (case-sensitive on Linux).
description: >-                  # REQUIRED. The primary trigger signal — what it does AND when to use it.
  Extracts totals and line items from invoice PDFs. Use when the user
  uploads an invoice or asks to pull figures from a billing document.
license: Apache-2.0             # OPTIONAL.
metadata:                       # OPTIONAL (author, version, etc.)
  author: example-org
  version: "1.0"
compatibility:                  # OPTIONAL / experimental; support varies by agent.
  ...
---

# Invoice Parser
[Markdown instructions — recommended < 500 lines / < 5000 tokens]
```

Only `name` and `description` are required; all other fields are optional and unknown fields degrade gracefully (ignored by agents that don't support them). The directory may also contain `scripts/`, `references/`, and `assets/` subdirectories.

### Progressive disclosure (three levels)

1. **Level 1 — metadata (~100 tokens/skill):** only `name` + `description` from every skill's frontmatter are loaded at startup.
2. **Level 2 — body (< 5000 tokens recommended):** the full `SKILL.md` body loads only when the agent decides the skill is relevant.
3. **Level 3 — resources (as needed):** files in `scripts/`/`references/`/`assets/` are pulled in on demand. This makes the bundled knowledge effectively unlimited while keeping the context small.

### Loading & override resolution in deepagents

- You pass `skills=["/skills_registry/", "/agent/skills/"]`. Each entry is a path **relative to the backend root** behind that mount; deepagents scans it for skill directories and injects their Level-1 metadata.
- **Override is last-wins by skill `name`:** if both `/skills_registry/` and `/agent/skills/` contain a skill named `invoice-parser`, the **later source in the list wins**. Put the registry first and the per-agent folder last so an agent can override a global skill with its own version. (This is the same precedence behavior used for same-named skills across multiple sources.)
- Because skills load through the same backend, the registry's **read-only** status is enforced exactly like any other path (see §5/§7).
- Subagents can be given their own isolated skill set that is *not* inherited from the parent.

---

## 5. Permissions & policy controls — every available surface

deepagents gives you **four** distinct control surfaces. Use the cheapest one that expresses your rule.

### 5.1 Declarative `permissions=[FilesystemPermission(...)]` (needs `deepagents>=0.5.2`)

Path allow/deny on the **built-in filesystem tools only**.

| Field | Meaning |
|---|---|
| `operations` | `["read"]` (ls/read_file/glob/grep), `["write"]` (write_file/edit_file), or both |
| `paths` | glob list; supports `**` and `{a,b}` alternation |
| `mode` | `"allow"` / `"deny"` / `"interrupt"` (interrupt requires **`>=0.6.8`**); default `"allow"` |

Semantics: **first-match-wins; no match = allowed (permissive default).** So always end with a `/**` **deny**. Applies at the **tool layer**, not the backend layer — direct backend calls, custom tools, MCP tools, and sandbox `execute` are **not** covered. With a `CompositeBackend` whose default is a sandbox, every permission path must sit under a known route prefix or it raises `NotImplementedError`.

### 5.2 Custom backend / "policy hooks" (you write this — no built-in class)

There is **no** `policy=` parameter, **no** `BackendMiddleware`, **no** decorator. The official "Add policy hooks" docs show **user-defined** patterns. You subclass a concrete backend or wrap one implementing `BackendProtocol`. **To deny: return the result object with `error=` set (do NOT raise). To allow: delegate to the inner backend.** Reserve this for logic `permissions=` can't express (audit trails, rate limiting, content inspection, dynamic rules). See the async-safe `PolicyWrapper` in §8.

### 5.3 Per-tool enable/disable & subagent permissions

Subagents **inherit** parent permissions unless they set their own `permissions` field, which **fully replaces** the parent's. You can hand a read-only auditor subagent a write-deny ruleset, or disable write/delete tools entirely for some agents.

### 5.4 Middleware interception + Human-in-the-Loop

LangChain agent middleware exposes hooks `before_agent`, `before_model` / `wrap_model_call`, and `wrap_tool_call` / `awrap_tool_call`. The deepagents middleware chain at tool time is:

```text
HumanInTheLoopMiddleware.wrap_tool_call (approval gate)
  → PatchToolCallsMiddleware.wrap_tool_call (fix tool-call IDs)
    → FilesystemMiddleware.wrap_tool_call (evict large results)
      → tool executes
```

The **wrap pattern** is `(request, handler)`: call `handler(request)` to proceed, or return early to short-circuit. **HITL** is configured with `interrupt_on={"write_file": True}` (or `{"write_file": {"allowed_decisions": ["approve","edit","reject"]}}`), requires a **checkpointer + `thread_id`**, and resumes with `Command(resume=...)`. Marking a `FilesystemPermission` with `mode="interrupt"` triggers the same HITL flow on matching write paths (requires **`>=0.6.8`**). Full code in §8.4.

---

## 6. Version landscape (check what you're on)

- Current line is **0.6.x**; PyPI's current release is **0.6.8** (`deepagents-0.6.8.tar.gz`); the prior signed tag `deepagents==0.6.7` was published 30 May 2026. The "New in Deep Agents v0.6" post centers on "performance at the model layer, the agent layer, at scale, and over time," adding a code interpreter (`deepagents[quickjs]` / REPLMiddleware), Harness profiles, typed streaming, and DeltaChannel delta-based checkpointing claiming "10-100x reductions in checkpointer storage."
- Milestones: **0.2** (28 Oct 2025) — pluggable backends + `CompositeBackend`; **0.4** — pluggable sandboxes; **0.5.0** — `rt.server_info`/`rt.execution_info`; **0.5.2** — backend/namespace factory receives a `Runtime` directly (older 0.5.x passed a `BackendContext`) and is the floor for `FilesystemPermission`; **0.6.8** — `mode="interrupt"` permission rules + filesystem-permission interrupts. `BackendContext` `.runtime`/`.state` accessors are deprecated, slated for removal in `>=0.7`.
- **Confirm:** `python -c "import deepagents; print(deepagents.__version__)"` / `pip show deepagents`. Then `from deepagents import FilesystemPermission` (exists ≥0.5.2); check whether `FilesystemBackend.__init__` accepts `virtual_mode`; check whether your factory receives `Runtime` vs `BackendContext`.

---

## 7. Mapping your structure onto deepagents

On-disk per user:

```text
filesystem/<user-id>/AGENT.md                      # shared across ALL agents of this user
filesystem/<user-id>/<agent-id>/<conversation-id>/ # per-agent, per-conversation work
filesystem/<user-id>/<agent-id>/skills/            # per-agent skills
skills_registry/                                   # global, read-only
```

Virtual namespace the agent sees:

- `/memories/AGENT.md` → real `filesystem/<user-id>/AGENT.md` (shared user memory, read-write)
- `/agent/` → real `filesystem/<user-id>/<agent-id>/` (this agent's conversations + skills, read-write)
- `/skills_registry/` → real `skills_registry/` (read-only)
- everything else → ephemeral `StateBackend`

Because each `FilesystemBackend` has its own `root_dir` computed from `user_id`/`agent_id`, **agent A literally has no backend that can resolve a path into agent B's directory** — isolation is *structural*, not rule-based. That's the strongest property of this design.

---

## 8. End-to-end implementation

### 8.1 Hardened path/segment helpers (incl. symlink defense)

```python
from pathlib import Path

FS_ROOT = Path("/data/filesystem").resolve()        # bind-mounted into container
SKILLS_REGISTRY = Path("/data/skills_registry").resolve()

def safe_segment(value: str) -> str:
    """Reject path-traversal injected THROUGH the ids themselves."""
    if (not value or "/" in value or "\\" in value or ".." in value
            or value.startswith(".") or "\x00" in value):
        raise ValueError(f"Illegal id segment: {value!r}")
    return value

def assert_within(root: Path, candidate: Path) -> Path:
    """Symlink-safe containment check: the FULLY RESOLVED real path must stay under root.

    virtual_mode=True blocks '..'/'~'/absolute paths at the tool layer, but a real
    FilesystemBackend root can still contain a symlink pointing outside the subtree.
    realpath() collapses symlinks so we catch that here, and the OS read-only bind
    mount (Section 9) is the backstop.
    """
    real_root = root.resolve(strict=False)
    real = candidate.resolve(strict=False)          # follows symlinks
    if real != real_root and real_root not in real.parents:
        raise PermissionError(f"Path escapes sandbox: {candidate} -> {real}")
    return real
```

### 8.2 The dynamic scoped composite backend (with conversation-id provisioning)

```python
from dataclasses import dataclass
from deepagents import create_deep_agent, FilesystemPermission
from deepagents.backends import CompositeBackend, StateBackend, FilesystemBackend

@dataclass
class Context:
    user_id: str
    agent_id: str
    # conversation_id == LangGraph thread_id; read from rt.execution_info at runtime.

def make_backend(rt) -> CompositeBackend:
    user_id = safe_segment(rt.context.user_id)
    agent_id = safe_segment(rt.context.agent_id)

    user_root  = FS_ROOT / user_id
    agent_root = user_root / agent_id

    # Provision dirs. Containment is re-verified AFTER resolving symlinks.
    user_root.mkdir(parents=True, exist_ok=True)
    agent_root.mkdir(parents=True, exist_ok=True)
    assert_within(FS_ROOT, agent_root)

    # --- conversation-id auto-provisioning -------------------------------
    # Your structure has base/<agent-id>/<conversation-id>/. Create it eagerly
    # from the thread_id so each conversation gets its own folder without
    # relying on the model to make it. Guarded by safe_segment + assert_within.
    convo_id = None
    exec_info = getattr(rt, "execution_info", None)
    if exec_info is not None:
        convo_id = getattr(exec_info, "thread_id", None)
    if convo_id:
        convo_id = safe_segment(str(convo_id))
        convo_dir = agent_root / convo_id
        convo_dir.mkdir(parents=True, exist_ok=True)
        assert_within(FS_ROOT, convo_dir)
    # ---------------------------------------------------------------------

    return CompositeBackend(
        default=StateBackend(rt),                    # ephemeral scratch + internal artifacts
        routes={
            # Shared USER-level memory (AGENT.md lives above the agent level).
            "/memories/":        FilesystemBackend(root_dir=str(user_root),        virtual_mode=True),
            # This agent's own subtree: its conversation folders + its skills.
            "/agent/":           FilesystemBackend(root_dir=str(agent_root),       virtual_mode=True),
            # Global registry, made read-only by permissions + OS mount.
            "/skills_registry/": FilesystemBackend(root_dir=str(SKILLS_REGISTRY),  virtual_mode=True),
        },
    )
```

> The agent now writes per-conversation files at `/agent/<thread_id>/...`, which resolves to `filesystem/<user-id>/<agent-id>/<conversation-id>/`. Switching `agent_id` re-roots only `/agent/`; `/memories/` stays at the user level so every agent shares one `AGENT.md`.

### 8.3 Async-safe guarded/audit wrapper (delegates generically)

This wraps **any** backend, intercepts only the stable mutating method names (`write`/`awrite`/`edit`/`aedit`), and passes everything else through via `__getattr__` so it survives the `ls`/`ls_info`, `grep`/`grep_raw` naming drift across versions.

```python
from deepagents.backends.protocol import WriteResult, EditResult

class PolicyWrapper:
    """Generic, async-aware policy/audit layer over a BackendProtocol-compatible backend.

    Denies by RETURNING a result object with error= set (never raises into the agent).
    Delegates all non-mutating methods (ls/ls_info/read/grep/grep_raw/glob/glob_info/...)
    straight through, so it is resilient to protocol method-name changes.
    """
    def __init__(self, inner, deny_prefixes=None, audit=None):
        self._inner = inner
        self._deny = [p if p.endswith("/") else p + "/" for p in (deny_prefixes or [])]
        self._audit = audit or (lambda *a, **k: None)

    def _blocked(self, path: str) -> bool:
        return any(path.startswith(p) for p in self._deny)

    # ---- mutating ops: enforce policy (BOTH sync and async) -------------
    def write(self, file_path, content):
        if self._blocked(file_path):
            return WriteResult(error=f"Writes not allowed under {file_path}")
        self._audit("write", file_path)
        return self._inner.write(file_path, content)

    async def awrite(self, file_path, content):
        if self._blocked(file_path):
            return WriteResult(error=f"Writes not allowed under {file_path}")
        self._audit("awrite", file_path)
        return await self._inner.awrite(file_path, content)

    def edit(self, file_path, old_string, new_string, replace_all=False):
        if self._blocked(file_path):
            return EditResult(error=f"Edits not allowed under {file_path}")
        self._audit("edit", file_path)
        return self._inner.edit(file_path, old_string, new_string, replace_all)

    async def aedit(self, file_path, old_string, new_string, replace_all=False):
        if self._blocked(file_path):
            return EditResult(error=f"Edits not allowed under {file_path}")
        self._audit("aedit", file_path)
        return await self._inner.aedit(file_path, old_string, new_string, replace_all)

    # ---- everything else (ls/ls_info/read/aread/grep/grep_raw/glob/...) --
    def __getattr__(self, name):
        # Called only for attributes not defined above -> delegate to inner.
        return getattr(self._inner, name)
```

> **Why both halves matter:** under a LangGraph server the tools are invoked **async**, so `awrite`/`aedit` are what actually fire. A wrapper that overrides only `write`/`edit` would silently let async writes through. (`permissions=` already covers async at the tool layer; this wrapper is for *additional* logic like audit/rate-limit/content rules.) Note the wrapper sees **post-route-stripped** paths when placed *inside* a CompositeBackend route, and pre-strip paths when wrapped *around* the whole composite — wrap at the level whose path namespace your `deny_prefixes` are written against.

To use the wrapper, swap a route, e.g.:

```python
"/skills_registry/": PolicyWrapper(
    FilesystemBackend(root_dir=str(SKILLS_REGISTRY), virtual_mode=True),
    deny_prefixes=["/"],  # deny ALL writes (read-only registry); reads pass through
    audit=lambda op, p: logger.info("fs", extra={"op": op, "path": p}),
),
```

### 8.4 Constructing the agent (permissions + HITL + checkpointer)

```python
from langgraph.checkpoint.memory import InMemorySaver   # use a durable saver in prod
from langgraph.types import Command

agent = create_deep_agent(
    model="anthropic:claude-sonnet-4-6",
    context_schema=Context,
    backend=make_backend,
    memory=["/memories/AGENT.md"],                          # shared user memory at startup
    skills=["/skills_registry/", "/agent/skills/"],         # registry first, per-agent last (last wins)
    permissions=[
        FilesystemPermission(operations=["write"], paths=["/skills_registry/**"], mode="deny"),
        FilesystemPermission(operations=["read", "write"],
                             paths=["/memories/**", "/agent/**", "/skills_registry/**"],
                             mode="allow"),
        FilesystemPermission(operations=["read", "write"], paths=["/**"], mode="deny"),  # catch-all
    ],
    # Pause for human review before any write/edit (needs checkpointer + thread_id).
    interrupt_on={"write_file": True, "edit_file": True},
    checkpointer=InMemorySaver(),
)
```

Invoke, detect interrupt, resume:

```python
config = {"configurable": {"thread_id": "<conversation-id>"}}
ctx = Context(user_id="u-123", agent_id="a-research")

result = agent.invoke(
    {"messages": [{"role": "user", "content": "Update my notes."}]},
    config=config, context=ctx,
)

if result.get("__interrupt__"):                 # a write was gated
    # ...show the proposed write to a human...
    result = agent.invoke(
        Command(resume={"decisions": [{"type": "approve"}]}),   # or {"type":"reject","message":...}
        config=config, context=ctx,
    )
```

### 8.5 Alternative enforcement via `wrap_tool_call` middleware

If you'd rather gate at the middleware layer (e.g. to block a path pattern across *all* tools, including custom ones, which `permissions=` does not cover):

```python
from langchain.agents.middleware import AgentMiddleware

ALLOWED_PREFIXES = ("/memories/", "/agent/", "/skills_registry/")

class PathGateMiddleware(AgentMiddleware):
    def wrap_tool_call(self, request, handler):
        path = (request.tool_call.get("args") or {}).get("file_path")
        if path and not path.startswith(ALLOWED_PREFIXES):
            # Short-circuit: return a tool result instead of calling handler().
            return {"content": f"Denied: {path} is outside the sandbox.", "status": "error"}
        return handler(request)

    async def awrap_tool_call(self, request, handler):   # async path — required under server
        path = (request.tool_call.get("args") or {}).get("file_path")
        if path and not path.startswith(ALLOWED_PREFIXES):
            return {"content": f"Denied: {path} is outside the sandbox.", "status": "error"}
        return await handler(request)
```

Pass it via `middleware=[PathGateMiddleware()]` to `create_deep_agent`. As with the backend wrapper, implement **both** `wrap_tool_call` and `awrap_tool_call`.

### 8.6 StoreBackend variant (no shared disk for memory)

If you prefer DB-backed per-user memory over a shared disk root:

```python
from deepagents.backends import StoreBackend
# route "/memories/" -> StoreBackend(namespace=lambda rt: (rt.context.user_id,))
```

This gives per-user isolation with no shared filesystem at all (good for strict multi-tenant). Use the LangGraph store's async methods (`aget`/`aput`) — `StoreBackend.aread`/`awrite`/`aedit` already do.

---

## 9. OS-level hardening inside Docker (defense in depth)

The container is the real security boundary. Recommended setup:

```dockerfile
# Dockerfile
FROM python:3.12-slim
RUN useradd -u 10001 -m agent
WORKDIR /app
COPY --chown=agent:agent . /app
RUN pip install --no-cache-dir deepagents langchain-anthropic
USER 10001:10001
ENTRYPOINT ["python", "-m", "myagent.server"]
```

```yaml
# compose.yaml
services:
  agent:
    build: .
    user: "10001:10001"            # non-root
    read_only: true                # read-only root filesystem
    cap_drop: [ALL]                # drop ALL Linux capabilities (never grant CAP_SYS_ADMIN)
    security_opt:
      - no-new-privileges:true     # block setuid escalation
      - seccomp:/etc/docker/seccomp-agent.json   # syscall allowlist
      # - apparmor:docker-agent    # optional path-based MAC profile
    tmpfs:
      - /tmp:rw,noexec,nosuid,size=64m
    volumes:
      - type: bind                 # ONLY the scoped data dir is visible
        source: /srv/agent-data/filesystem
        target: /data/filesystem
      - type: bind
        source: /srv/agent-data/skills_registry
        target: /data/skills_registry
        read_only: true            # registry read-only at the OS layer too
    networks: [internal]
    deploy:
      resources:
        limits: {cpus: "0.5", memory: 512M}
networks:
  internal:
    internal: true
```

Equivalent `docker run`:

```bash
docker run --rm \
  --user 10001:10001 \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --cap-drop=ALL --security-opt no-new-privileges:true \
  --security-opt seccomp=/etc/docker/seccomp-agent.json \
  -v /srv/agent-data/filesystem:/data/filesystem \
  -v /srv/agent-data/skills_registry:/data/skills_registry:ro \
  --network internal --memory 512m --cpus 0.5 \
  myagent
```

Key points:

- **Scoped bind mount = OS analogue of the CompositeBackend.** The container only ever sees `/data/filesystem` and `/data/skills_registry`; the rest of the host isn't in its mount namespace, so even a total app-layer bypass can't reach it.
- **Read-only rootfs + dropped caps + no-new-privileges + seccomp** together cripple most exploit chains: no payload write to root fs, no setuid escalation, and the seccomp allowlist shrinks the kernel surface (Docker's default already blocks ~44 of 300+ syscalls; a custom profile blocks more). **Never grant `CAP_SYS_ADMIN`** — it permits mount manipulation and could unmount your read-only/scoped binds.
- **Per-user OS ownership** is awkward in one long-lived container: bind-mount ownership defaults to root, so align the container UID/GID with the host owner (`--user uid:gid` + pre-`chown -R uid:gid` the subtree) or you get "permission denied." For strict OS-enforced per-user isolation, run **one container per user (or per session)** with that user's subtree bind-mounted and a matching UID/GID owning only that subtree; let the CompositeBackend handle per-*agent* separation inside it. Optionally enable **user namespaces** (`userns-remap`) so container UID 0 maps to an unprivileged host UID.
- **Untrusted code execution** (only if you ever add `execute`): containers share the host kernel and aren't a strong adversarial boundary. Escalate to **gVisor** (userspace kernel; Google's GKE Sandbox docs cite ~10–30% overhead; used for App Engine/Cloud Run/Cloud Functions and by Modal), **Firecracker / Kata microVMs** (separate guest kernel; Firecracker boots "in as little as 125 ms," "up to 150 microVMs per second per host," "< 5 MiB" footprint — strongest isolation), or **nsjail** (namespaces + seccomp-bpf, good *inside* a container). For this **file-only** use case you don't need these — just omit shell tools.

---

## 10. Verification harness (prove cross-agent denial)

Don't trust the design — assert it. A pytest sketch:

```python
import pytest
from mybackend import make_backend, Context, safe_segment, assert_within, FS_ROOT

class FakeExec:    thread_id = "conv-1"
class FakeRuntime:
    def __init__(self, user_id, agent_id):
        self.context = Context(user_id=user_id, agent_id=agent_id)
        self.execution_info = FakeExec()

def test_agent_cannot_reach_sibling_agent(tmp_path, monkeypatch):
    monkeypatch.setattr("mybackend.FS_ROOT", tmp_path.resolve())
    # Agent A writes a file in its own subtree.
    be_a = make_backend(FakeRuntime("u1", "agentA"))
    assert be_a.write("/agent/conv-1/secret.txt", "A-only").error is None
    # Agent B is rooted at a DIFFERENT real dir; the same virtual path resolves
    # into B's subtree, NOT A's — so B can never read A's file.
    be_b = make_backend(FakeRuntime("u1", "agentB"))
    res = be_b.read("/agent/conv-1/secret.txt")
    assert res.error is not None                      # not found in B's root
    # And the on-disk locations are genuinely different dirs.
    assert (tmp_path / "u1" / "agentA" / "conv-1" / "secret.txt").exists()
    assert not (tmp_path / "u1" / "agentB" / "conv-1" / "secret.txt").exists()

def test_shared_memory_is_visible_to_all_user_agents(tmp_path, monkeypatch):
    monkeypatch.setattr("mybackend.FS_ROOT", tmp_path.resolve())
    a = make_backend(FakeRuntime("u1", "agentA"))
    a.write("/memories/AGENT.md", "user fact")
    b = make_backend(FakeRuntime("u1", "agentB"))
    assert "user fact" in b.read("/memories/AGENT.md").file_data  # field name varies by version

@pytest.mark.parametrize("bad", ["..", "../../etc", "a/b", ".hidden", "", "x\x00y"])
def test_segment_rejects_traversal(bad):
    with pytest.raises(ValueError):
        safe_segment(bad)

def test_symlink_escape_is_caught(tmp_path, monkeypatch):
    monkeypatch.setattr("mybackend.FS_ROOT", tmp_path.resolve())
    outside = tmp_path.parent / "outside"; outside.mkdir()
    (tmp_path / "u1" / "agentA").mkdir(parents=True)
    link = tmp_path / "u1" / "agentA" / "escape"; link.symlink_to(outside)
    with pytest.raises(PermissionError):
        assert_within(tmp_path.resolve(), link)
```

Run these in CI on every change to the backend factory. Add async mirrors (`await be.awrite(...)`) to confirm the async path enforces the same rules — this is the test that catches a wrapper that forgot `awrite`/`aedit`.

---

## 11. App layer vs OS layer vs both — recommendation

| Layer | Enforces | Strength | Bypass risk |
|---|---|---|---|
| CompositeBackend + dynamic root | Per-user/agent scoping, virtual namespace | **Structural** (no backend resolves outside its root) | App bug; any non-built-in tool that touches disk directly |
| `permissions=` + `virtual_mode=True` | Read-only/deny; blocks `..`/`~`/abs paths | Good for built-in tools | Doesn't cover custom/MCP/shell tools; direct backend calls bypass |
| Custom guarded backend / `wrap_tool_call` | Audit, rate-limit, content rules, cross-tool path gate | As good as your code (and you must cover async) | Forgetting async variants |
| Docker (non-root, scoped bind mount, ro-rootfs, cap-drop, seccomp) | OS-level filesystem boundary | **Real security boundary** | Kernel exploit (→ gVisor/microVM if running untrusted code) |

**Verdict: do both.** App layer for ergonomics + dynamic per-user/per-agent scoping + clean virtual paths; OS layer because deepagents explicitly does not treat the app layer as a security boundary and `virtual_mode` is "not sandboxing." They're complementary: the bind mount caps the blast radius to the data dir; the CompositeBackend partitions *within* it by user and agent.

---

## 12. Recommendations (ordered)

1. **Pin & confirm the version first.** Target `deepagents>=0.5.2` (ideally 0.6.8 so `mode="interrupt"` works). Verify `from deepagents import FilesystemPermission` and that the factory receives a `Runtime`.
2. **Implement the dynamic `CompositeBackend` factory** keyed off `Context(user_id, agent_id)`; validate ids with `safe_segment`; re-check containment with `assert_within` *after* resolving symlinks; auto-provision the `<conversation-id>` folder from `rt.execution_info.thread_id`.
3. **Always set `virtual_mode=True`** on every `FilesystemBackend` (its absence gives no path protection) and keep `StateBackend` as the composite `default` (internal artifacts + non-routable `execute` land there harmlessly).
4. **Add the three-rule `permissions` ladder** (deny registry writes → allow the three mounts → deny `/**`); remember first-match-wins + permissive no-match default, so order specific rules first.
5. **If you write a custom backend or middleware, cover async** (`awrite`/`aedit`, `awrap_tool_call`) or the server path silently bypasses your policy; delegate non-mutating methods generically to survive `ls`/`ls_info`/`grep`/`grep_raw` naming drift.
6. **Do NOT enable any sandbox/shell backend or `execute`.** If you later need code execution, isolate it in a separate gVisor/microVM sandbox, not this container.
7. **Harden the container:** non-root user, scoped bind mount only, `--read-only` + tmpfs, `--cap-drop=ALL`, `no-new-privileges`, seccomp, resource limits, internal network; never grant `CAP_SYS_ADMIN`.
8. **For strict OS-enforced per-user isolation,** run one container/session per user with that user's subtree bind-mounted and a matching UID/GID; consider `userns-remap`.
9. **Add `interrupt_on` for writes** (and optionally a `PolicyWrapper`/`PathGateMiddleware` for audit + cross-tool gating) where you need human review or a tamper-evident trail. HITL needs a durable checkpointer + `thread_id`.
10. **Run the verification harness in CI**, including async mirrors and the symlink-escape test.

**Thresholds that change the plan:** untrusted generated code → add gVisor or a Firecracker microVM and treat the container as insufficient. Fully multi-tenant on shared infra → move per-user memory to `StoreBackend` with `namespace=(user_id,)` (no shared disk). Stuck on `deepagents<0.5.2` → no `FilesystemPermission`; lean on the custom guarded backend + container hardening until you upgrade.

---

## 13. Caveats

- **"Trust the LLM" model.** The README requires boundaries "at the tool/sandbox level, not by expecting the model to self-police." All app-layer controls are guardrails, not a sandbox.
- **`permissions` scope is narrow.** Built-in filesystem tools only, at the tool layer; custom/MCP tools and sandbox `execute` aren't covered, and direct backend calls bypass it. With a sandbox-default composite, permission paths outside a known route raise `NotImplementedError`.
- **`virtual_mode=True` is a guardrail, not isolation** ("does not provide sandboxing or process isolation"); the default `virtual_mode=False` "provides no security even with `root_dir` set" (absolute paths and `..` bypass `root_dir`).
- **Async is a real footgun.** Custom backends/middleware that override only sync methods are bypassed under the async server path. Always cover `a*` variants.
- **Method-name drift.** Protocol uses `ls_info`/`grep_raw`/`glob_info` (returning `FileInfo`/`GrepMatch`); `CompositeBackend` exposes `ls`/`grep`/`glob`. Only `read`/`write`/`edit` (+`a*`) are stable — hence the `__getattr__` delegation pattern. Result-object field names (e.g. `ReadResult.file_data`) also vary by version; check the installed reference.
- **HITL edit/reject quirks.** There are known issues where, after an `edit` decision, the agent re-attempts the original tool call, and where subagent interrupt/resume works only for `approve`. Test your chosen decision modes against your installed version.
- **`GuardedBackend`/`PolicyWrapper`/`PathGateMiddleware` are illustrative**, not importable library classes — there is no built-in policy-hook API (`policy=`, `BackendMiddleware`, decorator all absent).
- **Bind-mount ownership quirks.** A non-root container user may see bind mounts owned by root; align UID/GID and pre-`chown`, or use named volumes/an init step. `userns-remap` shifts effective host UIDs again.
- **Fast-moving API.** Names/signatures and the `Runtime` vs `BackendContext` factory shape changed across 0.2→0.6; always check the installed version's reference. Dates/versions here reflect PyPI/GitHub as of early June 2026.
