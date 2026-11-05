import { useCallback, useEffect, useRef, useState } from "react";

import { validateWorkflow } from "@/shared/lib/api";
import type { WorkflowBuilderIssue, WorkflowSpec, WorkflowValidationIssue } from "@/shared/lib/types";
import { normalizeSpec } from "@/features/workflows/lib/builder/draft";
import { placeServerIssues } from "@/features/workflows/lib/builder/validate";

/** Quiet time after the last edit before the server checks the draft. */
export const VALIDATE_DEBOUNCE_MS = 800;

/**
 * The server's verdict on the draft (`POST /v1/workflows/validate`), asked
 * ~800 ms after the last edit and on demand (`validateNow`, before a save).
 * Each answer is placed against the spec it was asked about, and only the
 * newest answer lands. A failed request leaves the previous issues and is not
 * an issue itself: the save says what is wrong if it is refused. `adopt`
 * places issues the save itself came back with (a 422).
 */
export function useWorkflowValidation(spec: WorkflowSpec, enabled = true) {
  const [issues, setIssues] = useState<WorkflowBuilderIssue[]>([]);
  const [checking, setChecking] = useState(false);
  const generation = useRef(0);

  const run = useCallback(async (target: WorkflowSpec): Promise<WorkflowBuilderIssue[] | null> => {
    const mine = ++generation.current;
    setChecking(true);
    try {
      const sent = normalizeSpec(target);
      const result = await validateWorkflow(sent);
      const placed = placeServerIssues(result.errors, sent);
      if (mine === generation.current) setIssues(placed);
      return placed;
    } catch {
      return null;
    } finally {
      if (mine === generation.current) setChecking(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const timer = window.setTimeout(() => void run(spec), VALIDATE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [spec, enabled, run]);

  // Leaving drops any answer still on its way.
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );

  const validateNow = useCallback(() => run(spec), [run, spec]);

  const adopt = useCallback((errors: readonly WorkflowValidationIssue[], checked: WorkflowSpec) => {
    generation.current += 1;
    const placed = placeServerIssues(errors, normalizeSpec(checked));
    setIssues(placed);
    setChecking(false);
    return placed;
  }, []);

  return { issues, checking, validateNow, adopt };
}
