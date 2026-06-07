import { useCallback, useEffect, useRef, useState } from 'react';
import {
  disableUserAgentSkill,
  enableUserAgentSkill,
  getUserAgentSkills,
} from '@/lib/api';
import type { UserAgentSkillSelection } from '@/lib/types';

// Per-(user, agent) skill selection — the on-disk filesystem under
// <user_id>/<agent_slug>/skills/ on the agents service is the source of
// truth; the bridge proxies + Redis-caches reads, mutations always
// invalidate the cache. This hook owns the in-memory mirror used by the
// ProfilePanel "Manage per agent" UI.
//
// Selections are loaded lazily per agent (the user expands a card → fetch)
// rather than eagerly for every deep agent at login. The selection set
// changes only via user toggles, so we don't need an "always refetch"
// pattern like skills/tools/agents lists.
type ToastFn = (opts: { title: string; description?: string; variant?: string; duration?: number }) => void;

export type SkillsHandlers = {
  selections: UserAgentSkillSelection;
  isLoading: (agentId: string) => boolean;
  ensureLoaded: (agentId: string) => Promise<void>;
  toggleSkill: (agentId: string, skillName: string) => Promise<void>;
  isToggling: (agentId: string, skillName: string) => boolean;
};

type SkillsCtx = {
  userId: string | null;
  toast: ToastFn;
};

export function useSkills(ctx: SkillsCtx): SkillsHandlers {
  const { userId, toast } = ctx;
  const [selections, setSelections] = useState<UserAgentSkillSelection>({});
  const [loadingAgents, setLoadingAgents] = useState<Set<string>>(new Set());
  const [togglingKeys, setTogglingKeys] = useState<Set<string>>(new Set());
  // Track which (user, agent) pairs we've already loaded so re-mounting the
  // ProfilePanel doesn't refetch needlessly. Resets on user change.
  const loadedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    // New user (login/logout) — flush any prior state.
    setSelections({});
    setLoadingAgents(new Set());
    setTogglingKeys(new Set());
    loadedRef.current = new Set();
  }, [userId]);

  const ensureLoaded = useCallback(async (agentId: string) => {
    if (!userId || !agentId) return;
    if (loadedRef.current.has(agentId)) return;
    setLoadingAgents((prev) => {
      const next = new Set(prev);
      next.add(agentId);
      return next;
    });
    try {
      const fetched = await getUserAgentSkills(userId, agentId);
      setSelections((prev) => ({ ...prev, [agentId]: fetched }));
      loadedRef.current.add(agentId);
    } catch (error) {
      toast({
        title: 'Could not load skills',
        description: error instanceof Error ? error.message : 'Please try again.',
        variant: 'destructive',
      });
    } finally {
      setLoadingAgents((prev) => {
        const next = new Set(prev);
        next.delete(agentId);
        return next;
      });
    }
  }, [userId, toast]);

  const isLoading = useCallback(
    (agentId: string) => loadingAgents.has(agentId),
    [loadingAgents],
  );

  const isToggling = useCallback(
    (agentId: string, skillName: string) => togglingKeys.has(`${agentId}::${skillName}`),
    [togglingKeys],
  );

  const toggleSkill = useCallback(async (agentId: string, skillName: string) => {
    if (!userId) {
      toast({ title: 'Authentication required', description: 'Please sign in again.', variant: 'destructive' });
      return;
    }
    const key = `${agentId}::${skillName}`;
    if (togglingKeys.has(key)) return;

    const current = selections[agentId] ?? [];
    const isCurrentlyEnabled = current.includes(skillName);
    const optimistic = isCurrentlyEnabled
      ? current.filter((name) => name !== skillName)
      : [...current, skillName].sort();

    setSelections((prev) => ({ ...prev, [agentId]: optimistic }));
    setTogglingKeys((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });

    try {
      if (isCurrentlyEnabled) {
        await disableUserAgentSkill(userId, agentId, skillName);
      } else {
        await enableUserAgentSkill(userId, agentId, skillName);
      }
    } catch (error) {
      // Revert to the pre-toggle state on failure so the UI never claims
      // the mutation landed when the backend rejected it.
      setSelections((prev) => ({ ...prev, [agentId]: current }));
      toast({
        title: isCurrentlyEnabled ? 'Could not disable skill' : 'Could not enable skill',
        description: error instanceof Error ? error.message : 'Please try again.',
        variant: 'destructive',
      });
    } finally {
      setTogglingKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }, [userId, selections, togglingKeys, toast]);

  return { selections, isLoading, ensureLoaded, toggleSkill, isToggling };
}
