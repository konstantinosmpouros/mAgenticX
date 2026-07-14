import { useCallback, useEffect, useRef, useState } from "react";

import { getUsageSummary } from "@/shared/lib/api";
import type { UsageSummary } from "@/shared/lib/types";

// Refetch when the Usage tab is re-activated and the cached rollup is older
// than this — fresh enough to feel live, without hammering the aggregate
// endpoint on every tab switch.
const STALE_AFTER_MS = 60_000;

/**
 * useUsageSummary — lazy loader for the Settings → Usage rollup.
 *
 * Fetches the first time `active` turns true (the Usage tab opens), caches the
 * result across tab switches while the panel stays mounted, silently refetches
 * when re-activated stale, and exposes a manual `refresh`. Resets whenever the
 * user changes so one account's numbers can never bleed into another's.
 */
export function useUsageSummary(userId: string | null | undefined, active: boolean) {
    const [summary, setSummary] = useState<UsageSummary | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const lastFetchedAtRef = useRef<number | null>(null);
    const inFlightRef = useRef(false);

    const load = useCallback(
        async (force: boolean) => {
            if (!userId || inFlightRef.current) return;
            const fetchedAt = lastFetchedAtRef.current;
            if (!force && fetchedAt !== null && Date.now() - fetchedAt < STALE_AFTER_MS) return;
            inFlightRef.current = true;
            setLoading(true);
            setError(null);
            try {
                const next = await getUsageSummary(userId);
                setSummary(next);
                lastFetchedAtRef.current = Date.now();
            } catch (err) {
                setError(err instanceof Error ? err.message : "Failed to load usage");
            } finally {
                inFlightRef.current = false;
                setLoading(false);
            }
        },
        [userId]
    );

    // Drop the cache on account switch — the next activation refetches.
    useEffect(() => {
        setSummary(null);
        setError(null);
        lastFetchedAtRef.current = null;
    }, [userId]);

    useEffect(() => {
        if (active) void load(false);
    }, [active, load]);

    return { summary, loading, error, refresh: () => void load(true) };
}
