import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { CircleAlert, Plus } from "lucide-react";

import type {
  Agent,
  AutomationItem,
  AutomationStatusFilter,
  AutomationTemplate,
  ScheduleFormInitial,
  ScheduledTask,
  ScheduledTaskCreatePayload,
  ScheduledTaskUpdatePayload,
} from "@/shared/lib/types";
import { useToast } from "@/shared/hooks/use-toast";
import { toastError } from "@/shared/lib/toast";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { TooltipProvider } from "@/shared/ui/tooltip";
import { SidebarTrigger } from "@/shared/ui/sidebar";
import { AutomationFormDialog } from "@/features/automations/components/automations_parts/AutomationFormDialog";
import {
  AutomationCard,
  AutomationCardSkeleton,
} from "@/features/automations/components/automations_parts/AutomationCard";
import { AutomationToolbar } from "@/features/automations/components/automations_parts/AutomationToolbar";
import { EmptyState } from "@/features/automations/components/automations_parts/EmptyState";
import { ErrorState } from "@/features/automations/components/automations_parts/ErrorState";
import { TemplateSection } from "@/features/automations/components/automations_parts/TemplateSection";
import {
  SEARCH_MIN_ITEMS,
  filterAutomations,
  statusFilterCounts,
} from "@/features/automations/lib/filters";
import { automationItemId } from "@/features/automations/lib/kinds";
import { PRIMARY_BUTTON } from "@/features/automations/lib/styles";
import { findTemplate } from "@/features/automations/lib/templates";

type AutomationsPageProps = {
  onClose: () => void;
  items: AutomationItem[];
  loading: boolean;
  error?: string | null;
  agents: Agent[];
  onCreate: (payload: ScheduledTaskCreatePayload) => Promise<ScheduledTask>;
  onUpdate: (taskId: string, payload: ScheduledTaskUpdatePayload) => Promise<ScheduledTask>;
  onDelete: (taskId: string) => Promise<void>;
  onOpenResult: (conversationId: string, agentId?: string | null) => void;
  /** Re-fetch after a load error; the "Try again" button hides without it. */
  onRetry?: () => void;
  /**
   * Open the create form with this agent chosen — an agent's "Schedule it"
   * (`?agent=`). Read once per id; `onCreateForAgentHandled` lets the route
   * drop it, so a refresh or Back does not open the form again.
   */
  createForAgentId?: string | null;
  onCreateForAgentHandled?: () => void;
  /** The same, for a template (`?template=`): the form opens filled in from it. */
  createFromTemplateId?: string | null;
  onCreateFromTemplateHandled?: () => void;
};

type FormState =
  | { open: false }
  | {
      open: true;
      mode: "create" | "edit";
      key: string;
      initial?: ScheduleFormInitial;
      taskId?: string;
      /** The template it was filled from: the dialog's banner. */
      templateLabel?: string;
    };

/** How long a just-created card stays highlighted (its pulse is shorter). */
const HIGHLIGHT_MS = 1600;

const errorMessage = (err: unknown): string =>
  err instanceof Error && err.message ? err.message : "Something went wrong. Please try again.";

function templateInitial(template: AutomationTemplate): ScheduleFormInitial {
  // No agentId — the form defaults the agent; tools are agent-declared, not per-task.
  return {
    title: template.label,
    prompt: template.instructions,
    targetMode: template.targetMode,
    scheduleKind: template.scheduleKind,
    scheduleSpec: template.scheduleSpec,
  };
}

/** Re-render on a timer so countdowns ("in 4 min") stay true. */
function useNow(intervalMs: number): Date {
  const [now, setNow] = React.useState(() => new Date());
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/**
 * The Automations page: one scroll, no tabs. Header → status chips → your
 * automations → "Start from a template". With nothing yet, the empty state's
 * hero sits above the full template gallery. A template opens the create
 * dialog filled in (the dialog is its preview); after a create, the new card
 * scrolls into view and pulses once.
 */
export default function AutomationsPage({
  onClose,
  items,
  loading,
  error,
  agents,
  onCreate,
  onUpdate,
  onDelete,
  onOpenResult,
  onRetry,
  createForAgentId = null,
  onCreateForAgentHandled,
  createFromTemplateId = null,
  onCreateFromTemplateHandled,
}: AutomationsPageProps) {
  const reduceMotion = useReducedMotion() ?? false;
  const { toast } = useToast();
  const now = useNow(30000);
  const [filter, setFilter] = React.useState<AutomationStatusFilter>("all");
  const [query, setQuery] = React.useState("");
  const [form, setForm] = React.useState<FormState>({ open: false });
  const [submitting, setSubmitting] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<ScheduledTask | null>(null);
  const [highlightId, setHighlightId] = React.useState<string | null>(null);

  // Escape closes the page. The dialogs own Esc while they are open.
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || form.open || deleteTarget) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [form.open, deleteTarget, onClose]);

  // The just-created highlight is a moment, not a state.
  React.useEffect(() => {
    if (!highlightId) return;
    const timer = window.setTimeout(() => setHighlightId(null), HIGHLIGHT_MS);
    return () => window.clearTimeout(timer);
  }, [highlightId]);

  const openCreate = () => {
    setSubmitError(null);
    setForm({ open: true, mode: "create", key: `create-${Date.now()}` });
  };
  const openTemplate = (template: AutomationTemplate) => {
    setSubmitError(null);
    setForm({
      open: true,
      mode: "create",
      key: `tpl-${template.id}-${Date.now()}`,
      initial: templateInitial(template),
      templateLabel: template.label,
    });
  };

  // "Schedule it" from an agent's page. An id the form's list does not have
  // (deleted since) still opens the form, on its default agent.
  React.useEffect(() => {
    if (!createForAgentId) return;
    const known = agents.some((agent) => agent.id === createForAgentId);
    setSubmitError(null);
    setForm({
      open: true,
      mode: "create",
      key: `create-${createForAgentId}-${Date.now()}`,
      initial: known ? { agentId: createForAgentId } : undefined,
    });
    onCreateForAgentHandled?.();
    // Once per id: the agent list or the callback changing must not reopen it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createForAgentId]);

  // A template link. An unknown id opens nothing; the parameter is dropped either way.
  React.useEffect(() => {
    if (!createFromTemplateId) return;
    const template = findTemplate(createFromTemplateId);
    if (template) openTemplate(template);
    onCreateFromTemplateHandled?.();
    // Once per id, like the agent link above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createFromTemplateId]);

  const openEdit = (task: ScheduledTask) => {
    setSubmitError(null);
    setForm({
      open: true,
      mode: "edit",
      key: `edit-${task.id}-${Date.now()}`,
      initial: task,
      taskId: task.id,
    });
  };
  const closeForm = () => setForm({ open: false });

  const handleSubmit = async (payload: ScheduledTaskCreatePayload) => {
    if (!form.open) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      if (form.mode === "edit" && form.taskId) {
        await onUpdate(form.taskId, payload);
      } else {
        const created = await onCreate(payload);
        // Land on the new card: make sure no chip or search hides it, then it
        // scrolls itself into view and pulses.
        setFilter("all");
        setQuery("");
        setHighlightId(automationItemId({ kind: "schedule", task: created }));
      }
      closeForm();
    } catch (err) {
      // Keep the form and its inputs; say what went wrong above the actions.
      setSubmitError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggle = async (task: ScheduledTask) => {
    const resume = task.status === "paused";
    try {
      await onUpdate(task.id, { status: resume ? "active" : "paused" });
    } catch (err) {
      toastError(
        toast,
        resume ? "Could not resume the automation" : "Could not pause the automation",
        err,
      );
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await onDelete(deleteTarget.id);
    } catch (err) {
      toastError(toast, "Could not delete the automation", err);
    }
  };

  const counts = React.useMemo(() => statusFilterCounts(items), [items]);
  const visible = React.useMemo(
    () => filterAutomations(items, filter, query),
    [items, filter, query],
  );
  const hasItems = items.length > 0;

  let body: React.ReactNode;
  if (loading && !hasItems) {
    body = (
      <div className="grid gap-3 md:grid-cols-2" aria-label="Loading automations" aria-busy="true">
        {Array.from({ length: 4 }).map((_, i) => (
          <AutomationCardSkeleton key={`automation-skeleton-${i}`} />
        ))}
      </div>
    );
  } else if (error && !hasItems) {
    body = <ErrorState message={error} onRetry={onRetry} />;
  } else if (!hasItems) {
    body = (
      <>
        <EmptyState onCreate={openCreate} />
        <TemplateSection compact={false} onUse={openTemplate} reduceMotion={reduceMotion} />
      </>
    );
  } else {
    body = (
      <>
        <AutomationToolbar
          filter={filter}
          onFilterChange={setFilter}
          counts={counts}
          query={query}
          onQueryChange={setQuery}
          showSearch={items.length >= SEARCH_MIN_ITEMS}
        />
        {error ? (
          <p
            className="mt-3 flex items-center gap-2 rounded-xl bg-destructive/[0.08] px-3 py-2 text-xs text-destructive"
            role="alert"
          >
            <CircleAlert className="h-3.5 w-3.5 flex-shrink-0" aria-hidden />
            {error} Showing the last list we had.
          </p>
        ) : null}
        <section aria-label="Your automations" className="mt-4">
          {visible.length === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border/80 px-6 py-10 text-center text-sm text-muted-foreground">
              No automations match this filter.
              <button
                type="button"
                onClick={() => {
                  setFilter("all");
                  setQuery("");
                }}
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
                {visible.map((item, index) => {
                  const id = automationItemId(item);
                  return (
                    <AutomationCard
                      key={id}
                      item={item}
                      agents={agents}
                      now={now}
                      index={index}
                      reduceMotion={reduceMotion}
                      highlighted={highlightId === id}
                      onToggle={handleToggle}
                      onEdit={openEdit}
                      onDelete={setDeleteTarget}
                      onOpenResult={onOpenResult}
                    />
                  );
                })}
              </AnimatePresence>
            </motion.div>
          )}
        </section>
        <div className="mt-10">
          <TemplateSection compact onUse={openTemplate} reduceMotion={reduceMotion} />
        </div>
      </>
    );
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-full flex-col bg-background">
        {/* Page header — title and the primary New automation action. */}
        <header className="relative flex-shrink-0 px-4 pb-4 pt-4 sm:px-6 sm:pt-6">
          <div className="mx-auto flex w-full max-w-4xl items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              {/* On mobile the sidebar is an overlay sheet — once collapsed
                  it's gone, and this page covers ChatHeader's own trigger.
                  Mirror that md:hidden toggle here so there's always a way
                  back to the sidebar from the Automations page. */}
              <SidebarTrigger
                aria-label="Toggle sidebar"
                className="inline-flex h-10 w-10 flex-shrink-0 rounded-xl bg-transparent text-foreground transition-colors hover:bg-[hsl(var(--hover-surface))] hover:text-foreground active:bg-[hsl(var(--hover-surface-strong))] focus-visible:ring-2 focus-visible:ring-ring md:hidden [&_svg]:size-5"
              />
              <div className="min-w-0">
                <h1 className="text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
                  Automations
                </h1>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  Agents that run on their own — once, on a repeat, or on a calendar.
                </p>
              </div>
            </div>
            <button type="button" onClick={openCreate} className={PRIMARY_BUTTON}>
              <Plus className="h-4 w-4" aria-hidden />
              <span className="max-[380px]:sr-only">New automation</span>
            </button>
          </div>
        </header>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 sm:px-6">
          <div className="mx-auto w-full max-w-4xl pb-10 pt-2">{body}</div>
        </div>
      </div>

      <AutomationFormDialog
        open={form.open}
        mode={form.open ? form.mode : "create"}
        formKey={form.open ? form.key : "closed"}
        agents={agents}
        initial={form.open ? form.initial : undefined}
        templateLabel={form.open ? form.templateLabel : null}
        submitting={submitting}
        submitError={submitError}
        onSubmit={(payload) => void handleSubmit(payload)}
        onClose={closeForm}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="Delete this automation?"
        description={
          <>
            <span className="font-medium text-foreground">
              {deleteTarget?.title?.trim() || deleteTarget?.prompt || "This automation"}
            </span>{" "}
            stops running. Conversations from earlier runs stay in your chats.
          </>
        }
        confirmLabel="Delete automation"
        onConfirm={confirmDelete}
      />
    </TooltipProvider>
  );
}
