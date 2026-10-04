import { useCallback, useEffect, useState } from "react";

import { exportDownloadUrl, getExportStatus, requestExportToken } from "@/shared/lib/api";
import type { ExportStatus } from "@/shared/lib/types";

// Data controls → "Export data" (plan 27).
//
// The flow is two steps on purpose: a CSRF-protected POST mints a one-time,
// short-lived token, then the browser is pointed at the download URL so it
// saves the streamed zip straight to disk. Fetching the archive through
// JavaScript would hold the whole thing in browser memory.
//
// After a start, the status is re-read so the row shows the cooldown.

export type DataExportState = {
  status: ExportStatus | null;
  loading: boolean;
  /** Which export is being prepared, while its token is being minted. */
  preparing: "full" | "text" | null;
  error: string | null;
  start: (includeAttachments: boolean) => Promise<void>;
};

// How long to wait before re-reading the status: long enough for the download
// to have claimed the cooldown on the server.
const STATUS_REFRESH_MS = 2500;

// Cooldown re-check: a second past the server's time, never sooner than 5 s
// apart, and capped below setTimeout's 2^31 ms overflow (which fires at once).
const COOLDOWN_SLACK_MS = 1000;
const MIN_RECHECK_MS = 5000;
const MAX_RECHECK_MS = 60 * 60 * 1000;

export function useDataExport(userId: string | null | undefined): DataExportState {
  const [status, setStatus] = useState<ExportStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [preparing, setPreparing] = useState<"full" | "text" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!userId) return;
    try {
      setStatus(await getExportStatus(userId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load export status.");
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // While a cooldown runs, re-read the status once it ends so the options
  // re-enable without a reload. Keyed on the status object, not its timestamp,
  // so a refresh that still reports a cooldown (client clock ahead of the
  // server's) schedules the next check; the floor keeps that from spinning.
  useEffect(() => {
    if (!status?.availableAt) return;
    const wait = new Date(status.availableAt).getTime() - Date.now() + COOLDOWN_SLACK_MS;
    if (!Number.isFinite(wait)) return;
    const timer = window.setTimeout(
      () => void refresh(),
      Math.min(Math.max(wait, MIN_RECHECK_MS), MAX_RECHECK_MS),
    );
    return () => window.clearTimeout(timer);
  }, [status, refresh]);

  const start = useCallback(
    async (includeAttachments: boolean) => {
      if (!userId || preparing) return;
      setPreparing(includeAttachments ? "full" : "text");
      setError(null);
      try {
        const { token } = await requestExportToken(userId, includeAttachments);
        if (!token) throw new Error("The export could not be prepared. Please try again.");
        window.location.assign(exportDownloadUrl(userId, token));
        window.setTimeout(() => void refresh(), STATUS_REFRESH_MS);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not prepare the export.");
        void refresh();
      } finally {
        setPreparing(null);
      }
    },
    [userId, preparing, refresh],
  );

  return { status, loading, preparing, error, start };
}
