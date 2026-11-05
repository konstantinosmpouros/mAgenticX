import { useCallback, useMemo, useRef, useState } from "react";

import type { WorkflowDraftAction, WorkflowSpec } from "@/shared/lib/types";
import { draftReducer, sameSpec } from "@/features/workflows/lib/builder/draft";

/** How many steps Undo goes back. */
const HISTORY_LIMIT = 100;
/** Edits to the same field closer together than this undo as one (typing a word). */
const COALESCE_MS = 700;

type History = { past: WorkflowSpec[]; present: WorkflowSpec; future: WorkflowSpec[] };

/**
 * The builder's draft: the spec as edited, through `draftReducer`, with Undo
 * and Redo and whether it differs from what is saved.
 *
 * `dispatch(action, { coalesce })`: edits that pass the same `coalesce` key
 * within a moment of each other (each keystroke in one field) are one undo
 * step. `markSaved(spec)` makes `spec` the saved baseline (after a save);
 * `reset(spec)` starts over from it, history cleared; `restore(spec)` puts an
 * autosaved draft on as one undoable edit.
 */
export function useWorkflowDraft(initial: WorkflowSpec, saved: WorkflowSpec | null) {
  const [history, setHistory] = useState<History>({ past: [], present: initial, future: [] });
  const [baseline, setBaseline] = useState<WorkflowSpec | null>(saved);
  const last = useRef<{ key: string; at: number } | null>(null);

  const dispatch = useCallback((action: WorkflowDraftAction, options: { coalesce?: string } = {}) => {
    const now = Date.now();
    const previous = last.current;
    const merge = Boolean(options.coalesce && previous && previous.key === options.coalesce && now - previous.at < COALESCE_MS);
    last.current = options.coalesce ? { key: options.coalesce, at: now } : null;
    setHistory((current) => {
      const next = draftReducer(current.present, action);
      if (next === current.present) return current;
      return {
        past: merge ? current.past : [...current.past, current.present].slice(-HISTORY_LIMIT),
        present: next,
        future: [],
      };
    });
  }, []);

  const undo = useCallback(() => {
    last.current = null;
    setHistory((current) => {
      const previous = current.past[current.past.length - 1];
      if (!previous) return current;
      return { past: current.past.slice(0, -1), present: previous, future: [current.present, ...current.future] };
    });
  }, []);

  const redo = useCallback(() => {
    last.current = null;
    setHistory((current) => {
      const [next, ...rest] = current.future;
      if (!next) return current;
      return { past: [...current.past, current.present], present: next, future: rest };
    });
  }, []);

  const markSaved = useCallback((spec: WorkflowSpec) => setBaseline(spec), []);

  const reset = useCallback((spec: WorkflowSpec) => {
    last.current = null;
    setHistory({ past: [], present: spec, future: [] });
    setBaseline(spec);
  }, []);

  /**
   * Put a restored draft on the canvas as an edit: the saved baseline stays
   * (so it is unsaved work, and Save makes it a version), and Undo goes back
   * to what the builder opened with.
   */
  const restore = useCallback((spec: WorkflowSpec) => {
    last.current = null;
    setHistory((current) =>
      sameSpec(spec, current.present)
        ? current
        : { past: [...current.past, current.present].slice(-HISTORY_LIMIT), present: spec, future: [] },
    );
  }, []);

  const spec = history.present;
  // A new workflow is unsaved work from its first change; never-saved and unchanged is not.
  const dirty = useMemo(
    () => (baseline ? !sameSpec(spec, baseline) : !sameSpec(spec, initial)),
    [spec, baseline, initial],
  );

  return {
    spec,
    dispatch,
    undo,
    redo,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    dirty,
    markSaved,
    reset,
    restore,
  };
}
