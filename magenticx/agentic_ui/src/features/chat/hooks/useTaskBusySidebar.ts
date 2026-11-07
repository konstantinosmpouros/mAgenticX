import { useEffect, useMemo, useRef, type Dispatch, type SetStateAction } from "react";
import { hasWorkingTasks } from "@/features/inference/taskTree";
import { listTaskBusyConversations } from "@/shared/lib/api";
import type { AsyncTaskTreeState, ConversationDetail, ConversationSummary } from "@/shared/lib/types";

/** How often the sidebar asks which conversations still have tasks working. */
export const TASK_BUSY_POLL_MS = 10_000;

type UseTaskBusySidebarOptions = {
  userId: string | null | undefined;
  conversations: ConversationSummary[];
  setConversations: Dispatch<SetStateAction<ConversationSummary[]>>;
  currentConversationId: string | null;
  setCurrentConversation: Dispatch<SetStateAction<ConversationDetail | null>>;
  taskTree: AsyncTaskTreeState;
};

function withTaskFlag<T extends { id: string; hasActiveTasks?: boolean }>(
  rows: T[],
  flagFor: (id: string) => boolean | undefined,
): T[] {
  let changed = false;
  const next = rows.map((row) => {
    const flag = flagFor(row.id);
    if (flag === undefined || Boolean(row.hasActiveTasks) === flag) return row;
    changed = true;
    return { ...row, hasActiveTasks: flag };
  });
  return changed ? next : rows;
}

/**
 * Keeps the sidebar's "busy" spinner true while a conversation's background
 * tasks work, not only while its answer streams.
 *
 *  - The open conversation follows its live task tree (once the tree holds
 *    tasks: an empty tree is "not loaded yet", and the detail's flag stands).
 *  - Every other row is refreshed by a light poll, run only while the tab is
 *    visible and some other row spins for tasks — so it costs nothing when
 *    nothing works in the background, and a row stops spinning on its own
 *    when its tasks settle (or another tab's tasks start one).
 */
export function useTaskBusySidebar({
  userId,
  conversations,
  setConversations,
  currentConversationId,
  setCurrentConversation,
  taskTree,
}: UseTaskBusySidebarOptions) {
  const treeHasTasks = Object.keys(taskTree.tasks).length > 0;
  const treeIsCurrent = Boolean(currentConversationId) && taskTree.conversationId === currentConversationId;
  const liveFlag = treeIsCurrent && treeHasTasks ? hasWorkingTasks(taskTree) : undefined;

  useEffect(() => {
    if (liveFlag === undefined || !currentConversationId) return;
    setConversations((prev) => withTaskFlag(prev, (id) => (id === currentConversationId ? liveFlag : undefined)));
    setCurrentConversation((prev) =>
      prev && prev.id === currentConversationId && Boolean(prev.hasActiveTasks) !== liveFlag
        ? { ...prev, hasActiveTasks: liveFlag }
        : prev,
    );
  }, [currentConversationId, liveFlag, setConversations, setCurrentConversation]);

  const othersBusy = useMemo(
    () => conversations.some((row) => row.id !== currentConversationId && row.hasActiveTasks),
    [conversations, currentConversationId],
  );
  const currentIdRef = useRef(currentConversationId);
  currentIdRef.current = currentConversationId;

  useEffect(() => {
    if (!userId || !othersBusy) return undefined;
    let controller: AbortController | null = null;
    const poll = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      controller?.abort();
      controller = new AbortController();
      listTaskBusyConversations(userId, controller.signal)
        .then((ids) => {
          const busy = new Set(ids);
          setConversations((prev) =>
            withTaskFlag(prev, (id) => (id === currentIdRef.current ? undefined : busy.has(id))),
          );
        })
        .catch(() => {
          // A missed poll is retried on the next tick.
        });
    };
    const timer = window.setInterval(poll, TASK_BUSY_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      controller?.abort();
    };
  }, [othersBusy, setConversations, userId]);
}
