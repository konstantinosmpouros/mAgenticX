# Sandboxing the Filesystem for a `deepagents` Deep Agent: Per-User / Per-Agent Scoping with Defense in Depth

## TL;DR

- **Use a `CompositeBackend` at the application layer as your primary scoping mechanism**, mounting three prefixes — shared user memory (`/memories/AGENT.md`), the per-agent subtree (`/agent/...`), and the read-only skills registry (`/skills_registry/`) — each backed by a `FilesystemBackend(root_dir=..., virtual_mode=True)` whose root is computed *dynamically* from `user_id`/`agent_id` resolved via the LangGraph `Runtime` context at tool-call time. Layer `permissions=[FilesystemPermission(...)]` on top for read-only/deny rules, and harden the Docker container (non-root, scoped bind mount, read-only rootfs, dropped caps, seccomp) so the OS enforces the same boundary even if the app layer fails.
- **The app layer alone is NOT a security boundary.** deepagents explicitly follows a "trust the LLM" model — its README states verbatim: *"Deep Agents follows a 'trust the LLM' model. The agent can do anything its tools allow. Enforce boundaries at the tool/sandbox level, not by expecting the model to self-police."* `virtual_mode=True` gives path-traversal guardrails (blocks `..`, `~`, absolute paths) but the deepagents source itself warns it "does not provide sandboxing or process isolation." You therefore need BOTH layers.
- **Never give this agent a shell/sandbox `execute` tool or a `LocalShellBackend`** for the OS-scoped use case: deepagents permissions and path guardrails do not apply to shell execution. Keep the agent on file-only backends, and put real isolation in the container.

## Key Findings

### 1. Architecture: how the deepagents filesystem actually works

- deepagents is an "agent harness" on top of LangChain's `create_agent` / LangGraph. Filesystem capability is provided by **`FilesystemMiddleware`**, which adds the tools `ls`, `read_file`, `write_file`, `edit_file`, `glob`, `grep` (plus `execute` only if the backend implements `SandboxBackendProtocol`). `create_deep_agent()` auto-attaches `TodoListMiddleware`, `FilesystemMiddleware`, and `SubAgentMiddleware`.
- All file operations route through a pluggable **`BackendProtocol`** (in `deepagents.backends.protocol`). Built-in backends: `StateBackend` (ephemeral, in LangGraph state, single thread), `StoreBackend` (LangGraph `BaseStore`, persistent cross-thread, namespaced), `FilesystemBackend` (real disk under `root_dir`), `LocalShellBackend` (FilesystemBackend + unrestricted host shell), `CompositeBackend` (routes by path prefix), plus sandbox backends (Modal, Daytona, Runloop, LangSmith) and `ContextHubBackend`.
- The protocol methods are `ls`, `read`, `write`, `edit`, `glob`, `grep` (each with async `a`-prefixed variants), returning structured result objects (`LsResult`, `ReadResult`, `WriteResult`, `EditResult`, `GlobResult`, `GrepResult`) that carry an `error` field rather than raising.
- **Backends can be passed as a factory** `backend=lambda rt: ...` where `rt` is the LangGraph `Runtime`. This is the key hook for dynamic scoping: the factory runs at tool-call time and can read `rt.context` (your `user_id`/`agent_id`), `rt.server_info`, and `rt.execution_info` (thread_id). Each tool internally calls `_get_backend(runtime)` to resolve the backend at execution time, which is what makes runtime-dependent scoping possible.

### 2. CompositeBackend routing semantics

- `CompositeBackend(default=..., routes={"/prefix/": backend, ...})` matches the **longest prefix first** (e.g. route `/memories/projects/` overrides `/memories/`). The matched prefix is **stripped** before delegating to the routed backend (e.g. `/memories/notes.txt` with route `/memories/` → backend sees `/notes.txt`), and re-added in `ls`/`glob`/`grep` results. Unmatched paths fall to `default`.
- Internal artifacts (large tool-result eviction under `/large_tool_results/`, conversation history) are written to the **default** backend — so make the default a `StateBackend` to keep those ephemeral and off disk.

### 3. Memory & the AGENT(S).md convention

- Long-term memory is "filesystem-backed": you pass `memory=["/memories/AGENT.md"]` and the agent loads those files into the system prompt at startup (via `MemoryMiddleware.before_agent`). Persistence across conversations comes from routing `/memories/` to a persistent backend (`StoreBackend` or a disk `FilesystemBackend`).
- **Scope is controlled by the backend namespace/root**, not by the agent. For user-shared memory you scope the memory mount to the user; deepagents' own docs show `namespace=lambda rt: (rt.server_info.user.identity,)` for per-user isolation and `(assistant_id,)` for per-agent isolation. This maps directly onto your requirement that *all* of a user's agents share `AGENT.md` while each agent's own subtree is isolated.

### 4. Skills

- A skill is a directory containing `SKILL.md` (YAML frontmatter: name + description). You pass `skills=["/skills_registry/"]`; at startup only names/descriptions are injected (progressive disclosure), and the full `SKILL.md` is read on demand. Skills paths are relative to the backend root. Later sources override earlier (last-wins) for same-named skills.
- Skills are loaded through the same backend, so a read-only mount for the registry is enforced the same way as any other path. Subagents can be given their own isolated skill sets that are not inherited.

### 5. Permissions & policy controls (everything available)

deepagents gives you **four** distinct control surfaces:

1. **`permissions=[FilesystemPermission(...)]`** (requires `deepagents>=0.5.2`). Declarative path allow/deny on the *built-in* filesystem tools only. Fields: `operations` (`["read","write"]`; "read" = ls/read_file/glob/grep, "write" = write_file/edit_file), `paths` (glob list, supports `**` and `{a,b}` alternation), `mode` (`"allow"`/`"deny"`, default `"allow"`). **First-match-wins; no match = allowed (permissive default)** — so always end with a `/**` deny. Applies at the tool level, NOT the backend level (direct backend use bypasses it), and does NOT cover custom tools, MCP tools, or sandbox `execute`. With a `CompositeBackend` whose default is a sandbox, every permission path must be scoped under a known route prefix or it raises `NotImplementedError`.
2. **Custom backend / "policy hooks"** — subclass a backend or wrap one implementing `BackendProtocol` to add validation, audit logging, rate limiting, content inspection. (Exact API below.)
3. **Per-tool enable/disable & subagent permissions** — subagents inherit parent permissions unless they set their own `permissions` field (which fully *replaces* the parent's). You can give a read-only auditor subagent a write-deny ruleset.
4. **Middleware interception** — LangChain agent middleware hooks (`before_agent`, `before_model`/`wrap_model_call`, `wrap_tool_call`/`awrap_tool_call`) and **`interrupt_on={"write_file": True, ...}`** human-in-the-loop interrupts on writes.

### 6. The "policy hooks" API is NOT a built-in class

The official "Add policy hooks" docs section shows **user-defined** patterns, not a library API. There is **no** `policy=` parameter, **no** `BackendMiddleware`, **no** decorator — confirmed by checking the full class index at `reference.langchain.com/python/deepagents`. You either subclass a concrete backend or write a generic `BackendProtocol` wrapper. To **deny**, return the result type with `error=` set (the docs emphasize: do not raise); to **allow**, delegate to `super()`/`self.inner`. The docs' `GuardedBackend`/`PolicyWrapper` are example names you define yourself. (Note: the separate declarative `permissions=` mechanism is the right tool for simple path allow/deny; reserve custom backends for logic permissions can't express.)

### 7. Version landscape (check what you're on)

- Current line is **deepagents 0.6.x** — PyPI's current release is **0.6.8** (`deepagents-0.6.8.tar.gz`), and the GitHub Releases page shows the prior signed tag `deepagents==0.6.7` published 30 May 2026. The official "New in Deep Agents v0.6" blog describes the release as "centered around performance at the model layer, the agent layer, at scale, and over time," adding a code interpreter (`deepagents[quickjs]` / REPLMiddleware), Harness profiles, typed streaming, and DeltaChannel delta-based checkpoint storage giving "10-100x reductions in checkpointer storage."
- Key milestones: **0.2** (Oct 28 2025) introduced pluggable backends + `CompositeBackend`; **0.4** added pluggable sandboxes (Modal/Daytona/Runloop); **0.5.0** added `rt.server_info`/`rt.execution_info`; **0.5.2** made the backend/namespace factory receive a `Runtime` directly (older 0.5.x passed a `BackendContext`) and is the floor for `FilesystemPermission`. `BackendContext` `.runtime`/`.state` accessors are deprecated and slated for removal in `>=0.7`.
- **Confirm your version:** `python -c "import deepagents; print(deepagents.__version__)"` or `pip show deepagents`. Then verify the API: `from deepagents import FilesystemPermission` (exists ≥0.5.2), and check whether `FilesystemBackend.__init__` accepts `virtual_mode` and whether your backend factory receives a `Runtime` vs `BackendContext`.

## Details

### Mapping your structure onto deepagents

Your on-disk layout per user:

```text
filesystem/<user-id>/AGENT.md                      # shared across ALL agents of this user
filesystem/<user-id>/<agent-id>/<conversation-id>/ # per-agent, per-conversation work
filesystem/<user-id>/<agent-id>/skills/            # per-agent skills
skills_registry/                                   # global read-only registry
```

The agent should see a clean **virtual** namespace, e.g.:

- `/memories/AGENT.md` → real `filesystem/<user-id>/AGENT.md` (shared user memory, read-write)
- `/agent/` → real `filesystem/<user-id>/<agent-id>/` (this agent's conversations + skills, read-write)
- `/skills_registry/` → real `skills_registry/` (read-only)
- everything else → ephemeral `StateBackend` (so internal artifacts never hit disk)

This is exactly the CompositeBackend + dynamic-root pattern. Because each `FilesystemBackend` has its own `root_dir` computed from `user_id`/`agent_id`, **agent A literally has no backend that can resolve a path into agent B's directory** — the isolation is structural, not rule-based.

### End-to-end code: dynamic scoped composite backend

```python
from dataclasses import dataclass
from pathlib import Path

from deepagents import create_deep_agent, FilesystemPermission
from deepagents.backends import CompositeBackend, StateBackend, FilesystemBackend

FS_ROOT = Path("/data/filesystem").resolve()          # bind-mounted into container
SKILLS_REGISTRY = Path("/data/skills_registry").resolve()

@dataclass
class Context:
    user_id: str
    agent_id: str
    # conversation_id is the LangGraph thread_id; available via rt.execution_info

def _safe_segment(value: str) -> str:
    # Defense against path traversal via the IDs themselves.
    if not value or "/" in value or "\\" in value or ".." in value or value.startswith("."):
        raise ValueError(f"Illegal id segment: {value!r}")
    return value

def make_backend(rt) -> CompositeBackend:
    user_id = _safe_segment(rt.context.user_id)
    agent_id = _safe_segment(rt.context.agent_id)

    user_root = (FS_ROOT / user_id)
    agent_root = (user_root / agent_id)
    user_root.mkdir(parents=True, exist_ok=True)
    agent_root.mkdir(parents=True, exist_ok=True)

    # Verify computed roots stay inside FS_ROOT (belt-and-suspenders).
    assert str(agent_root.resolve()).startswith(str(FS_ROOT) + "/")

    return CompositeBackend(
        default=StateBackend(rt),  # ephemeral: scratch + internal artifacts
        routes={
            # Shared user memory: AGENT.md lives at the USER level, above agents.
            "/memories/": FilesystemBackend(root_dir=str(user_root), virtual_mode=True),
            # This agent's own subtree (its conversation folders + its skills).
            "/agent/": FilesystemBackend(root_dir=str(agent_root), virtual_mode=True),
            # Global skills registry, mounted read-only via permissions below.
            "/skills_registry/": FilesystemBackend(root_dir=str(SKILLS_REGISTRY), virtual_mode=True),
        },
    )

agent = create_deep_agent(
    model="anthropic:claude-sonnet-4-6",
    context_schema=Context,
    backend=make_backend,
    memory=["/memories/AGENT.md"],            # shared user memory loaded at startup
    skills=["/skills_registry/", "/agent/skills/"],  # registry + per-agent (last wins)
    permissions=[
        # Skills registry is read-only.
        FilesystemPermission(operations=["write"], paths=["/skills_registry/**"], mode="deny"),
        # Allow read+write only inside the three known mounts.
        FilesystemPermission(operations=["read", "write"],
                             paths=["/memories/**", "/agent/**", "/skills_registry/**"],
                             mode="allow"),
        # Deny everything else (covers any path the model invents).
        FilesystemPermission(operations=["read", "write"], paths=["/**"], mode="deny"),
    ],
    interrupt_on={"write_file": True, "edit_file": True},  # optional HITL on writes
)

# Per request, scope dynamically:
result = agent.invoke(
    {"messages": [{"role": "user", "content": "Update my notes."}]},
    config={"configurable": {"thread_id": "<conversation-id>"}},
    context=Context(user_id="u-123", agent_id="a-research"),
)
```

Notes:

- **AGENT.md above the agent level:** because `/memories/` is rooted at `filesystem/<user-id>/` (not at the agent), every agent of that user reads/writes the *same* `AGENT.md`. Switching `agent_id` changes only the `/agent/` root.
- **Per-agent isolation:** `/agent/` is rooted at `filesystem/<user-id>/<agent-id>/`, so conversation folders (`/agent/<conversation-id>/`) and `/agent/skills/` resolve only inside this agent's subtree. There is no route that resolves into a sibling agent's folder.
- **conversation_id:** use the LangGraph `thread_id` (passed in `config.configurable.thread_id`). The agent writes per-conversation files under `/agent/<thread_id>/...`; you can also read `rt.execution_info.thread_id` inside the factory to auto-create that folder.
- **Multi-tenant memory variant:** if you'd rather not keep user memory on shared disk, route `/memories/` to a `StoreBackend(namespace=lambda rt: (rt.context.user_id,))` instead — the namespace gives DB-backed per-user isolation with no shared filesystem at all.

### Belt-and-suspenders: a custom guarded/audit backend

For audit logging or extra validation (the "policy hooks" pattern), wrap any backend. This is a **user-defined** class, not a library class:

```python
from deepagents.backends.protocol import (
    BackendProtocol, WriteResult, EditResult, LsResult, ReadResult, GrepResult, GlobResult,
)

class PolicyWrapper(BackendProtocol):
    def __init__(self, inner: BackendProtocol, deny_prefixes=None, audit=None):
        self.inner = inner
        self.deny_prefixes = [p if p.endswith("/") else p + "/" for p in (deny_prefixes or [])]
        self.audit = audit or (lambda *a, **k: None)

    def _deny(self, path: str) -> bool:
        return any(path.startswith(p) for p in self.deny_prefixes)

    def ls(self, path): return self.inner.ls(path)
    def read(self, file_path, offset=0, limit=2000):
        self.audit("read", file_path)
        return self.inner.read(file_path, offset=offset, limit=limit)
    def grep(self, pattern, path=None, glob=None): return self.inner.grep(pattern, path, glob)
    def glob(self, pattern, path="/"): return self.inner.glob(pattern, path)
    def write(self, file_path, content):
        if self._deny(file_path):
            return WriteResult(error=f"Writes not allowed under {file_path}")
        self.audit("write", file_path)
        return self.inner.write(file_path, content)
    def edit(self, file_path, old_string, new_string, replace_all=False):
        if self._deny(file_path):
            return EditResult(error=f"Edits not allowed under {file_path}")
        return self.inner.edit(file_path, old_string, new_string, replace_all)
```

To **deny**, return the result with `error=` set (do not raise); to **allow**, delegate to `self.inner`. Note that `permissions=` already gives you declarative path rules at the tool layer — reserve this wrapper for logic permissions can't express (audit, rate limiting, content inspection), and remember it sees *post-route-stripped* paths if placed inside a CompositeBackend route. The result-type fields are: `WriteResult(error, path, files_update)`, `EditResult(error, path, files_update, occurrences)`, `ReadResult(error, file_data)`, `LsResult(error, entries)`, `GrepResult(error, matches)`, `GlobResult(error, matches)`. External backends (filesystem/store) set `files_update=None` since data is already persisted; only in-state backends populate it.

### OS-level hardening inside Docker (defense in depth)

The container is your real security boundary. Recommended `docker run` / compose:

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
    cap_drop: [ALL]                # drop all Linux capabilities
    security_opt:
      - no-new-privileges:true     # block setuid escalation
      - seccomp:/etc/docker/seccomp-agent.json   # custom/default seccomp allowlist
      # - apparmor:docker-agent    # optional MAC profile (path-based deny rules)
    tmpfs:
      - /tmp:rw,noexec,nosuid,size=64m
    volumes:
      # ONLY the scoped data dir is mounted; nothing else of the host is visible.
      - type: bind
        source: /srv/agent-data/filesystem
        target: /data/filesystem
      - type: bind
        source: /srv/agent-data/skills_registry
        target: /data/skills_registry
        read_only: true            # registry is read-only at the OS layer too
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
  --cap-drop=ALL \
  --security-opt no-new-privileges:true \
  --security-opt seccomp=/etc/docker/seccomp-agent.json \
  -v /srv/agent-data/filesystem:/data/filesystem \
  -v /srv/agent-data/skills_registry:/data/skills_registry:ro \
  --network internal --memory 512m --cpus 0.5 \
  myagent
```

Key points:

- **Scoped bind mount** is the OS analogue of the CompositeBackend: the container can only ever see `/data/filesystem` and `/data/skills_registry`. The rest of the host filesystem is not in the mount namespace at all, so even a total app-layer bypass cannot reach it.
- **Read-only rootfs + dropped caps + no-new-privileges + seccomp** together "cripple most exploit chains": the agent can't write a payload to the root fs, can't escalate via setuid, and the seccomp allowlist (Docker's default blocks ~44 of 300+ syscalls; a custom profile blocks more) shrinks the kernel attack surface. `CAP_SYS_ADMIN` in particular must never be granted — it's required to manipulate mounts and would let a process unmount the read-only/scoped bind mounts.
- **Per-user/agent OS ownership** is harder with a single long-lived container: bind-mount ownership defaults to root and the container UID/GID must be aligned with the host owner (`--user uid:gid` + pre-`chown -R uid:gid` the subtree), otherwise you get "permission denied." For strict OS-level per-user isolation, run **one container per user (or per session)** with that user's subtree bind-mounted and a matching UID/GID owning only that subtree. The app-layer CompositeBackend then handles per-*agent* separation within that user's container. Optionally enable Docker **user namespaces** (`userns-remap`) so container UID 0 maps to an unprivileged host UID — a container escape lands as a non-root host user.
- **For untrusted code execution** (only relevant if you ever add an `execute`/sandbox tool): containers share the host kernel and are not a strong boundary for adversarial code. Escalate to **gVisor** (userspace "Sentry" kernel intercepting syscalls, reducing the host kernel surface to ~20 syscalls, with a documented "10-30 percent" performance overhead per Google's GKE Sandbox docs; Google uses gVisor to sandbox App Engine/Cloud Run/Cloud Functions, and Modal uses it too), **Firecracker/Kata microVMs** (separate guest kernel per workload; Firecracker boots "in as little as 125 ms," supports "up to 150 microVMs per second per host," and has a "< 5 MiB memory footprint" — the strongest isolation), or **nsjail** (namespaces + seccomp-bpf, sub-20ms, good *inside* a container). For this filesystem-only use case you do not need these — just omit shell tools.

### App layer vs OS layer vs both — recommendation

| Layer | Enforces | Strength | Bypass risk |
|---|---|---|---|
| CompositeBackend + dynamic root | Per-user/agent path scoping, virtual namespace | Structural (no backend can resolve outside its root) | App bug, or any non-built-in tool that touches disk directly |
| `permissions=` + `virtual_mode=True` | Read-only/deny rules; blocks `..`,`~`,abs paths | Good for built-in tools | Does not cover custom/MCP/shell tools; direct backend calls bypass |
| Custom guarded backend | Audit, rate-limit, content rules | As good as your code | — |
| Docker (non-root, scoped bind mount, ro-rootfs, cap-drop, seccomp) | OS-level filesystem boundary | Real security boundary | Kernel exploit (mitigate w/ gVisor/microVM if running untrusted code) |

**Verdict: do both.** App layer for ergonomics + dynamic per-user/per-agent scoping and clean virtual paths; OS layer because deepagents explicitly does not treat the app layer as a security boundary and `virtual_mode` is explicitly "not sandboxing." The two are complementary: the bind mount caps the blast radius to the data dir; the CompositeBackend partitions *within* that dir by user and agent.

## Recommendations

1. **Pin and confirm your version first.** Target `deepagents>=0.5.2` (ideally current 0.6.x, e.g. 0.6.8) so `FilesystemPermission` and the `Runtime`-based factory exist. Verify with `pip show deepagents` and `from deepagents import FilesystemPermission`.
2. **Implement the dynamic `CompositeBackend` factory** keyed off `Context(user_id, agent_id)` exactly as above. Validate the ID segments (`_safe_segment`) to prevent traversal injected *through the IDs*, and `assert` resolved roots stay under `FS_ROOT`.
3. **Always set `virtual_mode=True`** on every `FilesystemBackend` (its absence provides no path protection — confirmed in the source) and keep `StateBackend` as the composite `default` so internal artifacts (large-result eviction, conversation history) stay ephemeral.
4. **Add the three-rule `permissions` ladder** (deny registry writes → allow the three mounts → deny `/**`). Remember first-match-wins and the permissive no-match default — order the most specific rules first.
5. **Do NOT enable any sandbox/shell backend or `execute` tool** for this OS-scoped agent; permissions and `virtual_mode` don't apply to shell. If you later need code execution, isolate it in a separate gVisor/microVM sandbox, not in this container.
6. **Harden the container**: non-root user, scoped bind mount only, `--read-only` + tmpfs, `--cap-drop=ALL`, `--security-opt no-new-privileges`, seccomp, resource limits, internal network; never grant `CAP_SYS_ADMIN`.
7. **For strict OS-enforced per-user isolation**, run one container/session per user with that user's subtree bind-mounted and a matching UID/GID; let the CompositeBackend handle per-agent separation inside it. Consider `userns-remap`.
8. **Add `interrupt_on` for writes** (and optionally a `PolicyWrapper` for audit logging) if you need human review or a tamper-evident trail.

**Thresholds that change the plan:** If you must run *untrusted generated code* → add gVisor or a Firecracker microVM and treat the container as insufficient. If you go *fully multi-tenant on shared infra* → move per-user memory to a `StoreBackend` with `namespace=(user_id,)` (DB-backed, no shared disk) instead of disk roots. If you're stuck on `deepagents<0.5.2` → you lack `FilesystemPermission`; rely on the custom guarded backend + container hardening until you can upgrade.

## Caveats

- **"Trust the LLM" model.** deepagents' README states verbatim that boundaries must be enforced "at the tool/sandbox level, not by expecting the model to self-police." Treat all app-layer controls as guardrails, not a sandbox.
- **`permissions` scope is narrow.** It applies only to the six built-in filesystem tools, at the tool layer; custom tools, MCP tools, and sandbox `execute` are not covered, and direct backend calls bypass it. With a sandbox-default CompositeBackend, permission paths outside a known route raise `NotImplementedError`.
- **`virtual_mode=True` is guardrail, not isolation.** The source explicitly warns it "does not provide sandboxing or process isolation," and the *default* `virtual_mode=False` "provides no security even with `root_dir` set" (absolute paths and `..` bypass `root_dir`).
- **Bind-mount ownership quirks.** A non-root container user may see bind-mounted dirs owned by root; align UID/GID (`--user`) and pre-`chown` the subtree, use named volumes, or use an init step. User-namespace remapping changes the effective host UIDs again.
- **`GuardedBackend`/`PolicyWrapper` are illustrative**, not importable library classes — there is no built-in policy-hook API (`policy=`, `BackendMiddleware`, decorator all absent).
- **Fast-moving API.** Class/parameter names and the `Runtime` vs `BackendContext` factory signature have changed across 0.2→0.6; always check the installed version's reference. Some third-party blogs use the older `backend=lambda rt: CompositeBackend(default=StateBackend(rt), ...)` form, which still works but differs subtly from the newer instance form (`backend=CompositeBackend(default=StateBackend(), ...)` with `store=` passed to `create_deep_agent`). Dates/version numbers here reflect PyPI/GitHub as of early June 2026.
