# Change Plan (DETAILED) — Declarative agents + per-user workspaces

> Draft / WIP under `docs/draft/`, not authoritative. Branch: `feat/platform-workspaces`.
> Large, multi-service, multi-phase (agents + dialogue_bridge + agentic_ui + DB migrations).

## 0. Summary

**New functionalities**

- **Declarative agents** — drop an `agent.yaml` + `AGENT.md` in a folder and the agent exists (no Python, no rebuild).
- **Per-user workspace** — one tree per user with all their custom stuff: custom agents, skills, memory, per-agent config.
- **Custom agents** — a user can add their own agent, not just use built-ins.
- **Agents tab** (profile panel) — see each agent's model + tools and **disable tools per agent**.
- **Read-only MCP tab** — inspect available MCP servers/tools (no toggles).
- **Native-tool registry + computed catalog** — tools = `native code ∪ live MCP` (no static declarations).
- **Image → global seeding** — built-in agents ship in the image and seed into the global folder (like skills).

**What changes**

| Area | Before | After |
|---|---|---|
| Agent discovery | Python classes, import-frozen registry | filesystem YAML scan, owner-aware, refreshable (hybrid during migration) |
| Agent build | `definition.cls(config)` | `factory` → `YamlDeepAgent(spec)` |
| Tool enablement | **global** `preferences.tools.disabled`, computed client-side, sent every request | **per-(user,agent)** `disabledTools` in the workspace, resolved **server-side**; request drops the tool list |
| MCP tab | global on/off switches | read-only inspection |
| Storage | 3 volumes (global / users / filesystem) | 2 planes: `/var/magenticx/global` + `/workspaces/<user>` |
| Agent catalog (`AgentTable`) | global only | owner-aware (`owner_user_id`) |
| Prompts | Python string constants | `AGENT.md` files |

**How the flow goes (new)**

```text
1. Open app → catalog = global agents ∪ your custom agents
2. (optional) upload a custom agent · Agents tab: disable tools per agent · enable skills per agent
3. Send message (agentId, conversationId)      [browser → bridge]   ← no tool list anymore
4. Bridge forwards run (user_id, agent, conv)   [bridge → agents]
5. Agents resolve the agent:  workspaces/<you>/agents/<slug>  else  global/agents/<slug>  else  Python class
6. Build it:
     prompt  ← AGENT.md
     tools   ← agent.tools − your per-agent disabled  ∩  (native ∪ live MCP)
     skills  ← the ones you enabled for this agent (copied into /skills/)
     memory  ← workspaces/<you>/memory/<slug>/AGENTS.md   (if memory on)
     subagents ← from the YAML
7. Run (deep agent) → stream AG-UI events back to the UI
```

**One-line shift:** agents/skills/memory/tools stop being *baked into code + a global request payload* and become *global defaults merged with your workspace*, resolved server-side at run time.

## 1. Goal & principles

- **Declarative agents** — an agent is a **`agent.yaml` + `AGENT.md`** dropped in a folder. No Python, no rebuild.
- **One per-user workspace** — holds all a user's custom things: custom agents, skills, memory, per-agent config.
- **One global folder** — shared assets: built-in agents + the skill registry.
- **Tools stay platform-owned** — users don't author or globally toggle tools; they may only **disable tools per agent**. Skills stay user-curated.
- **v1 = deep agents only** (LangGraph agents stay Python — deferred, needs a graph interpreter).

## 2. Two planes (two Docker volumes on the agents service)

```text
GLOBAL   →  /var/magenticx/global/                 (seeded from image via cp -rn; admin-editable)
  agents/<slug>/{agent.yaml, AGENT.md, subagents/*.md, skills/}   built-in agents
  skills/<category>/<skill>/SKILL.md                              skill registry
  # tools = COMPUTED catalog (native code registry ∪ live MCP) — no folder

WORKSPACE →  /var/magenticx/workspaces/<user_id>/  (everything a user owns)
  agents/<slug>/{agent.yaml, AGENT.md, subagents/*.md}   user's custom agents
  skills/{manifest.json, custom/<skill>/SKILL.md}        skill pool + customs
  memory/<agent_slug>/{AGENTS.md, entries/*.yml}         per-(user,agent) memory
  runtime/<agent_slug>/<conversation_id>/{input,output,...}   ephemeral, TTL-swept
  manifest.json    ← per-agent config: { agents: { <slug>: { disabledTools: [...] } } }
```

Isolation = structural paths only (`<user_id>/…`, traversal-guarded), as today.

---

## 3. Agent definition — full spec

### 3.1 Folder shape (identical for global and workspace)

```text
<slug>/
  agent.yaml            # the declarative definition (below)
  AGENT.md              # main system prompt (markdown)
  subagents/
    researcher.md       # sub-agent system prompts (referenced from agent.yaml)
    writer.md
  skills/               # OPTIONAL: skills bundled with this agent (rare; usually enabled from the registry)
```

### 3.2 `agent.yaml` fields

| Field | Type | Req | Maps to (today) |
|---|---|---|---|
| `id` | str | ✓ | `agent_id` (manifest id) |
| `slug` | str (kebab) | ✓ | `name` (registry key + folder name) |
| `name` | str | ✓ | `label` (display name) |
| `version` | str | ✓ | `version` |
| `type` | `deep_agent` | ✓ | `AgentType` (deep only in v1) |
| `description` | str | — | `description` |
| `icon` | str (lucide) | — | `icon` |
| `prompt` | path or inline str | ✓ | `create_deep_agent(system_prompt=)` (from `AGENT.md`) |
| `model.main` | str `openai:gpt-5` | ✓ | `create_deep_agent(model=)` |
| `model.subagents.<name>` | str | — | per-sub-agent model |
| `memory` | bool (default `true`) | — | `use_memory` default (still overridable by the user pref) |
| `tools[]` | `ToolRef` | — | the agent's declared tool set (see §5) |
| `skills[]` | str ref | — | skills enabled by default for the agent |
| `subagents[]` | `SubAgentSpec` | — | `register_subagents()` → `deepagents.SubAgent` |
| `hitl.<tool>` | bool | — | `interrupt_on={...}` (HITL-gated tools) |

- **`ToolRef`** = `{ server_id, tool_name }` (MCP) **or** `{ native: <name> }` (native code tool).
- **`SubAgentSpec`** = `{ name, description, prompt (path/inline), tools: [ToolRef], model? }` → `SubAgent(model, name, description, system_prompt, tools)`.
- **Implicit tools:** context-gated builtins (`remember`, `search_past_conversations`, `present_artifact`) are auto-attached by the base per run flags — they are **not** listed in `tools:` (`deep_agent.py:280-329`).

### 3.3 Full example — `omni` translated to YAML

```yaml
id: Omni-Agent v1
slug: omni-agent-v1
name: Omni
version: 1.0.0
type: deep_agent
description: General-purpose agent for research, writing, and file management
icon: BrainCircuit
prompt: ./AGENT.md
model:
  main: openai:gpt-5
  subagents:
    researcher: openai:gpt-4o
    writer: openai:gpt-4o
memory: true
tools: []                     # omni relies on builtins + subagents; no MCP tools by default
skills: []
subagents:
  - name: researcher
    description: Deep-dives a topic, gathers and verifies sources; returns structured findings.
    prompt: ./subagents/researcher.md
    model: openai:gpt-4o
    tools: []
  - name: writer
    description: Formats and produces the final written document; saves it and returns the filename.
    prompt: ./subagents/writer.md
    model: openai:gpt-4o
    tools: []
hitl:                         # HITL_GATED_TOOLS today (omni_agent/__init__.py:14-23)
  write_file: true
  edit_file: true
  execute: true
  task: true
```

Minimal agent:

```yaml
id: notes-v1
slug: notes
name: Notes
version: 1.0.0
type: deep_agent
prompt: ./AGENT.md
model: { main: openai:gpt-4o }
```

### 3.4 Pydantic spec schema (agents service — new `runtime/agent_spec.py`)

```python
class ToolRef(BaseModel):
    model_config = ConfigDict(extra="forbid")
    server_id: str | None = None
    tool_name: str | None = None
    native:    str | None = None
    # validator: exactly one of (server_id AND tool_name) XOR native

class SubAgentSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str; description: str
    prompt: str                      # ./file.md or inline
    model: str | None = None
    tools: list[ToolRef] = []

class ModelSpec(BaseModel):
    main: str
    subagents: dict[str, str] = {}

class AgentSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")     # fail-closed on unknown keys
    id: str; slug: str; name: str; version: str
    type: Literal["deep_agent"]
    description: str = ""; icon: str = ""
    prompt: str
    model: ModelSpec
    memory: bool = True
    tools: list[ToolRef] = []
    skills: list[str] = []
    subagents: list[SubAgentSpec] = []
    hitl: dict[str, bool] = {}
```

**Validation (fail-closed):** `type` allowlisted; every `model.*` ∈ `MODEL_REGISTRY`; every `ToolRef.native` ∈ the native-tool registry; `slug` matches `^[a-z0-9-]+$`; `prompt`/sub-agent prompt paths resolve **inside the agent dir** (reuse `_safe_segment`, no traversal); unknown keys rejected.

### 3.5 Mapping `agent.yaml` → `create_deep_agent()`

`create_deep_agent(model=spec.model.main, name=spec.slug, tools=<resolved §5>+builtins, system_prompt=<AGENT.md>, subagents=[SubAgent(...)], interrupt_on=spec.hitl, middleware=default, memory=agent_md_paths, skills=skills_paths, backend=<workspace composite>, permissions=WORKSPACE_WRITE_DENY, checkpointer=...)` — i.e. exactly what `omni.register_agent()` does today (`deep_agent.py:434-450`), but every argument comes from the spec instead of Python.

---

## 4. Runtime: `YamlDeepAgent` + directory-scan discoverer

### 4.1 `YamlDeepAgent` (new `runtime/yaml_agent.py`)

A single generic `DeepAgent` subclass parameterized by an `AgentSpec` + its `source_dir`:

```python
class YamlDeepAgent(DeepAgent):
    def __init__(self, spec, source_dir, config=None):
        self._spec = spec; self._source_dir = source_dir
        self.name, self.agent_id, self.label = spec.slug, spec.id, spec.name
        self.version, self.description, self.icon = spec.version, spec.description, spec.icon
        self.instructions = _read_prompt(spec.prompt, source_dir)
        super().__init__(config=config)

    def register_subagents(self):
        return [SubAgent(model=s.model or self._spec.model.subagents.get(s.name),
                         name=s.name, description=s.description,
                         system_prompt=_read_prompt(s.prompt, self._source_dir),
                         tools=_resolve_tools(s.tools)) for s in self._spec.subagents]

    def register_agent(self):
        return self.build_deep_agent(model=self._spec.model.main,
                                     system_prompt=self.instructions,
                                     subagents=self.sub_agents,
                                     interrupt_on=self._spec.hitl)

    @classmethod
    def manifest_from_spec(spec):    # id/slug/name/version/type/description/icon + mainModel + contextWindow
        ...
```

`self.tools` (the declared set) is populated from `spec.tools` via the resolver in §5 — **not** from the request.

### 4.2 Discoverer (replaces the import-frozen `_discover_agents`, `utils/agents.py:18-49`)

```python
def scan_agents(root) -> dict[slug, AgentDefinition]:
    for d in root/"agents".iterdir():
        spec = AgentSpec.model_validate(yaml.safe_load((d/"agent.yaml").read_text()))
        yield AgentDefinition(slug=spec.slug,
                              factory=lambda cfg, s=spec, dd=d: YamlDeepAgent(s, dd, cfg),
                              manifest=YamlDeepAgent.manifest_from_spec(spec))

GLOBAL_AGENTS = scan_agents("/var/magenticx/global")          # cached, refresh on change
def user_agents(uid): return scan_agents(f".../workspaces/{uid}")   # per request/user
def resolve(uid, slug): return user_agents(uid).get(slug) or GLOBAL_AGENTS.get(slug) or PY_REGISTRY.get(slug)
```

- **`AgentDefinition.cls` → `AgentDefinition.factory`** (a callable). `router/inference.py:63` changes `definition.cls(config=req.config)` → `definition.factory(req.config)`.
- **Hybrid during migration:** `PY_REGISTRY` = today's class discovery, still merged in, so nothing breaks while agents are ported.
- **Owner-aware + refreshable:** no longer frozen at import; a dropped/edited YAML re-scans.

---

## 5. Tools — catalog + per-agent enablement (the preference change)

### 5.1 Sources (platform-owned)

- **Native**: Python tools in `src/agents/runtime/tools/`. Add a **registry** so each native tool declares metadata in code (no YAML):

```python
@native_tool(name="render_chart", description="Render an interactive chart",
             emits=["CHART_SNAPSHOT"], hitl_default=False)
def render_chart(...): ...
NATIVE_TOOLS: dict[str, NativeToolDef]   # name → callable + metadata
```

- **MCP**: live manifest from the gateway (existing `utils/mcp_tools.py`).

### 5.2 Catalog (computed, not stored)

`catalog = {native: NATIVE_TOOLS.values()} ∪ {mcp: live MCP manifest}`. No `global/tools/` folder.

### 5.3 The tool-preference change (global → per-agent)

**Today:**

- `schemas.__init__`: `ToolPreference{server_id, tool_name}`; `ToolsPreferences{disabled: [ToolPreference]}`; `UserPreferences.tools` (`:244,:271,:337`). Stored in `UserPreferencesTable.tools` JSON (`models.py:108-138`), **one global disabled list per user**.
- Frontend `useToolStatus` reads `preferences.tools.disabled`, computes `enabledTools = available − disabled` (`useToolStatus.ts:11-21`), and the inference request carries that list; the backend forwards it to `attach_tools`.

**New:**

- Per-`(user, agent)` **disabled** set lives in the **workspace manifest**:
  `workspaces/<user>/manifest.json → agents.<slug>.disabledTools: [ToolRef]`.
- The agents service **resolves** the run's tools server-side (no request list):
  `enabled = ( spec.tools − disabledTools(user, agent) ) ∩ catalog(native ∪ live MCP)`.
- **Retire:** `UserPreferences.tools` / `ToolsPreferences` (or keep the type, drop its use); the inference request stops sending `enabledTools`; `attach_tools` takes the resolved set.
- **Backfill migration:** for each `(user, agent)`, seed `disabledTools = old global preferences.tools.disabled ∩ spec.tools` (so existing user intent is preserved per agent); then drop the global field.

### 5.4 Endpoints (bridge → agents, reuse the skills-endpoint pattern)

- `GET  /v1/tools/{user}/catalog` — read-only catalog (native ∪ live MCP), grouped by server. → **MCP tab**.
- `GET  /v1/agents/{user}/{slug}/tools` — the agent's tools + per-agent disabled flags. → **Agents tab**.
- `POST /v1/agents/{user}/{slug}/tools/disable` / `.../enable` — toggle one `ToolRef` for `(user, agent)`; writes the workspace manifest; invalidates the Redis cache.

---

## 6. Skills & memory resolution (recap — unchanged mechanics, relocated)

- **Skills**: the agent sees only skills the user **enabled for that (user, agent)** — today by folder presence under `.../agents/<slug>/skills/`, copied from the global registry or the user's custom pool. Relocated under `workspaces/<user>/`. `load_skills()` still returns `["/skills/"]` (`deep_agent.py:457-469`).
- **Memory**: per-`(user, agent)`, `workspaces/<user>/memory/<slug>/AGENTS.md` (+ `entries/`), mounted at `/memories/` only when `use_memory` (`deep_agent.py:482-499`). No global memory.

---

## 7. Resolution at inference time (how global + workspace merge)

Run keyed `(user_id, agent, conversation_id)`; composed from global + **that user's** workspace only.

```text
agent def : resolve(user, slug) = workspaces/<user>/agents/<slug>  else  global/agents/<slug>  else  PY_REGISTRY
tools     : ( spec.tools − disabledTools(user, agent) ) ∩ catalog(native ∪ live MCP)
skills    : enabled-for-(user,agent)  →  copied from global/skills OR workspace pool into /skills/
memory    : workspaces/<user>/memory/<slug>/AGENTS.md   (workspace-only; gated by use_memory)
```

| Asset | Global part | Workspace part | Merge rule |
|---|---|---|---|
| Agent def | built-in YAML | user custom YAML | union; workspace resolves first (Open #2) |
| Tools | catalog (native ∪ MCP) | per-agent *disabled* set | `spec.tools − disabled ∩ catalog` |
| Skills | skill registry | pool + per-(user,agent) enablement | enabled refs → copied into `/skills/` |
| Memory | — | per-(user,agent) memory | workspace only |

---

## 8. Changes by service — file by file

**Agents service (`src/agents/`)**
- **New** `runtime/agent_spec.py` (AgentSpec + validators), `runtime/yaml_agent.py` (`YamlDeepAgent`), `runtime/tools/registry.py` (native-tool registry + `@native_tool`), `runtime/tool_catalog.py` (native ∪ live MCP), tool resolver + `agents_seed/` seeder.
- **Changed** `utils/agents.py` (dir-scan owner-aware discoverer; `AgentDefinition.cls→factory`), `router/inference.py:63` (factory call; drop request `config.tools`, resolve server-side), `runtime/base_agent.py` (`attach_tools` takes the resolved set), `runtime/filesystem/{provisioner,workspace}.py` (roots → `/var/magenticx/{global,workspaces}`, add `manifest.json` reader for `disabledTools`), `runtime/skill_registry/*` (roots), `runtime/deep_agent.py` (prompts from `AGENT.md`), `main.py`/lifespan (seed agents + skills; refreshable registry).
- **New in-image** `agents_seed/<slug>/{agent.yaml,AGENT.md,subagents/*}` (built-ins); `Dockerfile` bakes it like the skills seed. Convert `omni_agent` first.

**dialogue_bridge (`src/dialogue_bridge/`)**
- `core/database/models.py`: `AgentTable + owner_user_id` (null=global), unique `(owner_user_id, slug)`; **retire** `UserPreferencesTable.tools` usage.
- `schemas/__init__.py`: `AgentOut + owner/mainModel/contextWindow`; new tool-catalog + per-agent-tool DTOs; deprecate `ToolsPreferences`.
- `utils/agents.py:129-251`: sync global agents (owner=null); per-request resolve for user agents.
- `router/*`: new endpoints (§5.4) + custom-agent upload/list; drop `enabledTools` from the inference request handling.
- **Migrations**: (a) `agents.owner_user_id`; (b) backfill/drop `user_preferences.tools`.

**agentic_ui (`src/agentic_ui/`)**
- `McpServersTab.tsx`: **remove** `onToggleToolPreference` + the `useToolStatus` disable path → read-only inspect (servers/tools/counts). 
- **New** `AgentsTab.tsx` + `ProfileSidebar` entry: list agents; per agent show tools (native+MCP) + model; **disable per agent** (calls the new endpoints).
- Remove client `enabledTools` compute + `preferences.tools.disabled` wiring; stop sending the tool list on inference (`ChatPage`/`useInferenceRuns`/`inference.ts`).
- `shared/lib/{api,schemas,types}.ts`: catalog + per-agent-tool endpoints; `AgentOut` new fields.
- Workspace surface: custom-agent YAML upload; skills (exists); memory (exists).

**Docs**: `agents-service-reference`, `catalog`, `user-preferences`, `database-schema`, `overview`.

---

## 9. Storage migration (one-time script + boot reconciler)

`skills_registry_global → global/skills`; `skills_registry_users/<u> → workspaces/<u>/skills`; `agents_filesystem/<u>/agents/<a>/{memory,<conv>} → workspaces/<u>/{memory/<a>, runtime/<a>/<conv>}`; enabled-skill copies rebuilt from the pool. Back-compat reads during rollout; update compose volume names/mounts + `agents/core/settings.py` roots.

## 10. Phases

0. **Layout & path scaffolding** (non-breaking): new roots + helpers + back-compat reads.
1. **YAML deep agents (global)**: `AgentSpec` + `YamlDeepAgent` + discoverer + native-tool registry + computed catalog + agent seeder; port `omni`; manifest carries model/window.
2. **Workspaces + per-agent tool control**: migrate volumes; **MCP tab → read-only**; **Agents tab** per-agent disable; per-(user,agent) `disabledTools` + resolver; retire global `enabledTools`/`preferences.tools`.
3. **Per-user custom agents**: owner-aware `AgentTable` + endpoints + upload UI.
4. **(deferred) Declarative LangGraph** — graph interpreter.

## 11. Security

YAML is config, never code (strict schema, `extra=forbid`, fail-closed). Allowlist models/native-tools/skills; prompt paths confined to the agent dir. A user's agent reaches only their workspace + global. Tools platform-owned (native reviewed, MCP gateway-controlled); users only disable per agent. Per-user quotas on custom agents + skills. Isolation structural only (known limitation).

## 12. Open decisions

1. Memory/skills scope — per-(user,agent) vs user-global.
2. Agent slug collision (global vs user) — workspace override vs namespaced; `AgentTable` becoming user-scoped breaks the "agents are a global list/cache" assumption.
3. Dynamic MCP catalog — a disabled/allowed tool can vanish when a server drops; show "unavailable" vs hide.
4. Skill enablement store — keep folder-presence (current) or move into `manifest.json` alongside `disabledTools`.
5. Tool-pref backfill — per-(user,agent) seed from the old global disabled set, or drop and let users re-disable.

## 13. Key anchors (current code)

`utils/agents.py:18-49` (discovery) · `deep_agent.py:434-450` (assembly) · `deep_agent.py:280-329` (native builtins) · `deep_agent.py:457-499` (skills/memory hooks) · `base_agent.py:98-109` (manifest) · `omni_agent/__init__.py:14-92` (agent shape → YAML) · `provisioner.py`/`workspace.py:128-155` (fs mounts) · `seed_global_registry.py:40`+`Dockerfile:28` (seed) · `dialogue_bridge/utils/agents.py:129-251` (catalog sync) · `models.py:40-62,108-138` (AgentTable + prefs) · `schemas/__init__.py:244,271,337` (ToolPreference/ToolsPreferences/UserPreferences) · `McpServersTab.tsx`+`hooks/useToolStatus.ts` (current global tool toggles) · `docker-compose.yaml:64-75,200-215`+`agents/core/settings.py:426-489` (volumes/roots).
