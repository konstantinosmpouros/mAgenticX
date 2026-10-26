/**
 * Approvals whose decision the bridge accepted but has not applied yet.
 *
 * A 200 from `/resume` only means the bridge queued the decision under its
 * interrupt; it is applied when the run's `BRIDGE_HITL_RESOLVED` marker for that
 * interrupt lands in the event log (the timeline then stops listing it as
 * pending). In between the UI shows "Decision sent" instead of the approval —
 * but only for a while: a decision that never resolves must never hide the
 * approval for good. That used to happen: the client marked the interrupt
 * resolved forever on the 200, the bridge lost the decision, and when that
 * approval became the one the run was waiting on there was no card to click.
 *
 * So a sent decision is held until one of:
 *  - the event log resolves it (or the run ends) — dropped, the log is the truth;
 *  - {@link DECISION_IN_FLIGHT_GRACE_MS} pass with no new run events — dropped,
 *    the approval shows again. While the run keeps streaming the window is
 *    re-armed: a decision queued behind a running resume leg goes out when that
 *    leg ends, and its marker follows.
 *
 * Pure functions over an immutable map (`run:interrupt` → deadline in epoch ms);
 * each returns the same map when nothing changed, so React state stays stable.
 */

export const DECISION_IN_FLIGHT_GRACE_MS = 20_000;

export type DecisionsInFlight = ReadonlyMap<string, number>;

const SEPARATOR = ":";

export const decisionKey = (runId: string, interruptId: string): string =>
  `${runId}${SEPARATOR}${interruptId}`;

const keyBelongsToRun = (key: string, runId: string): boolean =>
  key.startsWith(`${runId}${SEPARATOR}`);

const interruptOfKey = (key: string, runId: string): string =>
  key.slice(runId.length + SEPARATOR.length);

/** The bridge accepted a decision for this approval (HTTP 200). */
export function markDecisionSent(
  map: DecisionsInFlight,
  runId: string,
  interruptId: string,
  now: number,
): DecisionsInFlight {
  const next = new Map(map);
  next.set(decisionKey(runId, interruptId), now + DECISION_IN_FLIGHT_GRACE_MS);
  return next;
}

/** Forget a decision (the request failed): the approval shows again. */
export function dropDecision(
  map: DecisionsInFlight,
  runId: string,
  interruptId: string,
): DecisionsInFlight {
  const key = decisionKey(runId, interruptId);
  if (!map.has(key)) return map;
  const next = new Map(map);
  next.delete(key);
  return next;
}

/** Whether to show "Decision sent" in place of this approval right now. */
export function isDecisionInFlight(
  map: DecisionsInFlight,
  runId: string,
  interruptId: string,
  now: number,
): boolean {
  const deadline = map.get(decisionKey(runId, interruptId));
  return deadline !== undefined && deadline > now;
}

export type RunProgress = {
  runId: string;
  /** The run is still queued/running/cancelling. */
  active: boolean;
  /** Interrupt ids the run's event log still lists as pending. */
  pendingInterruptIds: readonly string[];
  /** This frame carried new events: the run is alive and streaming. */
  streamed: boolean;
};

/**
 * Settle a run's sent decisions against its latest state: drop the ones the
 * log resolved (or all, when the run ended), re-arm the rest while it streams.
 */
export function settleDecisionsForRun(
  map: DecisionsInFlight,
  progress: RunProgress,
  now: number,
): DecisionsInFlight {
  let next: Map<string, number> | null = null;
  const pending = new Set(progress.pendingInterruptIds);
  for (const [key, deadline] of map) {
    if (!keyBelongsToRun(key, progress.runId)) continue;
    const resolved = !progress.active || !pending.has(interruptOfKey(key, progress.runId));
    const rearmed = now + DECISION_IN_FLIGHT_GRACE_MS;
    if (resolved) {
      next ??= new Map(map);
      next.delete(key);
    } else if (progress.streamed && deadline !== rearmed) {
      next ??= new Map(map);
      next.set(key, rearmed);
    }
  }
  return next ?? map;
}

/** Drop the decisions whose window ran out: their approvals show again. */
export function pruneExpiredDecisions(map: DecisionsInFlight, now: number): DecisionsInFlight {
  let next: Map<string, number> | null = null;
  for (const [key, deadline] of map) {
    if (deadline > now) continue;
    next ??= new Map(map);
    next.delete(key);
  }
  return next ?? map;
}

/** When the next window runs out, or null when nothing is in flight. */
export function nextDecisionDeadline(map: DecisionsInFlight): number | null {
  let earliest: number | null = null;
  for (const deadline of map.values()) {
    if (earliest === null || deadline < earliest) earliest = deadline;
  }
  return earliest;
}
