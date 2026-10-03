import { useCallback, useEffect, useRef, useState } from "react";

import { searchCatalogue } from "@/shared/lib/api";
import { CATALOG_SEARCH_DEBOUNCE_MS } from "@/shared/lib/consts";
import type { CatalogueSkill } from "@/shared/lib/types";

// The Skills tab's catalogue search (plan 30). The catalogue is a server-side
// full-text index of the allowlisted remote sources — there is no list to
// download and filter — so every query is a request:
//
// - keystrokes are debounced, and a newer query aborts the one in flight, so a
//   slow response can never overwrite a newer one;
// - an empty query is the alphabetical browse page, and its `total` is the
//   size of the whole catalogue, remembered for the hub row's count;
// - failures surface as an inline error with a retry, never as a toast per
//   keystroke.

export type CatalogueSearchState = {
  results: CatalogueSkill[];
  /** Matches for the current query (all of them, not just this page). */
  total: number;
  /** Size of the whole catalogue, from the last empty-query response. */
  catalogueSize: number | null;
  loading: boolean;
  error: string | null;
  /** False when the server has remote sources switched off. */
  remoteEnabled: boolean;
  retry: () => void;
};

export function useCatalogueSearch(query: string, limit: number): CatalogueSearchState {
  const [results, setResults] = useState<CatalogueSkill[]>([]);
  const [total, setTotal] = useState(0);
  const [catalogueSize, setCatalogueSize] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [remoteEnabled, setRemoteEnabled] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);

  const trimmed = query.trim();

  useEffect(() => {
    setLoading(true);
    const timer = window.setTimeout(() => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      searchCatalogue(trimmed, { limit, signal: controller.signal })
        .then((page) => {
          if (controller.signal.aborted) return;
          setResults(page.results);
          setTotal(page.total);
          setRemoteEnabled(page.remoteEnabled);
          if (!trimmed) setCatalogueSize(page.total);
          setError(null);
          setLoading(false);
        })
        .catch((err: unknown) => {
          // An aborted request was superseded by a newer query — not an error.
          if (controller.signal.aborted) return;
          setError(err instanceof Error ? err.message : "Could not search the catalogue.");
          setLoading(false);
        });
    }, CATALOG_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [trimmed, limit, attempt]);

  // Cancel whatever is in flight when the tab unmounts.
  useEffect(() => () => controllerRef.current?.abort(), []);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return { results, total, catalogueSize, loading, error, remoteEnabled, retry };
}
