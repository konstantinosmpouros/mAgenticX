import { useCallback, useState } from "react";

import { cancelAccountDeletion, refreshSession } from "@/shared/lib/api";

// The pending-deletion screen's one action that changes anything: cancel.
//
// Cancelling clears the request on the server, but the session in this browser
// still carries the "pending deletion" marker until it is re-minted — so the
// session is refreshed (the server drops the marker on refresh) and the page
// starts over, loading the workspace as it normally would.

export function usePendingDeletion(userId: string | null | undefined) {
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cancel = useCallback(async () => {
    if (!userId || cancelling) return;
    setCancelling(true);
    setError(null);
    try {
      await cancelAccountDeletion(userId);
      await refreshSession(false);
      window.location.assign("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not cancel the deletion.");
      setCancelling(false);
    }
  }, [userId, cancelling]);

  return { cancel, cancelling, error };
}
