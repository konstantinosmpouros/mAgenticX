import { useCallback, useEffect, useState } from "react";

import { getAccountDeletionStatus, requestAccountDeletion } from "@/shared/lib/api";
import { clearSession } from "@/shared/lib/authStorage";
import type { AccountDeletionStatus } from "@/shared/lib/types";
import { loginUrlAfterDeletion } from "@/features/settings/lib/accountDeletion";

// Data controls → "Delete account" (plan 32).
//
// Reads the deletion status (is a fresh sign-in needed, what to type back) and
// submits the request. A successful request has already signed every device
// out on the server, this one included, so the hook leaves the app for the
// login page, which explains what happens next.

export type AccountDeletionState = {
  status: AccountDeletionStatus | null;
  loading: boolean;
  submitting: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  request: (confirm: string) => Promise<void>;
};

export function useAccountDeletion(userId: string | null | undefined): AccountDeletionState {
  const [status, setStatus] = useState<AccountDeletionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  // Kept apart so re-reading the status after a refused request cannot wipe
  // the reason it was refused.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    try {
      setStatus(await getAccountDeletionStatus(userId));
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load the account status.");
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const request = useCallback(
    async (confirm: string) => {
      if (!userId || submitting) return;
      setSubmitting(true);
      setRequestError(null);
      try {
        const result = await requestAccountDeletion(userId, confirm);
        // The server already ended this session; drop the local copy too.
        clearSession();
        window.location.assign(loginUrlAfterDeletion(result.scheduledFor));
      } catch (err) {
        setRequestError(err instanceof Error ? err.message : "Could not delete the account.");
        setSubmitting(false);
        // A refused request may mean the sign-in went stale meanwhile.
        void refresh();
      }
    },
    [userId, submitting, refresh],
  );

  return { status, loading, submitting, error: requestError ?? loadError, refresh, request };
}
