import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { CircleAlert, Plus, RotateCw } from "lucide-react";

import type {
  Agent,
  ScheduledTask,
  ScheduledTaskCreatePayload,
  ScheduledTaskUpdatePayload,
} from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";
import { useToast } from "@/shared/hooks/use-toast";
import { toastError } from "@/shared/lib/toast";
import { BrandMark } from "@/shared/ui/brand-mark";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { TooltipProvider } from "@/shared/ui/tooltip";
import { SidebarTrigger } from "@/shared/ui/sidebar";
import { type ScheduledTaskFormInitial } from "@/features/tasks/components/scheduled_tasks_parts/ScheduledTaskForm";
import { TaskFormDialog } from "@/features/tasks/components/scheduled_tasks_parts/TaskFormDialog";
import {
  TaskCard,
  TaskCardSkeleton,
} from "@/features/tasks/components/scheduled_tasks_parts/TaskCard";
import { TemplatesGallery } from "@/features/tasks/components/scheduled_tasks_parts/TemplatesGallery";
import { type ScheduledTaskTemplate } from "@/features/tasks/components/scheduled_tasks_parts/templates";
import { taskStatusKind } from "@/features/tasks/lib/schedule";

type ScheduledTasksPageProps = {
  onClose: () => void;
  tasks: ScheduledTask[];
  loading: boolean;
  error?: string | null;
  agents: Agent[];
  onCreate: (payload: ScheduledTaskCreatePayload) => Promise<ScheduledTask>;
  onUpdate: (taskId: string, payload: ScheduledTaskUpdatePayload) => Promise<ScheduledTask>;
  onDelete: (taskId: string) => Promise<void>;
  onOpenResult: (conversationId: string, agentId?: string | null) => void;
  /** Re-fetch after a load error; the "Try again" button hides without it. */
  onRetry?: () => void;
};

type FormState =
  | { open: false }
  | {
      open: true;
      mode: "create" | "edit";
      key: string;
      initial?: ScheduledTaskFormInitial;
      taskId?: string;
      fromTemplate?: boolean;
    };

const PRIMARY_BUTTON =
  "inline-flex flex-shrink-0 items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-[0_8px_20px_-10px_hsl(var(--primary)/0.9)] transition-[background-color,transform,box-shadow] hover:bg-primary/90 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background";

const errorMessage = (err: unknown): string =>
  err instanceof Error && err.message ? err.message : "Something went wrong. Please try again.";

function templateInitial(template: ScheduledTaskTemplate): ScheduledTaskFormInitial {
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

// A segmented pill control for switching between My tasks and Templates.
function PageTabs({
  tab,
  onChange,
  taskCount,
  reduceMotion,
}: {
  tab: "tasks" | "templates";
  onChange: (tab: "tasks" | "templates") => void;
  taskCount: number;
  reduceMotion: boolean;
}) {
  const options: ["tasks" | "templates", string][] = [
    ["tasks", "My tasks"],
    ["templates", "Templates"],
  ];
  return (
    <div
      className="inline-flex items-center gap-1 rounded-full bg-muted/70 p-1 ring-1 ring-inset ring-border/50"
      role="tablist"
    >
      {options.map(([value, label]) => {
        const active = tab === value;
        return (
          <button
            key={value}
            type="button"
            role="tab"
            onClick={() => onChange(value)}
            aria-selected={active}
            aria-pressed={active}
            className={cn(
              "relative inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
              active
                ? "text-foreground"
                : "text-muted-foreground supports-[hover:hover]:hover:text-foreground",
            )}
          >
            {active ? (
              <motion.span
                layoutId="tasks-page-tab"
                transition={
                  reduceMotion
                    ? { duration: 0 }
                    : { type: "spring", stiffness: 520, damping: 42, mass: 0.8 }
                }
                className="absolute inset-0 rounded-full bg-card shadow-[0_1px_3px_hsl(var(--foreground)/0.12)] ring-1 ring-border/60"
              />
            ) : null}
            <span className="relative">{label}</span>
            {value === "tasks" && taskCount > 0 ? (
              <span className="relative rounded-full bg-primary/10 px-1.5 text-[11px] font-semibold tabular-nums text-primary">
                {taskCount}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function EmptyState({ onCreate, onBrowse }: { onCreate: () => void; onBrowse: () => void }) {
  return (
    <div className="flex min-h-[22rem] flex-col items-center justify-center gap-5 px-6 py-10 text-center">
      <BrandMark size={84} />
      <div className="max-w-sm space-y-1.5">
        <p className="text-base font-semibold text-foreground">No scheduled tasks yet</p>
        <p className="text-sm leading-6 text-muted-foreground">
          Let an agent work on its own — once, on a repeat, or on a calendar — and find the result
          waiting.
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <button type="button" onClick={onCreate} className={PRIMARY_BUTTON}>
          <Plus className="h-4 w-4" aria-hidden />
          Create your first task
        </button>
        <button
          type="button"
          onClick={onBrowse}
          className="inline-flex items-center gap-1.5 rounded-full border border-border/70 px-4 py-2 text-sm font-medium text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 supports-[hover:hover]:hover:bg-[hsl(var(--hover-surface))]"
        >
          Browse templates
        </button>
      </div>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      className="flex min-h-[18rem] flex-col items-center justify-center gap-4 px-6 text-center"
      role="alert"
    >
      <span className="grid h-12 w-12 place-items-center rounded-2xl bg-destructive/10 text-destructive">
        <CircleAlert className="h-5 w-5" aria-hidden />
      </span>
      <div className="max-w-sm space-y-1">
        <p className="text-sm font-semibold text-foreground">{message}</p>
        <p className="text-sm text-muted-foreground">
          Check your connection — the list refreshes on its own.
        </p>
      </div>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-1.5 rounded-full border border-border/70 px-4 py-2 text-sm font-medium text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 supports-[hover:hover]:hover:bg-[hsl(var(--hover-surface))]"
        >
          <RotateCw className="h-4 w-4" aria-hidden />
          Try again
        </button>
      ) : null}
    </div>
  );
}

export default function ScheduledTasksPage({
  onClose,
  tasks,
  loading,
  error,
  agents,
  onCreate,
  onUpdate,
  onDelete,
  onOpenResult,
  onRetry,
}: ScheduledTasksPageProps) {
  const reduceMotion = useReducedMotion() ?? false;
  const { toast } = useToast();
  const now = useNow(30000);
  const [tab, setTab] = React.useState<"tasks" | "templates">("tasks");
  const [selectedTemplate, setSelectedTemplate] = React.useState<ScheduledTaskTemplate | null>(
    null,
  );
  const [form, setForm] = React.useState<FormState>({ open: false });
  const [submitting, setSubmitting] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<ScheduledTask | null>(null);

  // Escape backs out of a template's detail, or closes the page from the top
  // level. The dialogs own Esc while they are open.
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || form.open || deleteTarget) return;
      event.preventDefault();
      if (tab === "templates" && selectedTemplate) setSelectedTemplate(null);
      else onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [tab, selectedTemplate, form.open, deleteTarget, onClose]);

  const openCreate = () => {
    setSubmitError(null);
    setForm({ open: true, mode: "create", key: `create-${Date.now()}` });
  };
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
  const openTemplate = (template: ScheduledTaskTemplate) => {
    setSubmitError(null);
    setForm({
      open: true,
      mode: "create",
      key: `tpl-${template.id}-${Date.now()}`,
      initial: templateInitial(template),
      fromTemplate: true,
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
        await onCreate(payload);
        if (form.fromTemplate) {
          // Land the user on their new task.
          setSelectedTemplate(null);
          setTab("tasks");
        }
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
      toastError(toast, resume ? "Could not resume the task" : "Could not pause the task", err);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await onDelete(deleteTarget.id);
    } catch (err) {
      toastError(toast, "Could not delete the task", err);
    }
  };

  const runningCount = tasks.filter((t) => taskStatusKind(t) === "running").length;
  const activeCount = tasks.filter((t) => t.status === "active").length;
  const showNewTaskButton = !(tab === "templates" && selectedTemplate);

  let body: React.ReactNode;
  if (tab === "templates") {
    body = (
      <TemplatesGallery
        selected={selectedTemplate}
        onSelect={setSelectedTemplate}
        onUse={openTemplate}
        reduceMotion={reduceMotion}
      />
    );
  } else if (loading && tasks.length === 0) {
    body = (
      <div className="grid gap-3 md:grid-cols-2" aria-label="Loading tasks" aria-busy="true">
        {Array.from({ length: 4 }).map((_, i) => (
          <TaskCardSkeleton key={`task-skeleton-${i}`} />
        ))}
      </div>
    );
  } else if (error && tasks.length === 0) {
    body = <ErrorState message={error} onRetry={onRetry} />;
  } else if (tasks.length === 0) {
    body = <EmptyState onCreate={openCreate} onBrowse={() => setTab("templates")} />;
  } else {
    body = (
      <>
        {error ? (
          <p
            className="mb-3 flex items-center gap-2 rounded-xl bg-destructive/[0.08] px-3 py-2 text-xs text-destructive"
            role="alert"
          >
            <CircleAlert className="h-3.5 w-3.5 flex-shrink-0" aria-hidden />
            {error} Showing the last list we had.
          </p>
        ) : null}
        <motion.div
          layout={reduceMotion ? false : "position"}
          className="grid items-stretch gap-3 md:grid-cols-2"
        >
          <AnimatePresence mode="popLayout" initial>
            {tasks.map((task, index) => (
              <TaskCard
                key={task.id}
                task={task}
                agents={agents}
                now={now}
                index={index}
                reduceMotion={reduceMotion}
                onToggle={handleToggle}
                onEdit={openEdit}
                onDelete={setDeleteTarget}
                onOpenResult={onOpenResult}
              />
            ))}
          </AnimatePresence>
        </motion.div>
      </>
    );
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-full flex-col bg-background">
        {/* Page header — title, tabs, and the primary New task action. */}
        <header className="relative flex-shrink-0 px-4 pb-4 pt-4 sm:px-6 sm:pt-6">
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                {/* On mobile the sidebar is an overlay sheet — once collapsed
                    it's gone, and this page covers ChatHeader's own trigger.
                    Mirror that md:hidden toggle here so there's always a way
                    back to the sidebar from the tasks page. */}
                <SidebarTrigger
                  aria-label="Toggle sidebar"
                  className="inline-flex h-10 w-10 flex-shrink-0 rounded-xl bg-transparent text-foreground transition-colors hover:bg-[hsl(var(--hover-surface))] hover:text-foreground active:bg-[hsl(var(--hover-surface-strong))] focus-visible:ring-2 focus-visible:ring-ring md:hidden [&_svg]:size-5"
                />
                <div className="min-w-0">
                  <h1 className="text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
                    Schedules
                  </h1>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    Agents that run on their own — once, on a repeat, or on a calendar.
                  </p>
                </div>
              </div>
              {showNewTaskButton ? (
                <button type="button" onClick={openCreate} className={PRIMARY_BUTTON}>
                  <Plus className="h-4 w-4" aria-hidden />
                  <span className="max-[380px]:sr-only">New task</span>
                </button>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <PageTabs
                tab={tab}
                onChange={setTab}
                taskCount={tasks.length}
                reduceMotion={reduceMotion}
              />
              {tab === "tasks" && tasks.length > 0 ? (
                <p className="text-xs text-muted-foreground" aria-live="polite">
                  {runningCount > 0 ? (
                    <span className="font-medium text-[hsl(var(--subagent-active))]">
                      {runningCount} running ·{" "}
                    </span>
                  ) : null}
                  {activeCount} active
                </p>
              ) : null}
            </div>
          </div>
        </header>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 sm:px-6">
          <div className="mx-auto w-full max-w-4xl pb-10 pt-2">{body}</div>
        </div>
      </div>

      <TaskFormDialog
        open={form.open}
        mode={form.open ? form.mode : "create"}
        formKey={form.open ? form.key : "closed"}
        agents={agents}
        initial={form.open ? form.initial : undefined}
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
        title="Delete this task?"
        description={
          <>
            <span className="font-medium text-foreground">
              {deleteTarget?.title?.trim() || deleteTarget?.prompt || "This task"}
            </span>{" "}
            stops running. Conversations from earlier runs stay in your chats.
          </>
        }
        confirmLabel="Delete task"
        onConfirm={confirmDelete}
      />
    </TooltipProvider>
  );
}
