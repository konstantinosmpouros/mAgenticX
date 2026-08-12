import { useCallback, useEffect, useState } from 'react';

import {
  createMyAgent,
  deleteMyAgent,
  getMyAgentDetail,
  getMyAgents,
  updateMyAgent,
  validateMyAgent,
} from '@/shared/lib/api';
import type {
  Agent,
  CustomAgentDetail,
  CustomAgentValidation,
  CustomAgentWritePayload,
} from '@/shared/lib/types';

/**
 * The agents this user authored: load, create, edit, delete.
 *
 * Mirrors `useSkills` — a per-`userId` reset so nothing leaks across a
 * login/logout, an in-flight guard so double-clicks can't fire twice, and the
 * create/update paths adopting the canonical server row rather than a
 * frontend-guessed one (the id, icon and version are all assigned server-side).
 * Delete is optimistic with a rollback, since removing a row from a list is the
 * one operation where waiting feels sluggish.
 */
type ToastFn = (opts: { title: string; description?: string; variant?: string; duration?: number }) => void;

export type UserAgentsHandlers = {
  myAgents: Agent[];
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
};

export function useUserAgents({ userId, toast }: UserAgentsCtx): UserAgentsHandlers {
  const [myAgents, setMyAgents] = useState<Agent[]>([]);
  const [loadingMyAgents, setLoadingMyAgents] = useState(false);
  const [busyAgentId, setBusyAgentId] = useState<string | null>(null);

  // Flush per-user state on login/logout so a previous session's agents are
  // never briefly visible to the next one.
  useEffect(() => {
    setMyAgents([]);
    setBusyAgentId(null);
  }, [userId]);

  const refreshMyAgents = useCallback(async () => {
    if (!userId) {
      setMyAgents([]);
      return;
    }
    setLoadingMyAgents(true);
    try {
      setMyAgents(await getMyAgents(userId));
    } catch {
      // A background refresh must not nag: the list simply stays as it was.
      // Explicit actions below surface their own failures.
    } finally {
      setLoadingMyAgents(false);
    }
  }, [userId]);

  useEffect(() => {
    void refreshMyAgents();
  }, [refreshMyAgents]);

  const requireUser = useCallback((): boolean => {
    if (userId) return true;
    toast({
      title: 'Authentication required',
      description: 'Please sign in again.',
      variant: 'destructive',
    });
    return false;
  }, [userId, toast]);

  const getAgentDefinition = useCallback(
    async (agentId: string): Promise<CustomAgentDetail | null> => {
      if (!requireUser() || !userId) return null;
      try {
        return await getMyAgentDetail(userId, agentId);
      } catch (error) {
        toast({
          title: 'Could not open the agent',
          description: error instanceof Error ? error.message : 'Please try again.',
          variant: 'destructive',
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
        toast({
          title: 'Could not validate the agent',
          description: error instanceof Error ? error.message : 'Please try again.',
          variant: 'destructive',
        });
        return null;
      }
    },
    [requireUser, userId, toast],
  );

  const createAgent = useCallback(
    async (payload: CustomAgentWritePayload): Promise<Agent | null> => {
      if (!requireUser() || !userId || busyAgentId) return null;
      setBusyAgentId('__create__');
      try {
        const created = await createMyAgent(userId, payload);
        setMyAgents((prev) => [...prev, created]);
        toast({ title: 'Agent created', description: `${created.name} is ready to use.` });
        return created;
      } catch (error) {
        toast({
          title: 'Could not create the agent',
          description: error instanceof Error ? error.message : 'Please try again.',
          variant: 'destructive',
        });
        return null;
      } finally {
        setBusyAgentId(null);
      }
    },
    [requireUser, userId, busyAgentId, toast],
  );

  const updateAgent = useCallback(
    async (agentId: string, payload: CustomAgentWritePayload): Promise<Agent | null> => {
      if (!requireUser() || !userId || busyAgentId) return null;
      setBusyAgentId(agentId);
      try {
        const saved = await updateMyAgent(userId, agentId, payload);
        setMyAgents((prev) => prev.map((a) => (a.id === saved.id ? saved : a)));
        toast({ title: 'Agent saved', description: `${saved.name} was updated.` });
        return saved;
      } catch (error) {
        toast({
          title: 'Could not save the agent',
          description: error instanceof Error ? error.message : 'Please try again.',
          variant: 'destructive',
        });
        return null;
      } finally {
        setBusyAgentId(null);
      }
    },
    [requireUser, userId, busyAgentId, toast],
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
          title: 'Agent deleted',
          description: removed
            ? `${removed.name} was removed. Your conversations with it are kept.`
            : 'Your conversations with it are kept.',
        });
        return true;
      } catch (error) {
        setMyAgents(previous);
        toast({
          title: 'Could not delete the agent',
          description: error instanceof Error ? error.message : 'Please try again.',
          variant: 'destructive',
        });
        return false;
      } finally {
        setBusyAgentId(null);
      }
    },
    [requireUser, userId, busyAgentId, myAgents, toast],
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
