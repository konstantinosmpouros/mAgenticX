import * as React from "react";
import { motion, useReducedMotion } from "framer-motion";
import {
  AlertCircle,
  ArrowLeft,
  Building2,
  ExternalLink,
  Loader2,
  Pause,
  Pencil,
  Play,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { MdOutlineSchedule } from "react-icons/md";

import type {
  Agent,
  ScheduledTask,
  ScheduledTaskCreatePayload,
  ScheduledTaskUpdatePayload,
  ToolPreference,
} from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/shared/ui/tooltip";
import { SidebarTrigger } from "@/shared/ui/sidebar";
import ScheduledTaskForm, {
  type ScheduledTaskFormInitial,
} from "@/components/chat/scheduled_tasks_parts/ScheduledTaskForm";
import {
  TASK_TEMPLATES,
  type ScheduledTaskTemplate,
} from "@/components/chat/scheduled_tasks_parts/templates";

type ScheduledTasksPageProps = {
  onClose: () => void;
  tasks: ScheduledTask[];
  loading: boolean;
  error?: string | null;
  agents: Agent[];
  defaultEnabledTools?: ToolPreference[];
  onCreate: (payload: ScheduledTaskCreatePayload) => Promise<ScheduledTask>;
  onUpdate: (taskId: string, payload: ScheduledTaskUpdatePayload) => Promise<ScheduledTask>;
  onDelete: (taskId: string) => Promise<void>;
  onOpenResult: (conversationId: string, agentId?: string | null) => void;
};

const RUNNING_STATUSES = new Set(["queued", "running", "cancelling"]);

// schedule_spec stores run_at as naive-UTC ISO (no offset); parse it as UTC.
const parseMaybeUtc = (value: string): Date =>
  new Date(/[Z+]/.test(value) ? value : `${value}Z`);

const fmt = (date: Date | null | undefined): string =>
  date
    ? date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : "—";

const humanizeSeconds = (seconds: number): string => {
  if (seconds % 86400 === 0) {
    const d = seconds / 86400;
    return d === 1 ? "day" : `${d} days`;
  }
  if (seconds % 3600 === 0) {
    const h = seconds / 3600;
    return h === 1 ? "hour" : `${h} hours`;
  }
  const m = Math.round(seconds / 60);
  return m === 1 ? "minute" : `${m} minutes`;
};

const describeSchedule = (task: ScheduledTask): string => {
  const spec = task.scheduleSpec ?? {};
  if (task.scheduleKind === "interval") return `Every ${humanizeSeconds(Number(spec.interval_seconds) || 0)}`;
  if (task.scheduleKind === "cron") return `Cron ${spec.cron_expr ?? ""}${task.timezone ? ` · ${task.timezone}` : ""}`;
  if (task.scheduleKind === "one_off") return spec.run_at ? `Once · ${fmt(parseMaybeUtc(String(spec.run_at)))}` : "Once";
  return "";
};

type StatusMeta = { label: string; dotClassName: string; pillClassName: string; spinning: boolean };

const statusMeta = (task: ScheduledTask): StatusMeta => {
  const live = String(task.liveStatus ?? "");
  if (RUNNING_STATUSES.has(live)) {
    return {
      label: "Running",
      dotClassName: "bg-primary",
      pillClassName: "bg-primary/10 text-primary",
      spinning: true,
    };
  }
  if (task.status === "paused") {
    return {
      label: "Paused",
      dotClassName: "bg-muted-foreground/60",
      pillClassName: "bg-muted text-muted-foreground",
      spinning: false,
    };
  }
  if (task.status === "failed") {
    return {
      label: "Failed",
      dotClassName: "bg-destructive",
      pillClassName: "bg-destructive/10 text-destructive",
      spinning: false,
    };
  }
  if (task.status === "completed") {
    return {
      label: "Done",
      dotClassName: "bg-muted-foreground/60",
      pillClassName: "bg-muted text-muted-foreground",
      spinning: false,
    };
  }
  if (live === "failed") {
    return {
      label: "Last run failed",
      dotClassName: "bg-destructive",
      pillClassName: "bg-destructive/10 text-destructive",
      spinning: false,
    };
  }
  return {
    label: "Active",
    dotClassName: "bg-primary",
    pillClassName: "bg-primary/10 text-primary",
    spinning: false,
  };
};

const targetModeLabel = (mode: string): string =>
  mode === "bound" ? "One ongoing chat" : "New chat each run";

const ListSkeleton = () => (
  <div className="grid gap-3 sm:grid-cols-2" aria-label="Loading tasks">
    {Array.from({ length: 4 }).map((_, i) => (
      <div key={`task-skeleton-${i}`} className="space-y-3 rounded-2xl bg-muted/30 p-4">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-background/60" />
          <div className="flex-1 space-y-2">
            <div className="h-3.5 w-1/2 rounded-full bg-background/70" />
            <div className="h-3 w-3/4 rounded-full bg-background/50" />
          </div>
        </div>
        <div className="h-3 w-2/5 rounded-full bg-background/40" />
      </div>
    ))}
  </div>
);

// An icon-only action button with a styled hover tooltip, matching the sidebar.
function ActionButton({
  label,
  onClick,
  disabled,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={onClick}
          disabled={disabled}
          className={cn(
            "grid h-8 w-8 place-items-center rounded-lg text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
            danger
              ? "hover:bg-destructive/10 hover:text-destructive"
              : "hover:bg-background hover:text-foreground",
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

function ScheduledTaskRow({
  task,
  agents,
  onUpdate,
  onDelete,
  onOpenResult,
  onEdit,
  index,
  reduceMotion,
}: {
  task: ScheduledTask;
  agents: Agent[];
  onUpdate: ScheduledTasksPageProps["onUpdate"];
  onDelete: ScheduledTasksPageProps["onDelete"];
  onOpenResult: ScheduledTasksPageProps["onOpenResult"];
  onEdit: (task: ScheduledTask) => void;
  index: number;
  reduceMotion: boolean;
}) {
  const [busy, setBusy] = React.useState(false);
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);
  const meta = statusMeta(task);
  const isPaused = task.status === "paused";
  const canToggle = task.status === "active" || task.status === "paused" || task.status === "failed";
  const resultConversationId = task.lastRunConversationId;
  const AgentIcon = agents.find((agent) => agent.id === task.agentId)?.icon ?? Building2;

  const toggle = async () => {
    setBusy(true);
    try {
      await onUpdate(task.id, { status: isPaused ? "active" : "paused" });
    } catch {
      /* surfaced by the page-level error path on next refresh */
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    setBusy(true);
    try {
      await onDelete(task.id);
    } catch {
      setBusy(false);
      setConfirmingDelete(false);
    }
  };

  return (
    <motion.div
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
      animate={reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: "easeOut", delay: Math.min(index, 8) * 0.04 }}
      className="group flex flex-col gap-3 rounded-2xl bg-muted/30 p-4 ring-1 ring-inset ring-border/40 transition-colors hover:bg-muted/50"
    >
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-background/70 text-primary">
          <AgentIcon className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-foreground">
            {task.title?.trim() || task.prompt || "Untitled task"}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {task.agentName || "Agent"} · {describeSchedule(task)}
          </div>
        </div>
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium",
            meta.pillClassName,
          )}
        >
          {meta.spinning ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <span className={cn("h-1.5 w-1.5 rounded-full", meta.dotClassName)} />
          )}
          {meta.label}
        </span>
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-border/40 pt-3">
        <div className="min-w-0 text-xs text-muted-foreground">
          {task.status === "active" && task.nextRunAt ? (
            <span>Next run {fmt(task.nextRunAt)}</span>
          ) : task.lastRunAt ? (
            <span>Last run {fmt(task.lastRunAt)}</span>
          ) : (
            <span>Not run yet</span>
          )}
          {task.lastError ? (
            <span className="ml-1 inline-flex items-center gap-1 text-destructive">
              <AlertCircle className="h-3 w-3" />
              <span className="truncate">{task.lastError}</span>
            </span>
          ) : null}
        </div>

        {confirmingDelete ? (
          <div className="flex shrink-0 items-center gap-1">
            <span className="text-xs text-muted-foreground">Delete?</span>
            <button
              type="button"
              onClick={confirmDelete}
              disabled={busy}
              className="rounded-lg px-2 py-1 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Yes
            </button>
            <button
              type="button"
              onClick={() => setConfirmingDelete(false)}
              disabled={busy}
              className="rounded-lg px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              No
            </button>
          </div>
        ) : (
          <div className="flex shrink-0 items-center gap-0.5">
            <ActionButton label="Edit" onClick={() => onEdit(task)}>
              <Pencil className="h-4 w-4" />
            </ActionButton>
            {resultConversationId ? (
              <ActionButton
                label="Open latest result"
                onClick={() => onOpenResult(resultConversationId, task.agentId)}
              >
                <ExternalLink className="h-4 w-4" />
              </ActionButton>
            ) : null}
            {canToggle ? (
              <ActionButton label={isPaused ? "Resume" : "Pause"} onClick={toggle} disabled={busy}>
                {isPaused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
              </ActionButton>
            ) : null}
            <ActionButton label="Delete" onClick={() => setConfirmingDelete(true)} disabled={busy} danger>
              <Trash2 className="h-4 w-4" />
            </ActionButton>
          </div>
        )}
      </div>
    </motion.div>
  );
}

function TemplateCard({
  template,
  onOpen,
  index,
  reduceMotion,
}: {
  template: ScheduledTaskTemplate;
  onOpen: () => void;
  index: number;
  reduceMotion: boolean;
}) {
  const Icon = template.icon;
  return (
    <motion.button
      type="button"
      onClick={onOpen}
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
      animate={reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: "easeOut", delay: Math.min(index, 8) * 0.04 }}
      whileTap={reduceMotion ? undefined : { scale: 0.99 }}
      className="group flex h-full flex-col gap-3 rounded-2xl bg-muted/30 p-4 text-left ring-1 ring-inset ring-border/40 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-background/70 text-primary transition-colors group-hover:bg-background">
        <Icon className="h-5 w-5" />
      </span>
      <div className="text-sm font-semibold leading-snug text-foreground">{template.label}</div>
      <p className="line-clamp-2 text-xs text-muted-foreground">{template.description}</p>
      <div className="mt-auto inline-flex items-center gap-1.5 pt-1 text-[11px] font-medium text-muted-foreground">
        <MdOutlineSchedule className="h-3.5 w-3.5" />
        {template.scheduleLabel}
      </div>
    </motion.button>
  );
}

function TemplateDetail({
  template,
  onBack,
  onUse,
}: {
  template: ScheduledTaskTemplate;
  onBack: () => void;
  onUse: () => void;
}) {
  const Icon = template.icon;
  const detailRows: [string, string][] = [
    ["Repeats", template.scheduleLabel],
    ["Results", targetModeLabel(template.targetMode)],
    ["Agent", "Chosen on import"],
    ["Tools", "Your current tools"],
  ];
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-6">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1 rounded-lg text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ArrowLeft className="h-4 w-4" />
        Templates
      </button>

      <div className="mt-5 flex items-center gap-4">
        <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Icon className="h-7 w-7" />
        </span>
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-foreground">{template.label}</h2>
          <p className="text-sm text-muted-foreground">{template.description}</p>
        </div>
      </div>

      <div className="mt-6 rounded-2xl bg-muted/30 p-5 ring-1 ring-inset ring-border/40">
        <p className="whitespace-pre-line text-sm leading-relaxed text-foreground/90">
          {template.instructions}
        </p>
      </div>

      <div className="mt-5">
        <p className="text-[0.68rem] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
          Details
        </p>
        <div className="mt-3 divide-y divide-border/40 overflow-hidden rounded-2xl bg-muted/30 ring-1 ring-inset ring-border/40">
          {detailRows.map(([label, value]) => (
            <div key={label} className="flex items-center justify-between px-5 py-3 text-sm">
              <span className="text-muted-foreground">{label}</span>
              <span className="font-medium text-foreground">{value}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-6">
        <button
          type="button"
          onClick={onUse}
          className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Plus className="h-4 w-4" />
          Use this template
        </button>
      </div>
    </div>
  );
}

// A segmented pill control for switching between My Tasks and Templates.
function SegmentedTabs({
  tab,
  onChange,
}: {
  tab: "tasks" | "templates";
  onChange: (tab: "tasks" | "templates") => void;
}) {
  const options: [("tasks" | "templates"), string][] = [
    ["tasks", "My Tasks"],
    ["templates", "Templates"],
  ];
  return (
    <div className="inline-flex items-center gap-1 rounded-full bg-muted/50 p-1">
      {options.map(([value, label]) => {
        const active = tab === value;
        return (
          <button
            key={value}
            type="button"
            onClick={() => onChange(value)}
            aria-pressed={active}
            className={cn(
              "rounded-full px-4 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

function templateInitial(template: ScheduledTaskTemplate): ScheduledTaskFormInitial {
  // No agentId/enabledTools — the form defaults the agent and seeds the user's current tools.
  return {
    title: template.label,
    prompt: template.instructions,
    targetMode: template.targetMode,
    scheduleKind: template.scheduleKind,
    scheduleSpec: template.scheduleSpec,
  };
}

export default function ScheduledTasksPage({
  onClose,
  tasks,
  loading,
  error,
  agents,
  defaultEnabledTools,
  onCreate,
  onUpdate,
  onDelete,
  onOpenResult,
}: ScheduledTasksPageProps) {
  const reduceMotion = useReducedMotion() ?? false;
  const [tab, setTab] = React.useState<"tasks" | "templates">("tasks");
  const [taskView, setTaskView] = React.useState<"list" | "create" | "edit">("list");
  const [editingTask, setEditingTask] = React.useState<ScheduledTask | null>(null);
  const [templateView, setTemplateView] = React.useState<"grid" | "detail" | "use">("grid");
  const [selectedTemplate, setSelectedTemplate] = React.useState<ScheduledTaskTemplate | null>(null);
  const [templateQuery, setTemplateQuery] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  // Escape backs out of a sub-view, or closes the page from the top level.
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (tab === "tasks" && taskView !== "list") {
        setTaskView("list");
        setEditingTask(null);
      } else if (tab === "templates" && templateView !== "grid") {
        setTemplateView("grid");
        setSelectedTemplate(null);
      } else {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [tab, taskView, templateView, onClose]);

  const handleCreate = async (payload: ScheduledTaskCreatePayload) => {
    setSubmitting(true);
    try {
      await onCreate(payload);
      setTaskView("list");
    } catch {
      /* keep the form inputs; the list refreshes on the next poll */
    } finally {
      setSubmitting(false);
    }
  };

  const handleUpdate = async (payload: ScheduledTaskCreatePayload) => {
    if (!editingTask) return;
    setSubmitting(true);
    try {
      await onUpdate(editingTask.id, payload);
      setTaskView("list");
      setEditingTask(null);
    } catch {
      /* keep the form open on failure */
    } finally {
      setSubmitting(false);
    }
  };

  const handleUseTemplate = async (payload: ScheduledTaskCreatePayload) => {
    setSubmitting(true);
    try {
      await onCreate(payload);
      // Land the user on their new task.
      setTemplateView("grid");
      setSelectedTemplate(null);
      setTaskView("list");
      setTab("tasks");
    } catch {
      /* keep the form open on failure */
    } finally {
      setSubmitting(false);
    }
  };

  const startEdit = (task: ScheduledTask) => {
    setEditingTask(task);
    setTaskView("edit");
  };

  const filteredTemplates = React.useMemo(() => {
    const q = templateQuery.trim().toLowerCase();
    if (!q) return TASK_TEMPLATES;
    return TASK_TEMPLATES.filter((t) =>
      [t.label, t.description, t.instructions].some((field) => field.toLowerCase().includes(q)),
    );
  }, [templateQuery]);

  // The page header shows tabs + the New task action only at the top level of
  // each tab; sub-views (create/edit/detail/use) carry their own back/cancel.
  const inTaskSubView = tab === "tasks" && taskView !== "list";
  const inTemplateSubView = tab === "templates" && templateView !== "grid";
  const inSubView = inTaskSubView || inTemplateSubView;
  const showNewTaskButton = tab === "tasks" && taskView === "list";

  return (
    <TooltipProvider delayDuration={0}>
      <div className="flex h-full flex-col bg-background">
        {/* Page header — title, tabs, and the primary New task action. */}
        <div className="border-b border-border/60 px-4 py-4 sm:px-6">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                {/* On mobile the sidebar is an overlay sheet — once collapsed
                    it's gone, and this page covers ChatHeader's own trigger.
                    Mirror that md:hidden toggle here so there's always a way
                    back to the sidebar from the tasks page. */}
                <SidebarTrigger
                  aria-label="Toggle sidebar"
                  className="inline-flex h-10 w-10 shrink-0 rounded-xl bg-transparent text-foreground transition-colors hover:bg-[hsl(var(--hover-surface))] hover:text-foreground active:bg-[hsl(var(--hover-surface-strong))] focus-visible:ring-2 focus-visible:ring-ring md:hidden [&_svg]:size-5"
                />
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                  <MdOutlineSchedule className="h-5 w-5" />
                </span>
                <div>
                  <h1 className="text-lg font-semibold leading-tight text-foreground">
                    Scheduled tasks
                  </h1>
                  <p className="text-xs text-muted-foreground">
                    Let an agent run on its own — once, on an interval, or on a cron.
                  </p>
                </div>
              </div>
              {showNewTaskButton ? (
                <button
                  type="button"
                  onClick={() => setTaskView("create")}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-primary px-3 py-2 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Plus className="h-4 w-4" />
                  New task
                </button>
              ) : null}
            </div>
            {!inSubView ? <SegmentedTabs tab={tab} onChange={setTab} /> : null}
          </div>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {tab === "tasks" ? (
            taskView === "create" || taskView === "edit" ? (
              <div className="mx-auto w-full max-w-2xl">
                <ScheduledTaskForm
                  agents={agents}
                  defaultEnabledTools={defaultEnabledTools}
                  initial={taskView === "edit" ? editingTask ?? undefined : undefined}
                  submitLabel={taskView === "edit" ? "Save changes" : "Create task"}
                  submitting={submitting}
                  onSubmit={taskView === "edit" ? handleUpdate : handleCreate}
                  onCancel={() => {
                    setTaskView("list");
                    setEditingTask(null);
                  }}
                />
              </div>
            ) : (
              <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
                {loading && tasks.length === 0 ? (
                  <ListSkeleton />
                ) : error ? (
                  <div className="flex min-h-[12rem] items-center justify-center px-6 text-center text-sm text-destructive">
                    {error}
                  </div>
                ) : tasks.length === 0 ? (
                  <div className="flex min-h-[20rem] flex-col items-center justify-center gap-4 px-6 text-center">
                    <span className="flex h-16 w-16 items-center justify-center rounded-3xl bg-muted/40 text-muted-foreground">
                      <MdOutlineSchedule className="h-8 w-8" />
                    </span>
                    <div className="space-y-1.5">
                      <div className="text-base font-semibold text-foreground">No scheduled tasks yet</div>
                      <p className="mx-auto max-w-sm text-sm text-muted-foreground">
                        Schedule an agent to run on its own and it completes while you're away. Start
                        from scratch or pick a template.
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setTaskView("create")}
                        className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <Plus className="h-4 w-4" />
                        New task
                      </button>
                      <button
                        type="button"
                        onClick={() => setTab("templates")}
                        className="inline-flex items-center gap-1.5 rounded-xl bg-muted/50 px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        Browse templates
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {tasks.map((task, index) => (
                      <ScheduledTaskRow
                        key={task.id}
                        task={task}
                        agents={agents}
                        onUpdate={onUpdate}
                        onDelete={onDelete}
                        onOpenResult={onOpenResult}
                        onEdit={startEdit}
                        index={index}
                        reduceMotion={reduceMotion}
                      />
                    ))}
                  </div>
                )}
              </div>
            )
          ) : templateView === "use" && selectedTemplate ? (
            <div className="mx-auto w-full max-w-2xl">
              <ScheduledTaskForm
                agents={agents}
                defaultEnabledTools={defaultEnabledTools}
                initial={templateInitial(selectedTemplate)}
                submitLabel="Create task"
                submitting={submitting}
                onSubmit={handleUseTemplate}
                onCancel={() => setTemplateView("detail")}
              />
            </div>
          ) : templateView === "detail" && selectedTemplate ? (
            <TemplateDetail
              template={selectedTemplate}
              onBack={() => {
                setTemplateView("grid");
                setSelectedTemplate(null);
              }}
              onUse={() => setTemplateView("use")}
            />
          ) : (
            <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={templateQuery}
                  onChange={(event) => setTemplateQuery(event.target.value)}
                  placeholder="Search templates"
                  className="h-11 w-full rounded-xl bg-muted/40 pl-10 pr-3 text-sm text-foreground outline-none ring-1 ring-inset ring-border/40 transition focus-visible:ring-2 focus-visible:ring-ring placeholder:text-muted-foreground"
                  spellCheck={false}
                />
              </div>

              <p className="mt-6 text-[0.68rem] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                System
              </p>
              <div className="mt-3">
                {filteredTemplates.length === 0 ? (
                  <div className="rounded-2xl bg-muted/30 py-10 text-center text-sm text-muted-foreground ring-1 ring-inset ring-border/40">
                    No matching templates.
                  </div>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {filteredTemplates.map((template, index) => (
                      <TemplateCard
                        key={template.id}
                        template={template}
                        index={index}
                        reduceMotion={reduceMotion}
                        onOpen={() => {
                          setSelectedTemplate(template);
                          setTemplateView("detail");
                        }}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}
