import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CircleAlert } from "lucide-react";

import type { AutomationSort, WorkflowAutomationItem } from "@/shared/lib/types";
import { AutomationCardSkeleton } from "@/features/automations/components/automations_parts/AutomationCardChrome";
import { EmptyState } from "@/features/automations/components/automations_parts/EmptyState";
import { ErrorState } from "@/features/automations/components/automations_parts/ErrorState";
import { WorkflowCard } from "@/features/automations/components/automations_parts/WorkflowCard";
import { filterWorkflowItems, sortWorkflowItems } from "@/features/automations/lib/filters";
import { automationItemId } from "@/features/automations/lib/kinds";

/**
 * The Automations page's Workflows area: the user's workflows as cards (the
 * schedule cards' chrome), searched and sorted from the page's toolbar, and with none
 * yet a hero whose action opens the builder. A workflow is scheduled through
 * its own start node in the builder — never from the Schedules area.
 */
export function WorkflowsArea({
  items,
  loading,
  error,
  onRetry,
  now,
  reduceMotion,
  onCreate,
  onOpen,
  onEdit,
  onRunNow,
  onDelete,
  onSetSchedulePaused,
  query,
  onQueryChange,
  sort,
}: {
  /** The toolbar's search and sort (the page owns them). */
  query: string;
  onQueryChange: (query: string) => void;
  sort: AutomationSort;
  items: WorkflowAutomationItem[];
  loading: boolean;
  error: string | null;
  onRetry?: () => void;
  now: Date;
  reduceMotion: boolean;
  onCreate: () => void;
  onOpen: (workflowId: string) => void;
  onEdit: (workflowId: string) => void;
  onRunNow: (workflowId: string) => Promise<void>;
  onDelete: (workflowId: string) => void;
  onSetSchedulePaused?: (workflowId: string, paused: boolean) => Promise<void>;
}) {
  const visible = React.useMemo(() => sortWorkflowItems(filterWorkflowItems(items, query), sort), [items, query, sort]);
  const hasItems = items.length > 0;

  if (loading && !hasItems) {
    return (
      <div className="grid gap-3 md:grid-cols-2" aria-label="Loading workflows" aria-busy="true">
        {Array.from({ length: 4 }).map((_, i) => (
          <AutomationCardSkeleton key={`workflow-skeleton-${i}`} />
        ))}
      </div>
    );
  }
  if (error && !hasItems) return <ErrorState message={error} onRetry={onRetry} />;
  if (!hasItems) {
    return (
      <EmptyState
        onCreate={onCreate}
        title="No workflows yet"
        description="Chain steps — agents, tools, conditions, approvals — into a flow that runs by hand or on its own schedule, set on its start step."
        actionLabel="Create your first workflow"
      />
    );
  }

  return (
    <>
      {error ? (
        <p
          className="mt-3 flex items-center gap-2 rounded-xl bg-destructive/[0.08] px-3 py-2 text-xs text-destructive"
          role="alert"
        >
          <CircleAlert className="h-3.5 w-3.5 flex-shrink-0" aria-hidden />
          {error} Showing the last list we had.
        </p>
      ) : null}
      <section aria-label="Your workflows" className="mt-4">
        {visible.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border/80 px-6 py-10 text-center text-sm text-muted-foreground">
            No workflows match this search.
            <button
              type="button"
              onClick={() => onQueryChange("")}
              className="rounded-full px-3 py-1.5 text-xs font-medium text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 supports-[hover:hover]:hover:bg-primary/10"
            >
              Show all
            </button>
          </div>
        ) : (
          <motion.div
            layout={reduceMotion ? false : "position"}
            className="grid items-stretch gap-3 md:grid-cols-2"
          >
            <AnimatePresence mode="popLayout" initial>
              {visible.map((item, index) => (
                <WorkflowCard
                  key={automationItemId(item)}
                  item={item}
                  now={now}
                  index={index}
                  reduceMotion={reduceMotion}
                  onOpen={onOpen}
                  onEdit={onEdit}
                  onRunNow={onRunNow}
                  onDelete={onDelete}
                  onSetSchedulePaused={onSetSchedulePaused}
                />
              ))}
            </AnimatePresence>
          </motion.div>
        )}
      </section>
    </>
  );
}
