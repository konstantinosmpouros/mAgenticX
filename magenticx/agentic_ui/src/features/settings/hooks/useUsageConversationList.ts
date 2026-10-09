import { useCallback, useEffect, useRef, useState } from "react";

import { getUsageConversations } from "@/shared/lib/api";
import type { UsageConversationSort, UsageRange } from "@/shared/lib/api";
import type { UsageConversationPage, UsageConversationRow } from "@/shared/lib/types";

const PAGE_SIZE = 25;

export type UsageConversationFilters = {
  sort: UsageConversationSort;
  range: UsageRange;
  agentId: string | null;
  query: string;
  /** Bumped by the panel's refresh button: a new value reloads from page one. */
  refreshToken: number;
};

/**
 * useUsageConversationList — the Usage tab's conversation list, a page at a time.
 *
 * Filters (sort, range, agent, search) define the list; changing any of them
 * starts over from the first page. `loadMore` follows the bridge's opaque
 * keyset cursor, so pages never repeat or skip a row even while new answers
 * land. Responses for an outdated filter set are dropped.
 */
export function useUsageConversationList(userId: string | null, filters: UsageConversationFilters) {
  const [items, setItems] = useState<UsageConversationRow[]>([]);
  const [privateTotals, setPrivateTotals] = useState<UsageConversationPage["private"]>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const { sort, range, agentId, query, refreshToken } = filters;

  const fetchPage = useCallback(
    (after: string | null) =>
      getUsageConversations(userId ?? "", {
        sort,
        range,
        agentId,
        q: query.trim() || null,
        cursor: after,
        limit: PAGE_SIZE,
      }),
    // refreshToken is not read; it is here so a refresh rebuilds this and reloads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [userId, sort, range, agentId, query, refreshToken],
  );

  const reload = useCallback(async () => {
    if (!userId) return;
    const request = ++requestRef.current;
    setLoading(true);
    setError(null);
    try {
      const page = await fetchPage(null);
      if (request !== requestRef.current) return;
      setItems(page.items);
      setPrivateTotals(page.private);
      setCursor(page.nextCursor);
      setLoaded(true);
    } catch (err) {
      if (request === requestRef.current) setError(err instanceof Error ? err.message : "Failed to load conversations");
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [userId, fetchPage]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    const request = requestRef.current;
    setLoadingMore(true);
    try {
      const page = await fetchPage(cursor);
      if (request !== requestRef.current) return;
      setItems((previous) => [...previous, ...page.items]);
      setCursor(page.nextCursor);
    } catch (err) {
      if (request === requestRef.current) setError(err instanceof Error ? err.message : "Failed to load more");
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, fetchPage]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return {
    items,
    privateTotals,
    hasMore: cursor !== null,
    loaded,
    loading,
    loadingMore,
    error,
    reload: () => void reload(),
    loadMore: () => void loadMore(),
  };
}
