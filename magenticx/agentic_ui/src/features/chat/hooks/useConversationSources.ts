import { useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";

import { getConversationSources } from "@/shared/lib/api";
import type {
  CitationSource,
  CitationSourceMap,
  MessageOut,
  RunTimeline,
} from "@/shared/lib/types";
import { buildSourceRegistry, sameRegistry } from "@/features/chat/lib/sources";

const NO_SOURCES: readonly CitationSource[] = [];

type UseConversationSourcesArgs = {
  /** Null on the shared-conversation page: no durable list, events only. */
  userId: string | null;
  /** A persisted conversation's id; null (or a `shared:` view) loads nothing. */
  conversationId: string | null;
  /** The messages on the visible branch. */
  messages: readonly MessageOut[] | null | undefined;
  /** The live run's timeline, while one streams. */
  liveTimeline?: Pick<RunTimeline, "sources"> | null;
  /** Whether a run is streaming in this conversation right now. */
  runActive?: boolean;
  /** Timelines of the background tasks this tab is folding (plan 41). */
  taskTimelines?: readonly (Pick<RunTimeline, "sources"> | null | undefined)[];
  /** A shared snapshot's frozen sources (plan 42): a viewer's only durable list. */
  snapshotSources?: readonly CitationSource[] | null;
};

/**
 * Every source the open conversation may cite (plan 42), by id — what the
 * citation pills resolve their markers against (`CitationSourcesContext`).
 *
 * The durable list is loaded once per conversation (a shared snapshot brings
 * its own, frozen at share time) and reloaded when a run ends or a task
 * notification arrives: a background task stores its sources while it runs,
 * out of this tab's sight, and the orchestrator's next answer cites them. On top of it go the `SOURCES` events of the settled messages,
 * the folded background tasks and the live run, so a pill lights up the
 * moment its marker streams in. The returned map keeps its identity while its
 * contents do not change, so a streaming frame does not re-render every pill.
 */
export function useConversationSources({
  userId,
  conversationId,
  messages,
  liveTimeline,
  runActive = false,
  taskTimelines,
  snapshotSources,
}: UseConversationSourcesArgs): CitationSourceMap {
  const persisted = Boolean(userId && conversationId && !conversationId.startsWith("shared:"));
  const query = useQuery({
    queryKey: ["conversation-sources", userId, conversationId],
    queryFn: () => getConversationSources(userId as string, conversationId as string),
    enabled: persisted,
    staleTime: 60_000,
    retry: 1,
  });
  const { refetch } = query;
  const durable = persisted ? (query.data ?? NO_SOURCES) : (snapshotSources ?? NO_SOURCES);

  // Reload when a task notification lands or a run ends.
  const notifications = useMemo(
    () => (messages ?? []).filter((message) => message.kind === "task_notification").length,
    [messages],
  );
  const seen = useRef({ notifications, runActive });
  useEffect(() => {
    const before = seen.current;
    seen.current = { notifications, runActive };
    if (!persisted) return;
    if (notifications > before.notifications || (before.runActive && !runActive)) {
      void refetch();
    }
  }, [notifications, persisted, refetch, runActive]);

  const liveSources = liveTimeline?.sources;
  const taskSources = useMemo(
    () => (taskTimelines ?? []).map((timeline) => timeline?.sources),
    [taskTimelines],
  );

  const previous = useRef<CitationSourceMap>(new Map());
  return useMemo(() => {
    const next = buildSourceRegistry({
      durable,
      messages,
      timelines: [
        ...taskSources.map((sources) => ({ sources })),
        { sources: liveSources },
      ],
    });
    if (sameRegistry(previous.current, next)) return previous.current;
    previous.current = next;
    return next;
  }, [durable, liveSources, messages, taskSources]);
}
