import { useCallback, useEffect, useRef, useState } from 'react';
import {
  addGlobalSkillToPool,
  createCustomSkill,
  disableUserAgentSkill,
  enableUserAgentSkill,
  getMySkillDetail,
  getMySkills,
  getUserAgentSkills,
  removeSkillFromPool,
} from '@/shared/lib/api';
import type {
  CustomSkillCreatePayload,
  UserAgentSkillSelection,
  UserSkill,
  UserSkillDetail,
} from '@/shared/lib/types';

// Owns three pieces of per-user skill state for the ProfilePanel "Skills" tab:
//
// 1. The user's personal skill pool (My skills view) — fetched at session
//    bootstrap, mutated by add-global / create-custom / remove handlers.
// 2. Per-(user, agent) skill assignments (Manage per agent view) — loaded
//    lazily per agent on card expand. Source of truth is the on-disk
//    filesystem on the agents service; the bridge proxies + Redis-caches.
// 3. Per-skill detail content cache — populated on demand when the user
//    expands a card in My skills (avoids re-fetching the full SKILL.md
//    body on every open).
//
// The hook does not own the global catalog (``availableSkills``); that lives
// in page-level state and is fetched alongside ``getAgents`` / ``getTools``
// during the auth-rehydrate flow.
type ToastFn = (opts: { title: string; description?: string; variant?: string; duration?: number }) => void;

export type SkillsHandlers = {
  // Per-(user, agent) selection
  selections: UserAgentSkillSelection;
  isLoading: (agentId: string) => boolean;
  ensureLoaded: (agentId: string) => Promise<void>;
  toggleSkill: (agentId: string, skillName: string) => Promise<void>;
  isToggling: (agentId: string, skillName: string) => boolean;

  // User pool ("My skills")
  mySkills: UserSkill[];
  setMySkills: React.Dispatch<React.SetStateAction<UserSkill[]>>;
  loadingMySkills: boolean;
  refreshMySkills: (opts?: { bypassRedis?: boolean }) => Promise<void>;
  addGlobalToPool: (skillName: string) => Promise<void>;
  createCustomInPool: (payload: CustomSkillCreatePayload) => Promise<UserSkill | null>;
  removeFromPool: (skillName: string) => Promise<void>;

  // Per-skill SKILL.md body cache
  skillDetail: Record<string, UserSkillDetail>;
  loadingSkillDetail: (skillName: string) => boolean;
  ensureSkillDetail: (skillName: string) => Promise<void>;

  // Cascade hook for callers that need to mirror server-side cascade locally
  // (e.g. remove an assignment-cache entry when the underlying skill is
  // dropped from the pool).
  pruneSkillFromAssignments: (skillName: string) => void;
};

type SkillsCtx = {
  userId: string | null;
  toast: ToastFn;
  initialPool?: UserSkill[] | null;
};

export function useSkills(ctx: SkillsCtx): SkillsHandlers {
  const { userId, toast, initialPool } = ctx;
  const [selections, setSelections] = useState<UserAgentSkillSelection>({});
  const [loadingAgents, setLoadingAgents] = useState<Set<string>>(new Set());
  const [togglingKeys, setTogglingKeys] = useState<Set<string>>(new Set());
  const loadedRef = useRef<Set<string>>(new Set());

  const [mySkills, setMySkills] = useState<UserSkill[]>(initialPool ?? []);
  const [loadingMySkills, setLoadingMySkills] = useState<boolean>(false);
  const [skillDetail, setSkillDetail] = useState<Record<string, UserSkillDetail>>({});
  const [loadingDetailKeys, setLoadingDetailKeys] = useState<Set<string>>(new Set());

  useEffect(() => {
    // New user (login/logout) — flush every per-user piece of state.
    setSelections({});
    setLoadingAgents(new Set());
    setTogglingKeys(new Set());
    setMySkills(initialPool ?? []);
    setSkillDetail({});
    setLoadingDetailKeys(new Set());
    loadedRef.current = new Set();
    // initialPool is intentionally omitted from deps — we only want the seed
    // value at the moment userId changes, not on every parent re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  // -----------------------------------------------------------------
  // Per-(user, agent) selection
  // -----------------------------------------------------------------
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

  const pruneSkillFromAssignments = useCallback((skillName: string) => {
    // Mirror the server-side cascade — when a skill is removed from the
    // user's pool, every per-agent assignment for that skill is also gone.
    setSelections((prev) => {
      const next: UserAgentSkillSelection = {};
      for (const [agentId, names] of Object.entries(prev)) {
        next[agentId] = names.filter((name) => name !== skillName);
      }
      return next;
    });
  }, []);

  // -----------------------------------------------------------------
  // User pool
  // -----------------------------------------------------------------
  const refreshMySkills = useCallback(async (opts?: { bypassRedis?: boolean }) => {
    if (!userId) return;
    setLoadingMySkills(true);
    try {
      const fetched = await getMySkills(userId, opts);
      setMySkills(fetched);
    } catch (error) {
      // A 401 means the session ended (e.g. logged out while this background
      // refresh was in flight) — already handled by the global unauthorized
      // redirect, so don't surface a "try again" toast on the way out.
      if ((error as { status?: number })?.status === 401) return;
      toast({
        title: 'Could not refresh your skills',
        description: error instanceof Error ? error.message : 'Please try again.',
        variant: 'destructive',
      });
    } finally {
      setLoadingMySkills(false);
    }
  }, [userId, toast]);

  // Authoritative pool load: whenever the user resolves, refetch from the
  // server. The initialPool seed (in the userId reset effect above) is only an
  // instant-paint accelerator from the UI snapshot — this is the source of
  // truth. Without it the hook would keep the snapshot seed (often empty) until
  // the user manually hit Refresh.
  useEffect(() => {
    if (!userId) return;
    void refreshMySkills();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const addGlobalToPool = useCallback(async (skillName: string) => {
    if (!userId) {
      toast({ title: 'Authentication required', description: 'Please sign in again.', variant: 'destructive' });
      return;
    }
    if (mySkills.some((s) => s.name === skillName)) return; // already in pool
    try {
      await addGlobalSkillToPool(userId, skillName);
      // Refetch so the new entry carries the canonical description/source_path
      // from the backend rather than something the frontend guessed.
      await refreshMySkills({ bypassRedis: true });
    } catch (error) {
      toast({
        title: 'Could not add skill to your pool',
        description: error instanceof Error ? error.message : 'Please try again.',
        variant: 'destructive',
      });
    }
  }, [userId, mySkills, refreshMySkills, toast]);

  const createCustomInPool = useCallback(async (payload: CustomSkillCreatePayload): Promise<UserSkill | null> => {
    if (!userId) {
      toast({ title: 'Authentication required', description: 'Please sign in again.', variant: 'destructive' });
      return null;
    }
    try {
      const created = await createCustomSkill(userId, payload);
      setMySkills((prev) => [...prev, created]);
      return created;
    } catch (error) {
      toast({
        title: 'Could not create the skill',
        description: error instanceof Error ? error.message : 'Please try again.',
        variant: 'destructive',
      });
      return null;
    }
  }, [userId, toast]);

  const removeFromPool = useCallback(async (skillName: string) => {
    if (!userId) {
      toast({ title: 'Authentication required', description: 'Please sign in again.', variant: 'destructive' });
      return;
    }
    const prev = mySkills;
    setMySkills((curr) => curr.filter((s) => s.name !== skillName));
    pruneSkillFromAssignments(skillName);
    setSkillDetail((prevDetail) => {
      if (!(skillName in prevDetail)) return prevDetail;
      const { [skillName]: _gone, ...rest } = prevDetail;
      return rest;
    });
    try {
      await removeSkillFromPool(userId, skillName);
      // Drop our lazy-load memo so any per-agent card opened later refetches
      // and reflects the cascade.
      loadedRef.current = new Set();
    } catch (error) {
      setMySkills(prev);
      toast({
        title: 'Could not remove the skill',
        description: error instanceof Error ? error.message : 'Please try again.',
        variant: 'destructive',
      });
    }
  }, [userId, mySkills, pruneSkillFromAssignments, toast]);

  // -----------------------------------------------------------------
  // Per-skill SKILL.md body cache
  // -----------------------------------------------------------------
  const loadingSkillDetail = useCallback(
    (skillName: string) => loadingDetailKeys.has(skillName),
    [loadingDetailKeys],
  );

  const ensureSkillDetail = useCallback(async (skillName: string) => {
    if (!userId) return;
    if (skillDetail[skillName]) return;
    if (loadingDetailKeys.has(skillName)) return;
    setLoadingDetailKeys((prev) => {
      const next = new Set(prev);
      next.add(skillName);
      return next;
    });
    try {
      const detail = await getMySkillDetail(userId, skillName);
      setSkillDetail((prev) => ({ ...prev, [skillName]: detail }));
    } catch (error) {
      toast({
        title: 'Could not load skill content',
        description: error instanceof Error ? error.message : 'Please try again.',
        variant: 'destructive',
      });
    } finally {
      setLoadingDetailKeys((prev) => {
        const next = new Set(prev);
        next.delete(skillName);
        return next;
      });
    }
  }, [userId, skillDetail, loadingDetailKeys, toast]);

  return {
    selections,
    isLoading,
    ensureLoaded,
    toggleSkill,
    isToggling,
    mySkills,
    setMySkills,
    loadingMySkills,
    refreshMySkills,
    addGlobalToPool,
    createCustomInPool,
    removeFromPool,
    skillDetail,
    loadingSkillDetail,
    ensureSkillDetail,
    pruneSkillFromAssignments,
  };
}
