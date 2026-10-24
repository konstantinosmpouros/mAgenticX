import { PLAN_SNAPSHOT_EVENT_NAMES, PlanSnapshotSchema, type PlanSnapshot } from "./agui";
import type { PlanStepTiming } from "@/shared/lib/types";

// When each step of the agent's plan started and finished. The agent rewrites
// its whole checklist (`write_todos`) on every change, and each PLAN_SNAPSHOT
// carries the agents service's clock (`updated_at`); successive snapshots tell
// when a step changed state:
//
//   first seen in progress            → started at that snapshot
//   first seen done (after started)   → finished at that snapshot
//   done without ever being seen in progress, or a snapshot with no time
//                                     → that moment is unknown (null)
//
// The persisted event log keeps every snapshot, so the same walk gives the
// same times live (the run timeline's fold) and after a reload. Only real
// transitions are stamped; anything else stays unknown, never guessed.

type RawEvent = Record<string, unknown>;

const PLAN_EVENT_NAMES = new Set<string>(PLAN_SNAPSHOT_EVENT_NAMES);

const normalize = (content: string) => content.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * A step's identity across rewrites: its text, numbered when the same text
 * appears more than once. Statuses change, text rarely does.
 */
export function planStepKeys(plan: PlanSnapshot): string[] {
  const seen = new Map<string, number>();
  return plan.items.map((item) => {
    const text = normalize(item.content);
    const count = seen.get(text) ?? 0;
    seen.set(text, count + 1);
    return count ? `${text}#${count}` : text;
  });
}

/** The time a snapshot stands for: its own stamp, else the event's. */
export function planSnapshotTime(plan: PlanSnapshot, event?: RawEvent): number | undefined {
  if (typeof plan.updated_at === "number" && Number.isFinite(plan.updated_at)) {
    return plan.updated_at;
  }
  const stamp = event?.timestamp;
  return typeof stamp === "number" && Number.isFinite(stamp) ? stamp : undefined;
}

/**
 * The timings after `next` replaces `previous`. A step is matched by its text;
 * one reworded in place (its old text gone from the new list) keeps the
 * timing of the step it replaces.
 */
export function advancePlanTimings(
  previous: PlanSnapshot | null,
  timings: PlanStepTiming[] | undefined,
  next: PlanSnapshot,
  at: number | undefined,
): PlanStepTiming[] {
  const previousKeys = previous ? planStepKeys(previous) : [];
  const nextKeys = planStepKeys(next);
  const previousIndex = new Map(previousKeys.map((key, index) => [key, index]));
  const nextSet = new Set(nextKeys);
  const stamp = at ?? null;

  return next.items.map((item, index) => {
    let from = previousIndex.get(nextKeys[index]);
    if (
      from === undefined &&
      previous &&
      index < previous.items.length &&
      !nextSet.has(previousKeys[index])
    ) {
      from = index;
    }
    const before = from !== undefined && previous ? previous.items[from].status : null;
    const timing: PlanStepTiming = { ...(from !== undefined ? timings?.[from] : undefined) };

    if (item.status === "in_progress") {
      if (timing.startedAt === undefined) timing.startedAt = stamp;
      // Reopened: it has not finished after all.
      timing.endedAt = undefined;
    } else if (item.status === "completed") {
      // Done without being seen at work: when it started is unknown.
      if (timing.startedAt === undefined) timing.startedAt = null;
      // Already done in the answer's first snapshot: it finished before then.
      if (before !== "completed") timing.endedAt = previous ? stamp : null;
    } else {
      timing.endedAt = undefined;
    }
    return timing;
  });
}

/** How long a step took, when both ends are known (and in order). */
export function planStepDurationMs(timing: PlanStepTiming | undefined): number | null {
  const startedAt = timing?.startedAt;
  const endedAt = timing?.endedAt;
  if (typeof startedAt !== "number" || typeof endedAt !== "number") return null;
  return endedAt >= startedAt ? endedAt - startedAt : null;
}

export type FoldedPlan = { plan: PlanSnapshot; timings: PlanStepTiming[] };

/**
 * A settled answer's plan straight off its event log — the main agent's last
 * snapshot and the step timings over all of them — without folding the rest
 * of the run. Null when the answer never wrote a plan. (A sub-agent's own plan
 * arrives inside its SUBAGENT_EVENT envelope and is not the answer's plan.)
 */
export function foldPlanEvents(events: RawEvent[] | null | undefined): FoldedPlan | null {
  if (!Array.isArray(events)) return null;
  let plan: PlanSnapshot | null = null;
  let timings: PlanStepTiming[] = [];
  for (const event of events) {
    if (event?.type !== "CUSTOM" || typeof event.name !== "string") continue;
    if (!PLAN_EVENT_NAMES.has(event.name)) continue;
    const parsed = PlanSnapshotSchema.safeParse(event.value);
    if (!parsed.success) continue;
    timings = advancePlanTimings(plan, timings, parsed.data, planSnapshotTime(parsed.data, event));
    plan = parsed.data;
  }
  return plan ? { plan, timings } : null;
}
