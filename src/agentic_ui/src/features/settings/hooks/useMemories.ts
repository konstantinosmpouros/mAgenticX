import { useCallback, useEffect, useRef, useState } from 'react';
import { deleteAgentMemory, getAgentMemory, listAgentMemories } from '@/shared/lib/api';
import { toastError } from '@/shared/lib/toast';
import type { MemoryDetail, MemorySummary } from '@/shared/lib/types';

// Owns the read + delete state for the ProfilePanel "Memories" tab. Memory is
// per-(user, agent) on the agents-service filesystem; the bridge proxies. The
// agent owns *writes* (via its `remember` tool) — here the user only inspects
// and deletes.
//
//   1. Per-agent memory lists — lazily loaded when the user drills into an
//      agent, keyed by agentId.
//   2. Per-memory detail (full content) — loaded on click, keyed by
//      `${agentId}::${name}`, so opening a row doesn't refetch every time.
//   3. Delete — optimistically drops the row from the list (and detail cache),
//      then proxies the delete (which removes the yml + its AGENTS.md row).
type ToastFn = (opts: { title: string; description?: string; variant?: string; duration?: number }) => void;

export type MemoriesHandlers = {
  memories: Record<string, MemorySummary[]>;
  isAgentLoading: (agentId: string) => boolean;
  ensureLoaded: (agentId: string) => Promise<void>;
  refreshAgent: (agentId: string) => Promise<void>;

  detail: Record<string, MemoryDetail>;
  isDetailLoading: (agentId: string, name: string) => boolean;
  ensureDetail: (agentId: string, name: string) => Promise<void>;

  deleteMemory: (agentId: string, name: string) => Promise<void>;
  isDeleting: (agentId: string, name: string) => boolean;
};

type MemoriesCtx = {
  userId: string | null;
  toast: ToastFn;
};

const detailKey = (agentId: string, name: string) => `${agentId}::${name}`;

export function useMemories(ctx: MemoriesCtx): MemoriesHandlers {
  const { userId, toast } = ctx;
  const [memories, setMemories] = useState<Record<string, MemorySummary[]>>({});
  const [loadingAgents, setLoadingAgents] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<Record<string, MemoryDetail>>({});
  const [loadingDetailKeys, setLoadingDetailKeys] = useState<Set<string>>(new Set());
  const [deletingKeys, setDeletingKeys] = useState<Set<string>>(new Set());
  const loadedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    // New user (login/logout) — flush every per-user piece of state.
    setMemories({});
    setLoadingAgents(new Set());
    setDetail({});
    setLoadingDetailKeys(new Set());
    setDeletingKeys(new Set());
    loadedRef.current = new Set();
  }, [userId]);

  const loadAgent = useCallback(async (agentId: string) => {
    if (!userId || !agentId) return;
    setLoadingAgents((prev) => new Set(prev).add(agentId));
    try {
      const fetched = await listAgentMemories(userId, agentId);
      setMemories((prev) => ({ ...prev, [agentId]: fetched }));
      loadedRef.current.add(agentId);
    } catch (error) {
      toastError(toast, 'Could not load memories', error, {
        description: error instanceof Error ? error.message : 'Please try again.',
      });
    } finally {
      setLoadingAgents((prev) => {
        const next = new Set(prev);
        next.delete(agentId);
        return next;
      });
    }
  }, [userId, toast]);

  const ensureLoaded = useCallback(async (agentId: string) => {
    if (loadedRef.current.has(agentId)) return;
    await loadAgent(agentId);
  }, [loadAgent]);

  const refreshAgent = useCallback(async (agentId: string) => {
    await loadAgent(agentId);
  }, [loadAgent]);

  const isAgentLoading = useCallback(
    (agentId: string) => loadingAgents.has(agentId),
    [loadingAgents],
  );

  const isDetailLoading = useCallback(
    (agentId: string, name: string) => loadingDetailKeys.has(detailKey(agentId, name)),
    [loadingDetailKeys],
  );

  const ensureDetail = useCallback(async (agentId: string, name: string) => {
    if (!userId) return;
    const key = detailKey(agentId, name);
    if (detail[key] || loadingDetailKeys.has(key)) return;
    setLoadingDetailKeys((prev) => new Set(prev).add(key));
    try {
      const fetched = await getAgentMemory(userId, agentId, name);
      setDetail((prev) => ({ ...prev, [key]: fetched }));
    } catch (error) {
      toastError(toast, 'Could not load memory content', error, {
        description: error instanceof Error ? error.message : 'Please try again.',
      });
    } finally {
      setLoadingDetailKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }, [userId, detail, loadingDetailKeys, toast]);

  const isDeleting = useCallback(
    (agentId: string, name: string) => deletingKeys.has(detailKey(agentId, name)),
    [deletingKeys],
  );

  const deleteMemory = useCallback(async (agentId: string, name: string) => {
    if (!userId) {
      toast({ title: 'Authentication required', description: 'Please sign in again.', variant: 'destructive' });
      return;
    }
    const key = detailKey(agentId, name);
    if (deletingKeys.has(key)) return;
    const prevList = memories[agentId] ?? [];
    // Optimistically drop the row + its cached detail; restore on failure.
    setMemories((prev) => ({ ...prev, [agentId]: prevList.filter((m) => m.name !== name) }));
    setDetail((prev) => {
      if (!(key in prev)) return prev;
      const { [key]: _gone, ...rest } = prev;
      return rest;
    });
    setDeletingKeys((prev) => new Set(prev).add(key));
    try {
      await deleteAgentMemory(userId, agentId, name);
    } catch (error) {
      setMemories((prev) => ({ ...prev, [agentId]: prevList }));
      toastError(toast, 'Could not delete the memory', error, {
        description: error instanceof Error ? error.message : 'Please try again.',
      });
    } finally {
      setDeletingKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }, [userId, memories, deletingKeys, toast]);

  return {
    memories,
    isAgentLoading,
    ensureLoaded,
    refreshAgent,
    detail,
    isDetailLoading,
    ensureDetail,
    deleteMemory,
    isDeleting,
  };
}
