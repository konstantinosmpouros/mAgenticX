import { createContext, useContext, type ReactNode } from "react";
import type { ResumeInferenceRunBody } from "@/shared/lib/api";

// HITL approval flow plumbing shared across the chat tree. Provided once at
// ChatPage level using the useInferenceRuns hook's resumeRun/isInterruptResolved
// helpers; consumed by AgentRunTimeline and the interrupt UIs without prop
// drilling through every intermediate component.

export type HitlContextValue = {
  resumeRun: (runId: string, body: ResumeInferenceRunBody) => Promise<void>;
  isInterruptResolved: (runId: string, interruptId: string) => boolean;
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
