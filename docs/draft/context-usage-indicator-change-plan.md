# Change Plan — Context-window & cost indicator in the composer

> **Status:** draft / not started. WIP note, not authoritative.
> **Owner:** —  **Target branch:** `feat/context-usage` (this is a cross-service
> feature with a DB migration, not a UI bug — it doesn't belong on
> `fix/ui-ux-bugs`).

## 1. Goal

Put a compact indicator in the chat composer (input bar) that shows, for the open
conversation:

1. **Context-window fill** — a ring/progress showing how full the agent's model
   context is (`used ÷ window`), colour-shifting toward warning as it fills.
2. **Estimated cost** — a running `≈ $` estimate for the conversation, on hover.

Modelled on the shadcn "Context" AI component, but fed by our own data and
honestly labelled.

## 2. Why this needs backend + agents changes

The frontend today knows nothing about which model an agent runs or how big its
window is, and the token numbers we persist are the wrong shape for a fill ring:

- Each AI message's `input_tokens`/`output_tokens` (`messages` table) are
  **summed across every model call + sub-agent in the run**
  (`inference_runs.py:295` `_accumulate_usage`) — a *spend* number, inflated well
  beyond the actual context occupancy. Good for cost, wrong for the ring.
- No model id, context-window size, or pricing exists anywhere the UI can reach.

So the ring's **denominator** (window) must come from the agent's declared model,
and its **numerator** (used) must be a real occupancy number, not the inflated sum.

## 3. Design decisions

- **Denominator = the agent's declared primary model's context window.** Deep
  agents already have a `main_model` (e.g. `deep_agents/omni_agent/__init__.py:88`);
  multi-model LangGraph agents declare one representative primary model. The
  agents service owns a `model → context_window` (and `model → price`) map and
  publishes the resolved numbers in its manifest — the single source of truth,
  so the UI just renders.
- **Numerator = peak top-level `input_tokens` for the turn.** The bridge already
  separates **top-level** model usage (`inference_runs.py:433`) from
  **sub-agent-wrapped** usage (`:429`). The top-level main-model prompt size *is*
  the context-window occupancy (system prompt + tools + history + memory +
  retrieved context that went into the main model). We capture its per-run peak.
  → The ring fills in **after the first response** and reflects the **most recent
  turn's** true occupancy (server truth, not a live client guess).
- **Cost is an estimate.** A run blends the main model with sub-agent models; we
  price on the primary model's rate. Labelled `≈ est.`
- **Honest labelling.** Ring = "context" (used/window). Hover shows cumulative
  input/output (spend) + est. cost separately, so the two bases aren't conflated.

## 4. Phased implementation

### Phase 1 — Agents: publish model facts in the manifest

- Add a model registry map in the agents service (new
  `src/agents/runtime/model_registry.py`): `MODEL_CONTEXT_WINDOWS: dict[str,int]`
  and `MODEL_PRICING: dict[str, {input, output}]` (per-MTok USD). **Values must be
  verified against current model docs at implementation time.**
- Give every agent a declared **primary model**:
  - Deep agents: reuse the existing `main_model`.
  - LangGraph agents (HR / Orthodox / Retail): declare one representative model
    (the answer/generation model).
- Extend `BaseAgent.manifest()` (`src/agents/runtime/base_agent.py:99`) to emit:
  `mainModel: str`, `contextWindow: int`, `inputPricePerMTok: float`,
  `outputPricePerMTok: float` (resolved from the registry for the agent's
  primary model). Nullable-safe: unknown model → omit window/price (UI hides ring).

### Phase 2 — Bridge: persist + expose (2 migrations)

- **Migration A — `agents` table:** add `main_model` (str, null), `context_window`
  (int, null), `input_price` (numeric, null), `output_price` (numeric, null).
  Populate in `sync_agents_with_service()` (`src/dialogue_bridge/utils/agents.py:129`;
  manifest validation at `:197`) — read the new manifest fields and write the
  columns on upsert. Extend the manifest DTO in `schemas/__init__.py` accordingly.
- **Migration B — `messages` table:** add `context_tokens` (int, null) = peak
  top-level `input_tokens` for the run.
  - `InferenceRunRuntime`: alongside the existing sum, track
    `max(top_level_input_tokens)` and persist to `run.context_tokens`
    (`inference_runs.py` — write near `:1170` where `input_tokens`/`output_tokens`
    are set; capture in `_accumulate_usage`/the top-level branch at `:433`).
- **Schemas:** `AgentOut` gains `contextWindow`, `mainModel`, `inputPrice`,
  `outputPrice`; `MessageOut` gains `contextTokens` (already has
  `inputTokens`/`outputTokens`, `:1239`).
- Follow the migration workflow in CLAUDE.md (autogenerate → hand-review; no data
  destroyed; both migrations committed with the model change).

### Phase 3 — Frontend: the composer indicator

- New `src/agentic_ui/src/shared/ui/ai-elements/context.tsx` — shadcn-Context-style
  ring + Radix hover/popover breakdown. Semantic tokens only, light+dark, Framer
  Motion ≤400ms with `useReducedMotion`, `aria-label` on the trigger, ring
  `aria-hidden` with a text equivalent in the popover.
- Wire new fields through `shared/lib/schemas.ts` → `types.ts` (Zod contract for
  `AgentOut`/`MessageOut`) and `shared/lib/consts.ts` if a fallback price/window
  map is wanted for agents that don't publish one.
- Mount in `src/agentic_ui/src/features/chat/components/ChatInputBar.tsx`:
  - **Ring** = latest active-branch AI message's `contextTokens ÷ agent.contextWindow`
    (hide when either is unknown). Colour: `primary` → `warning` → `destructive`
    as it approaches full.
  - **Hover popover:** context used / window (%); cumulative input & output tokens
    (reuse `computeConversationUsage`); **est. cost** =
    `Σinput·inputPrice + Σoutput·outputPrice`, labelled `≈ est.`
  - Reuse `formatCompactTokens` (`shared/lib/utils.ts:296`).

### Phase 4 — Docs + verify

- Update `docs/flows/inference-streaming.md` (top-level occupancy capture),
  `docs/architecture/database-schema.md` (new columns), `docs/flows/catalog.md`
  (new manifest fields).
- Rebuild `agents` + `dialogue_bridge` (migrations auto-run on start) + `agentic_ui`
  (`--no-deps`); hard-refresh. Verify: ring fills after a turn, %/cost look right,
  unknown-model agents hide the ring gracefully, both themes, reduced-motion.

## 5. Data model changes (summary)

| Table | Column | Type | Source |
| --- | --- | --- | --- |
| `agents` | `main_model` | str? | manifest |
| `agents` | `context_window` | int? | manifest (model registry) |
| `agents` | `input_price` / `output_price` | numeric? | manifest (model registry) |
| `messages` | `context_tokens` | int? | peak top-level `input_tokens` per run |

## 6. API contract changes

- `AgentOut`: `+ mainModel, contextWindow, inputPrice, outputPrice`.
- `MessageOut`: `+ contextTokens`.
- Agent manifest (agents → bridge): `+ mainModel, contextWindow, inputPricePerMTok, outputPricePerMTok`.

## 7. Risks / sharp edges

- **Cost is an estimate** (blended models priced on the primary). Never present it
  as a bill.
- **Ring is per-turn, server-truth** — no live update as the user types; it reflects
  the last completed turn. This is deliberate (real vs guessed).
- **Unknown/updated models** — the registry can drift from provider changes; treat
  missing window/price as "hide the ring / hide cost," never as 0.
- **Sub-agent-heavy runs** — occupancy is the *main model's* window; sub-agents have
  their own windows we don't surface. Documented, not shown.
- **Agent cache** — `_AGENT_CACHE` is lazy; new agent columns propagate only after a
  bridge restart (existing behaviour, note it).

## 8. Testing

- Bridge: unit-test the top-level-peak capture in `InferenceRunRuntime` (top-level
  vs sub-agent-wrapped usage → `context_tokens` = max top-level, not the sum);
  migration `alembic check`.
- Bridge: `sync_agents_with_service` maps the new manifest fields onto `AgentTable`.
- Frontend: ring math + hidden states (no window / no messages); cost formula.

## 9. Open questions

- Include cost in v1, or ship the ring first and add cost as a fast follow?
- Where does the fallback model→window map live if an agent doesn't publish one —
  agents-only (preferred), or a frontend fallback in `consts.ts`?
- Show the indicator always, or gate behind the existing
  `showMessageTokenUsage` preference?
