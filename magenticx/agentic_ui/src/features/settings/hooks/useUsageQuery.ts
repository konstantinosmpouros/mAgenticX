import { useCallback, useEffect, useRef, useState } from "react";

/**
 * useUsageQuery — load one Usage-tab page's data, keyed by what it shows.
 *
 * The drill-down pages (one conversation, the agent list, one agent) each fetch
 * a single payload whose identity is a string key (`agent:<id>:30d`). A new key
 * fetches anew and never shows the previous key's data, so moving from one
 * agent to another can't flash the wrong numbers. A response that arrives after
 * the key changed is dropped, which also makes a fast back-and-forward safe.
 *
 * `key === null` means "nothing to load" (no user yet).
 */
export function useUsageQuery<T>(key: string | null, fetcher: () => Promise<T>) {
  const [state, setState] = useState<{ key: string | null; data: T | null; error: string | null }>({
    key: null,
    data: null,
    error: null,
  });
  const [loading, setLoading] = useState(false);
  // The latest fetcher, so callers can pass an inline closure without
  // re-triggering the effect on every render; the key alone decides when to load.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    if (!key) return;
    const request = ++requestRef.current;
    setLoading(true);
    try {
      const data = await fetcherRef.current();
      if (request === requestRef.current) setState({ key, data, error: null });
    } catch (err) {
      if (request === requestRef.current) {
        setState({ key, data: null, error: err instanceof Error ? err.message : "Failed to load usage" });
      }
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [key]);

  useEffect(() => {
    void load();
  }, [load]);

  const current = state.key === key;
  return {
    data: current ? state.data : null,
    error: current ? state.error : null,
    loading,
    refresh: () => void load(),
  };
}
