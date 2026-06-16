import { useMemo } from "react";
import { foldTimeline } from "./timeline";
import type { MessageOut, RunTimeline } from "@/lib/types";

// Derive the timeline of a settled AI message by replaying its persisted raw
// event log — memoized so the fold runs once per message state, not on every
// render. Live (still-streaming) messages must NOT use this: their timeline
// is folded incrementally on the InferenceRun by useInferenceRuns.
export function useRunTimeline(message: MessageOut | null | undefined): RunTimeline | null {
  const rawEvents = message?.rawEvents;
  const content = message?.content;
  const thinking = message?.thinking;
  const status = message?.streamingStatus ?? (message?.error ? "failed" : "completed");

  return useMemo(() => {
    if (!message) return null;
    return foldTimeline(rawEvents, {
      status,
      legacyMessage: { content, thinking },
    });
    // message identity changes whenever the bridge patches new state in
    // (terminal frame / hydration), so these deps key the fold to the run's
    // final event state without re-walking events per render.
  }, [message?.id, rawEvents, content, thinking, status]);
}
