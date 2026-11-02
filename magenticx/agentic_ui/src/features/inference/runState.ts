/**
 * The pure run-state fold shared by every live view of a run: the main chat
 * (`useInferenceRuns`) and the agent builder's "Try it" panel
 * (`useAgentTrial`). A WebSocket frame, a start answer or a cancel/resume
 * answer goes in; the run with its timeline folded comes out. Kept apart from
 * either hook so both read a frame exactly the same way.
 */
import {
  createTimeline,
  foldTimeline,
  reduceTimelineEvents,
  timelineThoughtStrings,
} from "./timeline";
import type { InferenceRun, InferenceRunEvent, MessageOut } from "@/shared/lib/types";

const ACTIVE_STATUSES = new Set(["queued", "running", "cancelling"]);

export const patchMessage = (messages: MessageOut[], message: MessageOut) => {
  const found = messages.some((item) => item.id === message.id);
  return found
    ? messages.map((item) => (item.id === message.id ? message : item))
    : [...messages, message];
};

export const isActiveRun = (run: InferenceRun | null | undefined) =>
  Boolean(run && ACTIVE_STATUSES.has(String(run.status)));

/**
 * Has the agent actually started doing something on this run — a timeline block
 * (thinking/tool/content), a thought, or a pending HITL interrupt?
 *
 * A live run with none of these is still in its transition phase: the UI shows
 * the pulsing bridge dot under the user's message and no thinking block yet.
 * Shared by the event fold and the optimistic paint below so the two can never
 * disagree about what counts as "started".
 */
export const runHasAgentSignal = (run: InferenceRun, thoughts: string[]) =>
  thoughts.length > 0 || (run.timeline?.blocks.length ?? 0) > 0 || (run.pendingInterrupts ?? 0) > 0;

/** The thoughts a run currently carries, preferring its folded timeline. */
export const runThoughts = (run: InferenceRun): string[] =>
  run.timeline ? timelineThoughtStrings(run.timeline) : (run.thinking ?? []);

export const foldRunSnapshot = (run: InferenceRun): InferenceRun => ({
  ...run,
  timeline: foldTimeline(run.rawEvents, {
    status: String(run.status),
    legacyMessage: { content: run.content, thinking: run.thinking },
  }),
});

// One run state per conversation, folded incrementally. "events" frames carry
// only the new AG-UI events + run meta; "snapshot"/"terminal" frames carry the
// full state (rawEvents = the coalesced log) and are re-folded from scratch.
// "update" is the client-local merge of cancel/resume REST responses — meta
// only, so the in-progress timeline is preserved.
export const mergeRunEvent = (
  existing: InferenceRun | null | undefined,
  event: InferenceRunEvent,
): InferenceRun => {
  const incoming = event.run;
  const base = existing && existing.id === incoming.id ? existing : null;

  if (event.type === "events") {
    const fallback = base ?? { ...incoming, timeline: createTimeline() };
    const previousTimeline = fallback.timeline ?? createTimeline();
    return {
      ...fallback,
      status: incoming.status ?? fallback.status,
      pendingInterrupts: incoming.pendingInterrupts ?? fallback.pendingInterrupts,
      errorMessage: incoming.errorMessage ?? fallback.errorMessage ?? null,
      completedAt: incoming.completedAt ?? fallback.completedAt ?? null,
      cancelRequestedAt: incoming.cancelRequestedAt ?? fallback.cancelRequestedAt ?? null,
      updatedAt: incoming.updatedAt,
      timeline: event.events?.length
        ? reduceTimelineEvents(previousTimeline, event.events)
        : previousTimeline,
    };
  }

  if (event.type === "update" && base) {
    return {
      ...base,
      status: incoming.status ?? base.status,
      errorMessage: incoming.errorMessage ?? base.errorMessage ?? null,
      completedAt: incoming.completedAt ?? base.completedAt ?? null,
      cancelRequestedAt: incoming.cancelRequestedAt ?? base.cancelRequestedAt ?? null,
      updatedAt: incoming.updatedAt,
    };
  }

  return foldRunSnapshot(incoming);
};
