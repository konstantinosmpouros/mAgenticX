import { createContext, useContext } from "react";
import type { BackgroundTasks } from "./useBackgroundTasks";

// The open conversation's background task tree (plan 41), shared across the
// chat tree the way the HITL context is: provided once at the workspace shell
// (`<BackgroundTasksContext.Provider>`) from useBackgroundTasks, read by the
// message parts that draw a task (the "Started task" block, the notice row,
// the drill-down) without threading it through every intermediate component.
// Null outside a conversation — a consumer then draws only what the run's own
// events say.

export type BackgroundTasksContextValue = Pick<
  BackgroundTasks,
  "tree" | "openTaskId" | "openTask" | "stopTask" | "resumeTask" | "isDecisionSent"
>;

export const BackgroundTasksContext = createContext<BackgroundTasksContextValue | null>(null);

export function useBackgroundTasksContext(): BackgroundTasksContextValue | null {
  return useContext(BackgroundTasksContext);
}
