# Workspace filesystem consolidation + two-tier skills

> **Status:** Not started
> **TODO source:** derived — the storage half of **New Features** → "Projects / Workspaces", plus the undelivered Phase 0 promise of [00 · Platform restructure](00-platform-restructure.md) ("a per-user workspace holding all custom things, one global folder for shared assets")
> **Depends on:** [00 · Platform restructure](00-platform-restructure.md) (done — defined the roots)
> **Blocks:** [01 · Custom agents per user](01-custom-agents-per-user.md) (needs the persistent mount), [03 · Projects / Workspaces](03-projects-and-workspaces.md) (consumes this layout), [12 · `create_skill` tool](12-create-skill-tool.md)
> **Services touched:** agents · agentic_ui · infra (compose + Dockerfile) — **no database migration**

Today a single user's data is scattered across three Docker volumes and two path conventions, while the two roots that were *supposed* to unify them (`/var/magenticx/global`, `/var/magenticx/workspaces`) are declared in settings, created in the image, and mounted by nothing. This plan finishes what plan 00's Phase 0 only scaffolded: **one volume, one global plane, one folder per user** holding that user's skill pool, per-agent memory, per-agent tool preferences, and every conversation's files.

It also lands a behavioural change the layout makes natural: **skills split into two tiers**. An agent ships with *default* skills declared by its definition — always on, mounted read-only, impossible for a user to disable — and the user *adds* skills from their pool on top. That asymmetry with tools (where a declared tool *can* be disabled) is deliberate: a skill is part of the agent's behavioural identity, a tool is a capability.

---

## 1. Goal & non-goals

**Goal.** Collapse `agents_filesystem` + `skills_registry_global` + `skills_registry_users` into a single `/var/magenticx` volume laid out as `global/` (definitions and catalogues) and `workspaces/users/<user_id>/` (one user's everything), migrate existing data without risking it, make "is this a conversation directory?" structural rather than a maintained denylist, and mount agent-declared default skills as a locked read-only tier.

**Non-goals.**

- **The workspace *entity*.** Multiple named workspaces per user, membership, the switcher UI, and the `(user, workspace, agent)` memory tier belong to [03](03-projects-and-workspaces.md). This plan delivers the **physical layout** that 03 then subdivides; the path deliberately reads `workspaces/users/<user_id>/` so `workspaces/<workspace_id>/` and `workspaces/orgs/<org_id>/` remain available without another move.
- **User-authored agents.** [01](01-custom-agents-per-user.md) owns those; this plan only reserves their shape (`default_skills/`) so 01 does not have to re-litigate the layout.
- **Any schema change.** Skill enablement has no database table (directory presence is the record) and tool preferences are a file. Nothing here touches Alembic — the chain stays at `0016_retire_enabled_tools`.

---

## 2. Current state

**Five roots, three volumes, two of them dead.** [`core/settings.py`](../../src/agents/core/settings.py) `FilesystemSettings` declares `user_root` (`/var/agents/filesystem`), `skills_registry_global_root`, `skills_registry_users_root`, `global_root` (`/var/magenticx/global`) and `workspaces_root` (`/var/magenticx/workspaces`). The agents service mounts only the first three:

```yaml
agents_filesystem:/var/agents/filesystem
skills_registry_global:/var/agents/skills_registry/global
skills_registry_users:/var/agents/skills_registry/users
```

Nothing is mounted at `/var/magenticx` in either `docker-compose.yaml` or `docker-compose-denis.yaml`, so `global_root` and `workspaces_root` resolve to the container's ephemeral layer. `global_root` survives in practice only because `seed_global_agents()` re-copies it from `/opt/agents_seed` on every start — which also means plan 00's documented promise that an out-of-band edit to a built-in agent persists is currently false. `workspaces_root` is read by nothing at all.

**A user's data is split across two trees.** The pool lives at `skills_registry/users/<user_id>/` (`manifest.json` + `custom/<skill>/`), while the runtime tree lives at `filesystem/<user_id>/agents/<slug>/` (`memory/`, `skills/`, `tool_prefs.json`, `<conversation_id>/`) — different volumes, no shared parent, so "delete everything for this user" is two operations on two mounts.

**Conversation dirs are direct children of the agent root**, which forces [`retention.py`](../../src/agents/runtime/filesystem/retention.py) to carry `_NON_CONVERSATION_DIRS = {"memory", "skills"}` and skip by name while iterating agent-root children. Every new directory sibling has to be added to that set or it is treated as a conversation. `tool_prefs.json` escapes only because it is a file.

**Default skills are not mounted.** [`deep_agent.load_skills()`](../../src/agents/runtime/abstractions/deep_agent.py) returns `["/skills/"]` — the per-`(user, agent)` directory — and nothing else, even though the class docstring advertises `<impl_dir>/skills/` auto-discovery. `agent.yaml` carries a `skills:` list and the seeded omni ships `skills: []`, so the *convention* exists with no runtime behind it. Critically, `create_deep_agent(skills=[...])` already accepts a **list**, so a second root needs no upstream change.

**Enabling a skill copies it.** `assign_user_skill_to_agent` → `shutil.copytree`, sourcing from the global catalogue for `type="global"` entries and from `users/<u>/custom/` for `type="custom"`. Directory presence is the enabled record; there is no DB mirror.

---

## 3. Target design

```
/var/magenticx/                                 ← ONE volume
│
├── global/                                     ═══ platform-owned; users never write here
│   ├── agents/<agent_slug>/                    platform agent DEFINITION
│   │   ├── agent.yaml · AGENT.md · subagents/
│   │   └── skills/                         ①   DEFAULT skills — locked, read-only mount
│   │       └── <skill_name>/SKILL.md
│   └── skills/<category>/<skill_name>/SKILL.md  the browsable catalogue
│
└── workspaces/
    └── users/<user_id>/                        ═══ one user's everything
        ├── skills/                             the POOL
        │   ├── manifest.json
        │   └── custom/<skill_name>/SKILL.md
        └── agents/<agent_slug>/
            ├── memory/{AGENTS.md, entries/*.yml}        → /memories/
            ├── skills/<skill_name>/SKILL.md         ②   ADDED skills — user-managed
            ├── default_skills/<skill_name>/         ①   user-authored agents only (plan 01)
            ├── tool_prefs.json
            └── conversations/<conversation_id>/
                ├── input/                               → /conversation/input/  (write-deny)
                └── output/                              → /conversation/output/
```

### 3.1 Two skill tiers

```text
effective skills = default (locked, from the definition) ∪ added (from the user's pool)
```

| Tier | Virtual route | Physical target | Write | Controlled by |
| --- | --- | --- | --- | --- |
| ① default | `/skills/default/` | platform agent → `global/agents/<slug>/skills/` · user agent → `<agent>/default_skills/` | **deny** | the agent definition |
| ② added | `/skills/added/` | `workspaces/users/<u>/agents/<slug>/skills/` | **deny** | the user |

`SkillsMiddleware` does progressive disclosure over the union, so the agent sees skill *names* and never learns which tier a skill came from.

The reason to mount tier ① rather than copy it is that **"cannot disable" becomes structural**: the default skills never enter the user's tree, so there is no folder to delete and no toggle to expose — the UI enforces nothing. A second, real benefit: a bundled skill edited in `global/` propagates to every user immediately, which the copy-on-enable path can never do.

The rule generalises to user-authored agents without a special case: *the definition decides tier ①, the user decides tier ②.* A platform agent's definition is not editable by the user, so its ① is immutable. A user's own agent **is** editable — so they change tier ① by editing the agent, not by toggling a switch. Skills authored while building an agent land in their pool as `custom` (reusable across their other agents) and are referenced by name from the YAML.

### 3.2 Name collisions

A skill name must be unique within the union for one agent. The pool already refuses names that shadow a global skill; extend the same check at add time to the target agent's default set. If a collision appears out-of-band anyway, **tier ① wins** — it is part of the agent's identity.

---

## 4. Data model & migrations

**No database migration.** Skill enablement is filesystem-only, `tool_prefs.json` is a file, and no table references any of these paths. The Alembic head stays `0016_retire_enabled_tools`.

The "migration" here is a **data move between volumes**, and it is the risky part of this plan. Design constraints:

- **Copy, never move.** The legacy tree is left byte-identical and read-only for one full deploy cycle, then detached in a *later* deploy.
- **Verify before marking.** Per-user file count + total bytes (and a hash sample) compared before writing a `.migrated` marker.
- **Idempotent + resumable.** A marker per user means a crash mid-run resumes; a second run is a no-op.
- **Never delete to satisfy a check.** A mismatch reports and skips that user, leaving them on the legacy path — degraded, not destroyed.

| Legacy path | Target path |
| --- | --- |
| `skills_registry/global/<cat>/<skill>/` | `global/skills/<cat>/<skill>/` |
| `skills_registry/users/<u>/manifest.json` | `workspaces/users/<u>/skills/manifest.json` |
| `skills_registry/users/<u>/custom/<s>/` | `workspaces/users/<u>/skills/custom/<s>/` |
| `filesystem/<u>/agents/<slug>/memory/` | `workspaces/users/<u>/agents/<slug>/memory/` |
| `filesystem/<u>/agents/<slug>/skills/` | `workspaces/users/<u>/agents/<slug>/skills/` |
| `filesystem/<u>/agents/<slug>/tool_prefs.json` | `workspaces/users/<u>/agents/<slug>/tool_prefs.json` |
| `filesystem/<u>/agents/<slug>/<conv_id>/` | `workspaces/users/<u>/agents/<slug>/**conversations**/<conv_id>/` |

---

## 5. API surface

No new endpoints and no changed request/response shapes for the existing skill and tool endpoints — the physical move is invisible across the wire. Two adjustments:

- **Skill listing per agent** gains a `locked: bool` (or `source: "default" | "added"`) field so the UI can render tier ① as non-toggleable. Mirrors the `declared` flag the tools endpoint already carries.
- **Enable-skill** rejects a name that collides with the target agent's default set — `409` with the offending name, rather than silently producing a shadowed directory.

Everything stays internal-caller-only behind mTLS, with the bridge proxying as it does today.

---

## 6. Frontend surface

In `features/settings/`, the Skills surface for an agent becomes two groups, mirroring the split the Agents (tools) tab already uses:

- **From the agent** — tier ①, rendered with a lock affordance and no switch, plus one line of copy explaining that these come with the agent. This is where the tools/skills asymmetry must be made legible so it does not read as a broken toggle.
- **Added by you** — tier ②, the existing toggles unchanged.

A collision attempt surfaces the `409` as an inline field error ("this agent already has a skill named X"), not a toast.

---

## 7. Cross-cutting impact

| Area | Impact |
| --- | --- |
| **Plan 03 (workspaces)** | 03's plan also claimed the storage migration. **This plan owns the physical layout + migrator**; 03 consumes it and owns the workspace entity, membership, DB tables, the switcher UI, and the `(user, workspace, agent)` memory tier. Whichever lands second must not re-move data. |
| **Plan 01 (custom agents)** | Its blocking Phase 0 *is* this plan's Phase 0. Once the mount exists, 01 writes user agents under `workspaces/users/<u>/agents/<slug>/` and gets `default_skills/` for free. |
| **Plan 12 (`create_skill`)** | Writes into the pool at its new path; the confinement helpers it reuses move with the layout. |
| **Plan 02 (permissions)** | `workspaces/users/<u>/` leaves `workspaces/orgs/<id>/` free for org-owned assets, so 02 needs no third move. |
| **Retention** | The `conversations/` parent lets `_NON_CONVERSATION_DIRS` be deleted and the scan re-rooted. This must land **with** the move, not before — a denylist removal against the old shape would sweep `memory/`. |
| **Deployment** | One volume replaces three. On Dennis this is a bind mount under `/opt/magenticx/`, which means the `chown -R 1000:1000` discipline from the TLS-permissions lesson applies or the container cannot write its own workspace. |
| **Backups** | Today three volumes need snapshotting and none are automated. One root is a strict improvement and should be recorded as the backup unit. |
| **Docs** | [agent-memory](../flows/agent-memory.md), [tool-harness](../development/tool-harness.md), [agents-service-reference](../development/agents-service-reference.md), [configuration](../architecture/configuration.md), [overview](../architecture/overview.md). |

---

## 8. Phased execution

**Phase 0 — Provision the volume (non-breaking, unblocks plan 01).**
Add `magenticx_data:/var/magenticx` to the agents service in both compose files (bind mount under `/opt/magenticx/data/` on Dennis, `chown 1000:1000`). The Dockerfile already creates and chowns the directories.
*Acceptance:* a file written under `/var/magenticx/workspaces/` survives `up -d --build --no-deps agents`; on the second start `agents_global_seed_completed` reports `skipped=[…]` rather than `copied=[…]`, proving the global plane is now persistent.

**Phase 1 — One path authority, no data moved.**
Introduce `runtime/filesystem/layout.py` as the single owner of every path, deriving all roots from `global_root` / `workspaces_root`, behind `FILESYSTEM_LAYOUT=legacy|workspace` defaulting to **legacy**. Route every caller (`provisioner`, `user_registry`, `seed_global_registry`, `agent_seed`, `workspace`, `retention`) through it. No behaviour change.
*Acceptance:* with the flag `legacy`, every existing agents test passes untouched; table-driven tests assert both mappings for all path helpers; no module outside `layout.py` references a root setting directly.

**Phase 2 — The migrator.**
A one-shot, idempotent, per-user copy→verify→mark run inside the service lifespan *before* `refresh_registry()`, with a dry-run mode that only reports. Legacy mounts stay, read-only.
*Acceptance:* dry-run prints per-user counts/bytes; a real run is byte-verified and writes `.migrated`; a re-run is a no-op; a kill mid-run resumes cleanly; a deliberately corrupted user is skipped with a warning and still serves from legacy.

**Phase 3 — `conversations/` parent.**
New conversation dirs are created under `conversations/`; the migrator relocates existing ones; retention is re-rooted and `_NON_CONVERSATION_DIRS` deleted.
*Acceptance:* retention prunes `input`/`output` under the new shape with the same TTLs and the same activity grace; a new directory sibling under the agent root (e.g. `default_skills/`) is provably never mistaken for a conversation.

**Phase 4 — Two-tier skills.**
`load_skills()` returns both routes; `workspace.py` adds `/skills/default/` with a write-deny; the collision check lands on the enable path; the listing endpoint gains `locked`; the UI grows the "From the agent" group. Ship a real default skill on the seeded omni so the path is exercised rather than theoretical.
*Acceptance:* a default skill is discoverable by the agent and has no toggle in the UI; removing the user's added copy of a same-named skill does not affect the default; editing a bundled skill in `global/` changes agent behaviour on the next run **without** any per-user action; an attempt to add a colliding name returns 409.

**Phase 5 — Cut over, then detach.**
Flip the flag default to `workspace`; after a stability window, remove the three legacy mounts and delete the compat branch from `layout.py`.
*Acceptance:* compose declares one volume for this data; a repo-wide search finds no `/var/agents/` path outside the migrator's legacy constants; the migrator itself is deleted in a follow-up once no environment reports unmigrated users.

---

## 9. Security & privacy

- **Path confinement is unchanged and must stay unchanged.** Every segment continues through `_safe_segment()` (rejecting `/`, `\`, `..`, leading dots), and mounts stay structurally disjoint so no `FilesystemBackend` can resolve into another's subtree. Consolidating under one parent makes this *more* important, not less: `workspaces/users/<a>/` and `workspaces/users/<b>/` are now siblings, so a traversal bug would cross a tenant boundary instead of hitting a different volume. Add an explicit test that a crafted `user_id` cannot escape its own directory.
- **Tier ① is mounted read-only** with a `write` deny on `/skills/default/`, so an agent cannot rewrite its own default behaviour — the same reasoning that makes `create_skill` ([12](12-create-skill-tool.md)) a gated action.
- **Live-mounted defaults widen a blast radius.** Because tier ① is not a snapshot, an edit to `global/agents/<slug>/skills/` changes behaviour for *every* user instantly. That is the feature, but it means write access to the global plane is now a production-behaviour change and belongs behind the same review as shipping code.
- **The migrator never deletes.** Copy-only, verify-before-mark, report-and-skip on mismatch. No destructive operation runs against user data at any phase; detaching the legacy volumes is a separate, human-initiated deploy.
- **Least privilege on the mount.** One volume means one set of permissions; keep it `1000:1000`-owned and do not widen it to accommodate a tooling convenience.

---

## 10. Testing strategy

`layout.py` gets table-driven tests over both flag values for every helper, plus traversal-rejection cases. The migrator gets a fixture tree exercising: fresh user, partially migrated user, already-marked user, corrupted manifest, conversation dir relocation, and a byte-verification failure — asserting in every case that the legacy tree is untouched. Retention re-runs its existing suite against the new shape, plus a regression asserting a non-conversation sibling directory is skipped. Skills get: default-only agent, added-only, both, and a collision. One end-to-end run in-image proves an agent boots with both skill roots mounted and can read a default skill. All agents-side tests run in the container (the host lacks the pinned `deepagents`).

---

## 11. Docs to update

[agent-memory.md](../flows/agent-memory.md) (paths + the two tiers), [tool-harness.md](../development/tool-harness.md) (skills alongside tools; the disable asymmetry), [agents-service-reference.md](../development/agents-service-reference.md) (layout + mounts), [architecture/configuration.md](../architecture/configuration.md) (settings collapse + the new flag), [architecture/overview.md](../architecture/overview.md) (volumes), and the `CLAUDE.md` deployment section (one volume, bind-mount permissions).

---

## 12. Risks & open decisions

- **The migrator is the whole risk of this plan.** It touches every user's memory and files. Mitigations are structural (copy-only, verify, marker, legacy retained for a deploy, report-don't-delete), and Phase 2 should not ship the same week as Phase 5.
- **Open — does `SkillsMiddleware` accept two roots cleanly?** `create_deep_agent(skills=[...])` takes a list, but how it handles duplicate skill names across roots, and whether it dedupes or errors, is unverified. **A spike on this gates Phase 4**; if the middleware cannot express precedence, the fallback is to keep one root and copy defaults in with an immutable-name registry — which loses propagation and makes "cannot disable" a UI rule again.
- **Open — does the global skills catalogue move in this plan or later?** Moving it completes the two-plane model and gets to one volume; deferring it shrinks Phase 2. Recommendation: move it, because leaving it behind is what forces a third volume to survive.
- **Open — snapshot vs live mount for tier ①.** Live gives propagation; a snapshot gives reproducibility (an agent's behaviour cannot change under a running user). If reproducibility ever matters more, the answer is a versioned catalogue, not a copy.
- **The tools/skills asymmetry is a UX risk, not a technical one.** Two adjacent tabs will have different rules about what a user may switch off. It needs deliberate copy, and if it still confuses people the honest resolution is to make skills disable-able rather than to hide the distinction.
- **`agent.yaml` `skills:` is currently inert.** Phase 4 gives it meaning for the first time, so any spec already carrying a non-empty list would suddenly take effect. The seeded omni is `skills: []`, so today the blast radius is zero — but validate the field against the catalogue before it becomes load-bearing.

---

## 13. File map

| Concept | File | What to look for |
| --- | --- | --- |
| Roots to collapse | [core/settings.py](../../src/agents/core/settings.py) | `FilesystemSettings` — five roots today |
| New path authority | `src/agents/runtime/filesystem/layout.py` *(new)* | every root + helper, behind the layout flag |
| Path helpers to re-root | [runtime/filesystem/provisioner.py](../../src/agents/runtime/filesystem/provisioner.py) | `user_root`, `agent_root`, `memory_root`, `skills_root`, `conversation_root`, `_safe_segment` |
| Mount routes | [runtime/filesystem/workspace.py](../../src/agents/runtime/filesystem/workspace.py) | `CompositeBackend` routes + `WORKSPACE_WRITE_DENY` |
| Skill roots exposed to the agent | [runtime/abstractions/deep_agent.py](../../src/agents/runtime/abstractions/deep_agent.py) | `load_skills()` (returns one route today), `skills_paths` |
| Pool + enable/copy | [runtime/skill_registry/user_registry.py](../../src/agents/runtime/skill_registry/user_registry.py) | `resolve_skill_path`, `_enable_skill_for_agent`, `reconcile_user_manifest` |
| Catalogue seeding | [runtime/skill_registry/seed_global_registry.py](../../src/agents/runtime/skill_registry/seed_global_registry.py) | seed target root |
| Agent seeding | [runtime/abstractions/agent_seed.py](../../src/agents/runtime/abstractions/agent_seed.py) | `seed_global_agents` (no-clobber) |
| Retention scan | [runtime/filesystem/retention.py](../../src/agents/runtime/filesystem/retention.py) | `_NON_CONVERSATION_DIRS`, `_iter_scope_dirs` |
| Migrator | `src/agents/runtime/filesystem/migrate_layout.py` *(new)* | copy→verify→mark, dry-run, per-user marker |
| Volumes | [src/docker-compose.yaml](../../src/docker-compose.yaml) · [src/docker-compose-denis.yaml](../../src/docker-compose-denis.yaml) | agents `volumes:` + top-level declarations |
| Dir creation / ownership | [src/agents/Dockerfile](../../src/agents/Dockerfile) | `mkdir -p` + `chown 1000:1000` |
| Skills UI | [features/settings/components/profile_parts/](../../src/agentic_ui/src/features/settings/components/profile_parts/) | the Skills surface — add the locked "From the agent" group |
