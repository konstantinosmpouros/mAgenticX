import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";

import { useWorkspaceStore } from "@/shared/stores/workspaceStore";

// The return leg of "confirm it's you" (plan 32).
//
// Re-authenticating is a full-page trip through Microsoft that lands back on
// `/?reauth=done` (or `failed`). This picks that up once the session is known,
// removes it from the URL so a reload does not replay it, reopens Settings on
// Data controls, and leaves the outcome in the store for the delete dialog.

export function useAccountDeletionReauthReturn({
  enabled,
  openProfilePanel,
}: {
  enabled: boolean;
  openProfilePanel: (tab: string) => void;
}): void {
  const [params, setParams] = useSearchParams();
  const setAccountDeletionReauth = useWorkspaceStore((s) => s.setAccountDeletionReauth);
  const outcome = params.get("reauth");

  useEffect(() => {
    if (!enabled || (outcome !== "done" && outcome !== "failed")) return;
    const next = new URLSearchParams(params);
    next.delete("reauth");
    next.delete("reason");
    setParams(next, { replace: true });
    setAccountDeletionReauth(outcome);
    openProfilePanel("data-controls");
  }, [enabled, outcome, params, setParams, setAccountDeletionReauth, openProfilePanel]);
}
