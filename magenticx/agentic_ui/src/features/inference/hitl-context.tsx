import { createContext, useContext, type ReactNode } from "react";
import type { ResumeInferenceRunBody } from "@/shared/lib/api";

// HITL approval flow plumbing shared across the chat tree. Provided once at
// ChatPage level using the useInferenceRuns hook's resumeRun/isDecisionInFlight
// helpers; consumed by AgentRunTimeline and the interrupt UIs without prop
// drilling through every intermediate component.

export type HitlContextValue = {
  resumeRun: (runId: string, body: ResumeInferenceRunBody) => Promise<void>;
  // The bridge accepted a decision for this approval and its resolution has
  // not reached the event log yet: show "Decision sent". Temporary by design —
  // only the log's BRIDGE_HITL_RESOLVED marker settles an approval.
  isDecisionInFlight: (runId: string, interruptId: string) => boolean;
};

const HitlContext = createContext<HitlContextValue | null>(null);

export function HitlProvider({
  value,
  children,
}: {
  value: HitlContextValue;
  children: ReactNode;
}) {
  return <HitlContext.Provider value={value}>{children}</HitlContext.Provider>;
}

export function useHitl(): HitlContextValue | null {
  return useContext(HitlContext);
}
