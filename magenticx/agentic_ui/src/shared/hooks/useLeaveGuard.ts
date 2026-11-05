import { useCallback, useEffect, useRef, useState } from "react";

import { setLeaveGuard } from "@/shared/lib/leaveGuard";

/**
 * Hold the user back from leaving a page with unsaved changes.
 *
 * Two ways out are covered: the browser's (reload, close the tab) through
 * `beforeunload`, which only lets the browser show its own prompt; and the
 * app's own navigation — the sidebar and the page's Back and Cancel — through
 * the shared leave guard, which this page answers with its own dialog.
 *
 * `confirmLeave(proceed)` is for the page's own buttons; `pending` is the move
 * waiting on the dialog (render a dialog when it is set; `leave` goes ahead,
 * `stay` drops it).
 */
export function useLeaveGuard(dirty: boolean) {
  const [pending, setPending] = useState<(() => void) | null>(null);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Older browsers show the prompt only when a value is set.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  useEffect(
    () =>
      setLeaveGuard((proceed) => {
        if (!dirtyRef.current) return false;
        setPending(() => proceed);
        return true;
      }),
    [],
  );

  const confirmLeave = useCallback((proceed: () => void) => {
    if (!dirtyRef.current) proceed();
    else setPending(() => proceed);
  }, []);

  const leave = useCallback(() => {
    const proceed = pending;
    setPending(null);
    // The draft is being abandoned: nothing should hold the next move back.
    dirtyRef.current = false;
    proceed?.();
  }, [pending]);

  const stay = useCallback(() => setPending(null), []);

  return { confirmLeave, pending: pending !== null, leave, stay };
}
