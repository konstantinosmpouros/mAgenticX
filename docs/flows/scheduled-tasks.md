# Scheduled Tasks

Scheduled Tasks let a user run an agent **on a schedule, unattended** — once at a future time, on a fixed interval, or on a cron expression. A task fires headlessly inside the bridge, completes and persists **with no browser connected**, and surfaces its result the next time the user looks.

The feature deliberately reuses the existing inference machinery: a fire is just a normal backend-owned run, so it inherits streaming persistence, token accounting, the durable checkpointer, and the one-active-run guard for free. There is no separate execution engine and no separate result store.

---

## Big picture

```text
scheduler loop (bridge lifespan)        normal inference pipeline                 result
  every poll_interval:                                                            (durable)
   claim due tasks  ──fire──►  start_inference_flow ──► inference_run_manager ──► AI message row
   (SKIP LOCKED,                (creates AI placeholder    .launch(run_id)         (content, tokens,
    advance next_run_at,         tagged scheduled_task_id)  (detached asyncio task) raw_events,
    commit)                                                                         streaming_status)
```

- The **schedule** lives in the new `scheduled_tasks` table.
- A **fire's result** is an ordinary `messages` row, tagged with `scheduled_task_id` — that reverse tag is the durable link the UI reads for live status and per-task history. Redis only carries the live frames and expires them an hour after the run ends.

---

## Data model

Two schema changes (migration `0009_add_scheduled_tasks`):

- **`scheduled_tasks`** — the schedule (owner, agent, target mode, cadence, lifecycle). Full column reference in [database-schema.md](../architecture/database-schema.md#scheduled_tasks).
- **`messages.scheduled_task_id`** — `FK → scheduled_tasks.id ON DELETE SET NULL`, indexed. Set on the AI run message a fire produces; `NULL` on every other message. SET NULL so deleting a task never deletes the runs/results it produced.

`scheduled_tasks.last_run_message_id` is a **plain String, not an FK** — an FK there would close a `messages → scheduled_tasks → conversations → messages` cycle. The latest fire's true status is derived by looking that message up, so the task row never goes stale.

Model: [`core/database/models.py`](../../src/dialogue_bridge/core/database/models.py) (`ScheduledTaskTable`). Schemas: [`schemas/__init__.py`](../../src/dialogue_bridge/schemas/__init__.py) (`ScheduledTaskCreate` / `ScheduledTaskUpdate` / `ScheduledTaskOut`).

---

## The two target modes

Chosen per task at creation:

| Mode | What a fire does | Memory across fires | Result |
| --- | --- | --- | --- |
| `fresh` | `mode="new"` → mints a brand-new conversation each fire | None (isolated) | A new conversation per run |
| `bound` | first fire `mode="new"` (mints + stores `conversation_id`), every later fire `mode="send"` against that conversation's leaf | Yes — the durable checkpointer resumes the branch, so the agent remembers prior fires | One ongoing conversation |

In `bound` mode, while a fire is running the conversation has an active run, so the **composer is disabled** for the user there — exactly the "can't send while the workflow is running" behavior, enforced for free by the existing one-active-run-per-conversation guard.

---

## Lifecycle

### Create

`POST /v1/scheduled-tasks/{user_id}` → `create_scheduled_task` ([`utils/scheduled_tasks.py`](../../src/dialogue_bridge/utils/scheduled_tasks.py)). Validates the agent, caps per-user task count (`SCHEDULER_MAX_TASKS_PER_USER`), snapshots the tool list (`enabledTools` is client-computed — a headless fire must carry its own), and computes the initial `next_run_at` via `compute_next_run_at`.

### Claim (single-fire safe)

Each tick, `claim_due_tasks` runs one transaction:

```sql
SELECT * FROM scheduled_tasks
WHERE status='active' AND next_run_at IS NOT NULL AND next_run_at <= now()
ORDER BY next_run_at ASC LIMIT :batch
FOR UPDATE SKIP LOCKED;
```

For each claimed row it advances `next_run_at` to the next slot (or flips `status='completed'` for a spent one-off / `max_runs` / `expires_at`), then **commits before firing**. Two consequences:

- `SKIP LOCKED` means a concurrent tick — e.g. the ~30s window during an `order: start-first` deploy when two bridge containers overlap — can never claim the same row. `replicas: 1` alone is *not* enough; this claim is the actual guard.
- The row lock is released before the (possibly minutes-long) agent call, so the pool (size 5) never starves.

### Fire

`fire_scheduled_task` loads the task + owner, **skips if a prior fire is still active** (no overlap), resolves the agent, builds an `InferenceStartPayload` for the mode, and calls `start_inference_flow(..., scheduled_task_id=task.id)` then `inference_run_manager.launch(run_id)` — identical to the interactive path, just triggered internally (no HTTP/CSRF). The produced AI message is tagged with the task id.

### Persist + observe

The detached run streams, accumulates tokens, and writes its terminal state to Postgres via `_finish_run` — all server-side, **independent of any client**. See [inference-streaming.md](inference-streaming.md) for the run internals.

---

## Live visibility ("is it running?")

The management page shows two layers, both built on the durable tag:

1. **Status (durable, always correct).** `GET /v1/scheduled-tasks/{user_id}` returns each task with a derived `liveStatus` + `lastRunConversationId`, computed by `hydrate_live_status` (one batched lookup of each task's `last_run_message_id` → that message's `streaming_status` + conversation). Correct across bridge restarts and after Redis has expired the stream. `useScheduledTasks` polls this fast while the `/tasks` route is active, slow off it (no push channel exists for unsubscribed work).
2. **Token-by-token (reuse, free).** Because a fire is a real run with a Redis stream + the same WebSocket endpoint, "open result" jumps into the run's conversation where the existing `observeRun` attaches and streams the live timeline — identical to a chat run.

`InferenceRunOut` now carries `scheduledTaskId`, so a scheduled fire's active run (recovered on mount by `getActiveInferenceRuns`) is recognized as task-originated and lights the sidebar **Tasks** badge in real time.

---

## Safety properties

- **Restart recovery is self-healing.** On startup `cleanup_orphaned_inference_runs` flips any mid-stream run to `failed`; a task's next due tick then sees (via the tag) that no run is active and fires normally. A `next_run_at` that passed during downtime is claimed once at the next poll and re-armed to the next *future* slot — missed ticks are skipped, never backfilled. No dedicated reconcile pass is needed.
- **HITL watchdog.** A headless run that hits an approval gate would hang forever (the resume signal only ever comes from a live client). `reap_timed_out_fires` cancels any scheduled run still streaming past `SCHEDULER_RUN_TIMEOUT_SECONDS` and marks the fire failed. Schedule HITL-free tool sets, or expect a timeout.
- **Collision handling.** A fire that 409s (conversation busy) or 429s (per-user active-run cap) records a `skipped` outcome and waits for the next slot.

---

## API

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| `GET` | `/v1/scheduled-tasks/{user_id}` | — | `ScheduledTaskOut[]` (with live status) |
| `POST` | `/v1/scheduled-tasks/{user_id}` | `ScheduledTaskCreate` | `ScheduledTaskOut` |
| `PATCH` | `/v1/scheduled-tasks/{user_id}/{task_id}` | `ScheduledTaskUpdate` (pause/resume, label, prompt, tools) | `ScheduledTaskOut` |
| `DELETE` | `/v1/scheduled-tasks/{user_id}/{task_id}` | — | `204` |

Mutations require the CSRF token; all are scoped to the authenticated user. Router: [`router/scheduled_tasks.py`](../../src/dialogue_bridge/router/scheduled_tasks.py).

---

## Frontend

- Types + API: [`lib/types.ts`](../../src/agentic_ui/src/lib/types.ts), [`lib/api.ts`](../../src/agentic_ui/src/lib/api.ts) (`listScheduledTasks` / `createScheduledTask` / `updateScheduledTask` / `deleteScheduledTask`), transform in [`lib/consts.ts`](../../src/agentic_ui/src/lib/consts.ts).
- Hook: [`hooks/useScheduledTasks.ts`](../../src/agentic_ui/src/hooks/useScheduledTasks.ts) — load, cadence-switching poll (driven by an `active` flag = the `/tasks` route), optimistic create/update/delete, running-count badge. The hook no longer owns open/close state — the page is URL-driven.
- UI: a **Tasks** entry in the sidebar header (with a running badge) navigates to the **`/tasks`** route, which renders [`ScheduledTasksPage`](../../src/agentic_ui/src/components/chat/ScheduledTasksPage.tsx) — a full page (My Tasks / Templates tabs) that replaces the chat body while the sidebar stays, cross-fading on enter/leave. List/create/edit/pause/resume/delete/open-result, with the create/edit form in [`scheduled_tasks_parts/ScheduledTaskForm.tsx`](../../src/agentic_ui/src/components/chat/scheduled_tasks_parts/ScheduledTaskForm.tsx). Opening a task's result and closing the page are `navigate(...)` calls, so browser back/forward work.

Tasks are fetched fresh (not cached in the IndexedDB UI snapshot), so no snapshot-version bump was needed.

---

## Configuration

`SchedulerSettings` ([`core/settings.py`](../../src/dialogue_bridge/core/settings.py)):

| Env var | Default | Purpose |
| --- | --- | --- |
| `SCHEDULER_ENABLED` | `true` | Run the loop (disable on a replica that serves traffic only) |
| `SCHEDULER_POLL_INTERVAL_SECONDS` | `30` | Tick cadence |
| `SCHEDULER_CLAIM_BATCH_SIZE` | `10` | Max due tasks claimed per tick |
| `SCHEDULER_RUN_TIMEOUT_SECONDS` | `600` | Watchdog: cancel a fire streaming longer than this |
| `SCHEDULER_MAX_TASKS_PER_USER` | `50` | Per-user task cap |
| `SCHEDULER_MIN_INTERVAL_SECONDS` | `300` | Floor on recurring cadence |

---

## Limitations (phase-2 candidates)

- **In-app poll only.** No web push / email — that is the separate Notification system TODO. The badge reflects *running* tasks via poll.
- **Single replica.** The scheduler and `InferenceRunManager` both assume one bridge replica.
- **Schedule edits.** The update endpoint changes label/prompt/tools and pause/resume; changing the cadence is delete-and-recreate for now.
- **Per-task tool picker.** v1 seeds a task with the user's currently-enabled tools; a dedicated picker in the create form is deferred.
