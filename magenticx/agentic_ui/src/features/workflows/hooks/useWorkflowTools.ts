import { useCallback, useEffect, useSyncExternalStore } from "react";

import { getWorkflowTools } from "@/shared/lib/api";
import type { WorkflowToolCatalog, WorkflowToolsState } from "@/shared/lib/types";
import { WORKFLOW_TOOLS_STALE_MS } from "@/features/workflows/lib/builder/consts";

/**
 * The tools a tool step may call (`GET /v1/workflows/tools`), shared by every
 * reader on the page — the inspector's picker, its arguments, the builder's
 * checks — through one small store: one request at a time, the answer reused
 * for `WORKFLOW_TOOLS_STALE_MS`, a failure reported (`error`) with a `retry`
 * every reader sees. `enabled` false (no tool step in the workflow) asks for
 * nothing.
 *
 * A module store rather than React Query: the builder's other reads
 * (`useWorkflowCatalog`) are plain hooks, and the builder renders without a
 * QueryClientProvider in its tests.
 */

type ToolsState = {
  data: WorkflowToolCatalog | null;
  error: string | null;
  loading: boolean;
  fetchedAt: number;
};

const INITIAL: ToolsState = { data: null, error: null, loading: false, fetchedAt: 0 };

let state: ToolsState = INITIAL;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function update(patch: Partial<ToolsState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const snapshot = () => state;

/** Ask for the tool list unless a fresh one is held (or a request is on its way); `force` asks anyway. */
function load(force = false): Promise<void> {
  if (inflight) return inflight;
  if (!force && state.data && Date.now() - state.fetchedAt < WORKFLOW_TOOLS_STALE_MS) return Promise.resolve();
  update({ loading: true, error: null });
  inflight = getWorkflowTools()
    .then((data) => update({ data, loading: false, error: null, fetchedAt: Date.now() }))
    .catch((err: unknown) =>
      update({ loading: false, error: err instanceof Error ? err.message : "The tools could not be loaded." }),
    )
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Forget the held tool list (a new session, a test). */
export function resetWorkflowTools() {
  inflight = null;
  state = INITIAL;
  for (const listener of listeners) listener();
}

export function useWorkflowTools(enabled = true): WorkflowToolsState {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    // A reader arriving after a failure asks again (once: the request is shared).
    if (enabled) void load(Boolean(state.error));
  }, [enabled]);
  const retry = useCallback(() => void load(true), []);
  return {
    data: current.data,
    // Before the first answer, "loading" — never a flash of "not found".
    isLoading: enabled && (current.loading || (!current.data && !current.error)),
    error: current.error,
    retry,
  };
}
