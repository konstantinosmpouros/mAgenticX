import { useCallback, useEffect, useState } from "react";

import {
  createMyAgent,
  deleteMyAgent,
  getMyAgentDetail,
  getMyAgents,
  updateMyAgent,
  validateMyAgent,
} from "@/shared/lib/api";
import { toastError } from "@/shared/lib/toast";
import type {
  Agent,
  CustomAgentDetail,
  CustomAgentValidation,
  CustomAgentWritePayload,
  MyAgent,
} from "@/shared/lib/types";

/**
 * The agents this user authored: load, create, edit, delete.
 *
 * Mirrors `useSkills` — a per-`userId` reset so nothing leaks across a
 * login/logout, an in-flight guard so double-clicks can't fire twice, and the
 * create/update paths adopting the canonical server row rather than a
 * frontend-guessed one (the id, icon and version are all assigned server-side).
 * Delete is optimistic with a rollback, since removing a row from a list is the
 * one operation where waiting feels sluggish.
 *
 * The list is loaded with its summary (model and counts) and only while the
 * Agents pages are open (`active`): nothing else reads it — the rest of the app
 * renders the shared catalog, which says which agents are custom on its own.
 * Each mutation re-pulls that catalog through `refreshAgentCatalog`.
 */
const NO_SUMMARY = { model: null, toolCount: null, skillCount: null, subagentCount: null };

type ToastFn = (opts: {
  title: string;
  description?: string;
  variant?: string;
  duration?: number;
}) => void;

export type UserAgentsHandlers = {
  myAgents: MyAgent[];
  loadingMyAgents: boolean;
  refreshMyAgents: () => Promise<void>;
  getAgentDefinition: (agentId: string) => Promise<CustomAgentDetail | null>;
  validateAgent: (payload: CustomAgentWritePayload) => Promise<CustomAgentValidation | null>;
  createAgent: (payload: CustomAgentWritePayload) => Promise<Agent | null>;
  updateAgent: (agentId: string, payload: CustomAgentWritePayload) => Promise<Agent | null>;
  deleteAgent: (agentId: string) => Promise<boolean>;
  busyAgentId: string | null;
};

type UserAgentsCtx = {
  userId: string | null;
  toast: ToastFn;
  /** False until the session has been confirmed against the cookies. */
  authResolved?: boolean;
  /** True while an Agents page ("/agents…") is open: the list loads on entering. */
  active: boolean;
  /**
   * Re-pull the shared agent catalog after a mutation. Owned by the workspace
   * because the catalog is app-wide state (the header picker, task form,
   * Skills/Memories per-agent lists and the Agents gallery all read it); it
   * also persists the snapshot.
   */
  refreshAgentCatalog: (options?: { removedAgentId?: string }) => Promise<void>;
};

export function useUserAgents({
  userId,
  toast,
  authResolved,
  active,
  refreshAgentCatalog,
}: UserAgentsCtx): UserAgentsHandlers {
  const [myAgents, setMyAgents] = useState<MyAgent[]>([]);
  const [loadingMyAgents, setLoadingMyAgents] = useState(false);
  const [busyAgentId, setBusyAgentId] = useState<string | null>(null);

  // Flush per-user state on login/logout so a previous session's agents are
  // never briefly visible to the next one.
  useEffect(() => {
    setMyAgents([]);
    setBusyAgentId(null);
  }, [userId]);

  const refreshMyAgents = useCallback(async () => {
    // Same guard as useSkills: the store's userId can disagree with the cookies
    // until the session is confirmed (see useSkills for the OIDC case).
    if (!userId || authResolved === false) {
      setMyAgents([]);
      return;
    }
    setLoadingMyAgents(true);
    try {
      setMyAgents(await getMyAgents(userId, { summary: true }));
    } catch {
      // A background refresh must not nag: the list simply stays as it was.
      // Explicit actions below surface their own failures.
    } finally {
      setLoadingMyAgents(false);
    }
  }, [userId, authResolved]);

  // On entering the Agents pages (and again on each later visit, so counts
  // changed elsewhere — a tool switched off in a chat — are not stale).
  useEffect(() => {
    if (active) void refreshMyAgents();
  }, [active, refreshMyAgents]);

  const requireUser = useCallback((): boolean => {
    if (userId) return true;
    toast({
      title: "Authentication required",
      description: "Please sign in again.",
      variant: "destructive",
    });
    return false;
  }, [userId, toast]);

  const getAgentDefinition = useCallback(
    async (agentId: string): Promise<CustomAgentDetail | null> => {
      if (!requireUser() || !userId) return null;
      try {
        return await getMyAgentDetail(userId, agentId);
      } catch (error) {
        toastError(toast, "Could not open the agent", error, {
          description: error instanceof Error ? error.message : "Please try again.",
        });
        return null;
      }
    },
    [requireUser, userId, toast],
  );

  // Returns the validation result so the builder can render field errors. A
  // transport failure returns null — distinct from "valid: false", which is a
  // real answer from the server.
  const validateAgent = useCallback(
    async (payload: CustomAgentWritePayload): Promise<CustomAgentValidation | null> => {
      if (!requireUser() || !userId) return null;
      try {
        return await validateMyAgent(userId, payload);
      } catch (error) {
        toastError(toast, "Could not validate the agent", error, {
          description: error instanceof Error ? error.message : "Please try again.",
        });
        return null;
      }
    },
    [requireUser, userId, toast],
  );

  const createAgent = useCallback(
    async (payload: CustomAgentWritePayload): Promise<Agent | null> => {
      if (!requireUser() || !userId || busyAgentId) return null;
      setBusyAgentId("__create__");
      try {
        const created = await createMyAgent(userId, payload);
        setMyAgents((prev) => [...prev, { ...created, kind: "custom", ...NO_SUMMARY }]);
        toast({ title: "Agent created", description: `${created.name} is ready to use.` });
        // The catalog first (the new agent's page resolves it from there), then
        // this list again for the new card's counts.
        await refreshAgentCatalog();
        void refreshMyAgents();
        return created;
      } catch (error) {
        toastError(toast, "Could not create the agent", error, {
          description: error instanceof Error ? error.message : "Please try again.",
        });
        return null;
      } finally {
        setBusyAgentId(null);
      }
    },
    [requireUser, userId, busyAgentId, toast, refreshAgentCatalog, refreshMyAgents],
  );

  const updateAgent = useCallback(
    async (agentId: string, payload: CustomAgentWritePayload): Promise<Agent | null> => {
      if (!requireUser() || !userId || busyAgentId) return null;
      setBusyAgentId(agentId);
      try {
        const saved = await updateMyAgent(userId, agentId, payload);
        // Keep the old counts until the re-pull below replaces them.
        setMyAgents((prev) => prev.map((a) => (a.id === saved.id ? { ...a, ...saved, kind: "custom" } : a)));
        toast({ title: "Agent saved", description: `${saved.name} was updated.` });
        await refreshAgentCatalog();
        void refreshMyAgents();
        return saved;
      } catch (error) {
        toastError(toast, "Could not save the agent", error, {
          description: error instanceof Error ? error.message : "Please try again.",
        });
        return null;
      } finally {
        setBusyAgentId(null);
      }
    },
    [requireUser, userId, busyAgentId, toast, refreshAgentCatalog, refreshMyAgents],
  );

  const deleteAgent = useCallback(
    async (agentId: string): Promise<boolean> => {
      if (!requireUser() || !userId || busyAgentId) return false;
      const previous = myAgents;
      // Captured before the optimistic removal so the toast can name the agent.
      const removed = previous.find((a) => a.id === agentId);
      setBusyAgentId(agentId);
      setMyAgents((prev) => prev.filter((a) => a.id !== agentId));
      try {
        await deleteMyAgent(userId, agentId);
        toast({
          title: "Agent deleted",
          description: removed
            ? `${removed.name} was removed. Your conversations with it are kept.`
            : "Your conversations with it are kept.",
        });
        // The id re-points a picker selection that named the deleted agent,
        // instead of leaving it on a dead id.
        await refreshAgentCatalog({ removedAgentId: agentId });
        return true;
      } catch (error) {
        setMyAgents(previous);
        toastError(toast, "Could not delete the agent", error, {
          description: error instanceof Error ? error.message : "Please try again.",
        });
        return false;
      } finally {
        setBusyAgentId(null);
      }
    },
    [requireUser, userId, busyAgentId, myAgents, toast, refreshAgentCatalog],
  );

  return {
    myAgents,
    loadingMyAgents,
    refreshMyAgents,
    getAgentDefinition,
    validateAgent,
    createAgent,
    updateAgent,
    deleteAgent,
    busyAgentId,
  };
}
