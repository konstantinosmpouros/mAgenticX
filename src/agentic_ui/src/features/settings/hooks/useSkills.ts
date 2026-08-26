import { useCallback, useEffect, useRef, useState } from "react";
import {
  addGlobalSkillToPool,
  createCustomSkill,
  disableUserAgentSkill,
  enableUserAgentSkill,
  getMySkillDetail,
  getMySkills,
  getUserAgentSkills,
  removeSkillFromPool,
} from "@/shared/lib/api";
import { toastError } from "@/shared/lib/toast";
import type {
  CustomSkillCreatePayload,
  UserAgentSkillSelection,
  UserSkill,
  UserSkillDetail,
} from "@/shared/lib/types";

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
type ToastFn = (opts: {
  title: string;
  description?: string;
  variant?: string;
  duration?: number;
}) => void;

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
  /** False until the session has been confirmed against the cookies. */
  authResolved?: boolean;
};

export function useSkills(ctx: SkillsCtx): SkillsHandlers {
  const { userId, toast, initialPool, authResolved } = ctx;
  const [selections, setSelections] = useState<UserAgentSkillSelection>({});
  const [loadingAgents, setLoadingAgents] = useState<Set<string>>(new Set());
  const [togglingKeys, setTogglingKeys] = useState<Set<string>>(new Set());
  const loadedRef = useRef<Set<string>>(new Set());

  // Mirrors of the two pieces of state that concurrent toggles race over.
  // React state is only visible to the next render, so two toggles fired in the
  // same tick — or a toggle landing while a fetch is in flight — would each read
  // the same stale value and the last write would erase the other. These refs are
  // updated synchronously at the point of mutation, so every read sees the latest
  // intent regardless of render timing.
  const selectionsRef = useRef<UserAgentSkillSelection>({});
  const togglingKeysRef = useRef<Set<string>>(new Set());

  /** Apply a change to one agent's enabled-set, keeping ref and state in lockstep. */
  const applySelection = useCallback((agentId: string, next: (current: string[]) => string[]) => {
    const current = selectionsRef.current[agentId] ?? [];
    selectionsRef.current = { ...selectionsRef.current, [agentId]: next(current) };
    setSelections(selectionsRef.current);
  }, []);

  const markToggling = useCallback((key: string, active: boolean) => {
    const next = new Set(togglingKeysRef.current);
    if (active) next.add(key);
    else next.delete(key);
    togglingKeysRef.current = next;
    setTogglingKeys(next);
  }, []);

  const [mySkills, setMySkills] = useState<UserSkill[]>(initialPool ?? []);
  const [loadingMySkills, setLoadingMySkills] = useState<boolean>(false);
  const [skillDetail, setSkillDetail] = useState<Record<string, UserSkillDetail>>({});
  const [loadingDetailKeys, setLoadingDetailKeys] = useState<Set<string>>(new Set());

  useEffect(() => {
    // New user (login/logout) — flush every per-user piece of state.
    // The mirrors must be cleared alongside their state, or a stale enabled-set
    // from the previous account would survive the switch.
    selectionsRef.current = {};
    togglingKeysRef.current = new Set();
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
  const ensureLoaded = useCallback(
    async (agentId: string) => {
      if (!userId || !agentId) return;
      if (loadedRef.current.has(agentId)) return;
      setLoadingAgents((prev) => {
        const next = new Set(prev);
        next.add(agentId);
        return next;
      });
      try {
        const fetched = await getUserAgentSkills(userId, agentId);
        // A toggle started while this GET was in flight has already written the
        // newer intent locally; committing the server's pre-toggle list here
        // would silently revert the user's click.
        const hasPendingToggle = [...togglingKeysRef.current].some((pending) =>
          pending.startsWith(`${agentId}::`),
        );
        if (!hasPendingToggle) {
          applySelection(agentId, () => fetched);
        }
        loadedRef.current.add(agentId);
      } catch (error) {
        toastError(toast, "Could not load skills", error, {
          description: error instanceof Error ? error.message : "Please try again.",
        });
      } finally {
        setLoadingAgents((prev) => {
          const next = new Set(prev);
          next.delete(agentId);
          return next;
        });
      }
    },
    [userId, toast, applySelection],
  );

  const isLoading = useCallback((agentId: string) => loadingAgents.has(agentId), [loadingAgents]);

  const isToggling = useCallback(
    (agentId: string, skillName: string) => togglingKeys.has(`${agentId}::${skillName}`),
    [togglingKeys],
  );

  const toggleSkill = useCallback(
    async (agentId: string, skillName: string) => {
      if (!userId) {
        toast({
          title: "Authentication required",
          description: "Please sign in again.",
          variant: "destructive",
        });
        return;
      }
      const key = `${agentId}::${skillName}`;
      if (togglingKeysRef.current.has(key)) return;

      // Read the live value, not the render closure's snapshot: a toggle of a
      // *different* skill on the same agent may already be in flight.
      const wasEnabled = (selectionsRef.current[agentId] ?? []).includes(skillName);

      applySelection(agentId, (current) =>
        wasEnabled ? current.filter((name) => name !== skillName) : [...current, skillName].sort(),
      );
      markToggling(key, true);

      try {
        if (wasEnabled) {
          await disableUserAgentSkill(userId, agentId, skillName);
        } else {
          await enableUserAgentSkill(userId, agentId, skillName);
        }
      } catch (error) {
        // Undo only THIS skill, against whatever the list holds now. Restoring a
        // snapshot taken before the request would wipe out any other toggle that
        // succeeded while this one was in flight.
        applySelection(agentId, (current) =>
          wasEnabled
            ? current.includes(skillName)
              ? current
              : [...current, skillName].sort()
            : current.filter((name) => name !== skillName),
        );
        toastError(
          toast,
          wasEnabled ? "Could not disable skill" : "Could not enable skill",
          error,
          {
            description: error instanceof Error ? error.message : "Please try again.",
          },
        );
      } finally {
        markToggling(key, false);
      }
    },
    [userId, toast, applySelection, markToggling],
  );

  const pruneSkillFromAssignments = useCallback((skillName: string) => {
    // Mirror the server-side cascade — when a skill is removed from the
    // user's pool, every per-agent assignment for that skill is also gone.
    const next: UserAgentSkillSelection = {};
    for (const [agentId, names] of Object.entries(selectionsRef.current)) {
      next[agentId] = names.filter((name) => name !== skillName);
    }
    selectionsRef.current = next;
    setSelections(next);
  }, []);

  // -----------------------------------------------------------------
  // User pool
  // -----------------------------------------------------------------
  const refreshMySkills = useCallback(
    async (opts?: { bypassRedis?: boolean }) => {
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
        toastError(toast, "Could not refresh your skills", error, {
          description: error instanceof Error ? error.message : "Please try again.",
        });
      } finally {
        setLoadingMySkills(false);
      }
    },
    [userId, toast],
  );

  // Authoritative pool load: whenever the user resolves, refetch from the
  // server. The initialPool seed (in the userId reset effect above) is only an
  // instant-paint accelerator from the UI snapshot — this is the source of
  // truth. Without it the hook would keep the snapshot seed (often empty) until
  // the user manually hit Refresh.
  useEffect(() => {
    if (!userId) return;
    // Wait for the session to be confirmed against the cookies. The store seeds
    // `userId` from localStorage for fast paint, and that can name a DIFFERENT
    // user than the cookies do — the server-side OIDC callback swaps the cookies
    // without being able to touch localStorage. Fetching first produced
    // "Token does not grant access to this user" from validate_userId.
    if (authResolved === false) return;
    void refreshMySkills();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, authResolved]);

  const addGlobalToPool = useCallback(
    async (skillName: string) => {
      if (!userId) {
        toast({
          title: "Authentication required",
          description: "Please sign in again.",
          variant: "destructive",
        });
        return;
      }
      if (mySkills.some((s) => s.name === skillName)) return; // already in pool
      try {
        await addGlobalSkillToPool(userId, skillName);
        // Refetch so the new entry carries the canonical description/source_path
        // from the backend rather than something the frontend guessed.
        await refreshMySkills({ bypassRedis: true });
      } catch (error) {
        toastError(toast, "Could not add skill to your pool", error, {
          description: error instanceof Error ? error.message : "Please try again.",
        });
      }
    },
    [userId, mySkills, refreshMySkills, toast],
  );

  const createCustomInPool = useCallback(
    async (payload: CustomSkillCreatePayload): Promise<UserSkill | null> => {
      if (!userId) {
        toast({
          title: "Authentication required",
          description: "Please sign in again.",
          variant: "destructive",
        });
        return null;
      }
      try {
        const created = await createCustomSkill(userId, payload);
        setMySkills((prev) => [...prev, created]);
        return created;
      } catch (error) {
        toastError(toast, "Could not create the skill", error, {
          description: error instanceof Error ? error.message : "Please try again.",
        });
        return null;
      }
    },
    [userId, toast],
  );

  const removeFromPool = useCallback(
    async (skillName: string) => {
      if (!userId) {
        toast({
          title: "Authentication required",
          description: "Please sign in again.",
          variant: "destructive",
        });
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
        toastError(toast, "Could not remove the skill", error, {
          description: error instanceof Error ? error.message : "Please try again.",
        });
      }
    },
    [userId, mySkills, pruneSkillFromAssignments, toast],
  );

  // -----------------------------------------------------------------
  // Per-skill SKILL.md body cache
  // -----------------------------------------------------------------
  const loadingSkillDetail = useCallback(
    (skillName: string) => loadingDetailKeys.has(skillName),
    [loadingDetailKeys],
  );

  const ensureSkillDetail = useCallback(
    async (skillName: string) => {
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
        toastError(toast, "Could not load skill content", error, {
          description: error instanceof Error ? error.message : "Please try again.",
        });
      } finally {
        setLoadingDetailKeys((prev) => {
          const next = new Set(prev);
          next.delete(skillName);
          return next;
        });
      }
    },
    [userId, skillDetail, loadingDetailKeys, toast],
  );

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
