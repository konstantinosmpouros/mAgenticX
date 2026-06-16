import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  CheckCircle2,
  Circle,
  ListTodo,
  LoaderCircle,
  Sparkles,
} from "lucide-react";

import { ScrollArea } from "@/components/ui/scroll-area";
import type { PlanItemStatus, PlanSnapshot } from "@/runtime/agui";
import { cn } from "@/lib/utils";

const STATUS_STYLES: Record<
  PlanItemStatus,
  {
    icon: React.ComponentType<{ className?: string }>;
    badge: string;
    tone: string;
    dot: string;
    label: string;
  }
> = {
  pending: {
    icon: Circle,
    badge: "border-border/80 bg-muted/70 text-muted-foreground",
    tone: "text-muted-foreground",
    dot: "bg-muted-foreground/65",
    label: "Pending",
  },
  in_progress: {
    icon: LoaderCircle,
    badge: "border-sky-500/30 bg-sky-500/12 text-sky-500",
    tone: "text-sky-500",
    dot: "bg-sky-500",
    label: "In progress",
  },
  completed: {
    icon: CheckCircle2,
    badge: "border-emerald-500/30 bg-emerald-500/12 text-emerald-500",
    tone: "text-emerald-500",
    dot: "bg-emerald-500",
    label: "Completed",
  },
};

function PlanSummary({
  plan,
  title,
  subtitle,
}: {
  plan: PlanSnapshot;
  title: string;
  subtitle?: string;
}) {
  const updatedLabel =
    typeof plan.updated_at === "number"
      ? new Date(plan.updated_at).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        })
      : null;

  return (
    <div className="min-w-0">
      {subtitle ? (
        <div className="mb-1.5 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
          <Sparkles className="h-3 w-3 text-primary" />
          {subtitle}
        </div>
      ) : null}
      <div className="flex items-center gap-2.5">
        <div className="flex h-8 w-8 items-center justify-center rounded-xl border border-border bg-secondary/55 text-primary transition-colors duration-500 ease-out">
          <ListTodo className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-foreground">
            {title}
          </h3>
          <p className="truncate text-[11px] text-muted-foreground transition-colors duration-500 ease-out">
            {plan.items.length} steps
            {updatedLabel ? ` · updated ${updatedLabel}` : ""}
          </p>
        </div>
      </div>
    </div>
  );
}

function PlanCounts({ plan }: { plan: PlanSnapshot }) {
  const completedCount = plan.items.filter((item) => item.status === "completed").length;
  const inProgressCount = plan.items.filter((item) => item.status === "in_progress").length;
  const pendingCount = plan.items.filter((item) => item.status === "pending").length;

  return (
    <div className="hidden shrink-0 items-center gap-2 self-start rounded-full bg-secondary/45 px-2.5 py-1 transition-colors duration-500 ease-out sm:mt-1 sm:flex">
      <span className="inline-flex h-2 w-2 rounded-full bg-emerald-500" />
      <span className="text-[11px] text-muted-foreground">{completedCount}</span>
      <span className="inline-flex h-2 w-2 rounded-full bg-sky-500" />
      <span className="text-[11px] text-muted-foreground">{inProgressCount}</span>
      <span className="inline-flex h-2 w-2 rounded-full bg-muted-foreground/65" />
      <span className="text-[11px] text-muted-foreground">{pendingCount}</span>
    </div>
  );
}

export function PlanItems({ plan }: { plan: PlanSnapshot }) {
  return (
    <div className="space-y-1.5 px-1 py-2">
      {plan.items.map((item, index) => {
        const { icon: StatusIcon, badge, tone, dot, label } = STATUS_STYLES[item.status];
        return (
          <div
            key={`plan-item-${index}`}
            className={cn(
              "flex items-start gap-2 rounded-xl border px-2.5 py-2 transition-colors duration-200 ease-out",
              item.status === "completed"
                ? "border-emerald-500/18 bg-emerald-500/[0.05]"
                : item.status === "in_progress"
                  ? "border-sky-500/18 bg-sky-500/[0.05]"
                  : "border-border/70 bg-secondary/30"
            )}
          >
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-background transition-colors duration-200 ease-out">
              <div className="relative flex h-3.5 w-3.5 items-center justify-center">
                <AnimatePresence mode="wait" initial={false}>
                  <motion.div
                    key={`icon-${index}-${item.status}`}
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 1.08 }}
                    transition={{ duration: 0.34, ease: "easeOut" }}
                    className="absolute inset-0 flex items-center justify-center"
                  >
                    <StatusIcon
                      className={cn(
                        "h-3.5 w-3.5 transition-colors duration-200 ease-out",
                        tone,
                        item.status === "in_progress" && "animate-spin [animation-duration:1.8s]"
                      )}
                    />
                  </motion.div>
                </AnimatePresence>
              </div>
            </div>

            <div className="min-w-0 flex-1">
              <div className="mb-1 flex items-center gap-2">
                <div className="relative h-2 w-2 shrink-0">
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.span
                      key={`dot-${index}-${item.status}`}
                      initial={{ opacity: 0, scale: 0.6 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 1.2 }}
                      transition={{ duration: 0.34, ease: "easeOut" }}
                      className={cn("absolute inset-0 inline-flex rounded-full", dot)}
                    />
                  </AnimatePresence>
                </div>
                <div className="relative">
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.span
                      key={`label-${index}-${item.status}`}
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -4 }}
                      transition={{ duration: 0.34, ease: "easeOut" }}
                      className={cn(
                        "inline-flex rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors duration-200 ease-out",
                        badge
                      )}
                    >
                      {label}
                    </motion.span>
                  </AnimatePresence>
                </div>
              </div>
              <div className="relative">
                <AnimatePresence mode="wait" initial={false}>
                  <motion.p
                    key={`content-${index}-${item.content}`}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.42, ease: "easeOut" }}
                    className="text-[12.5px] leading-[1.35rem] text-foreground transition-colors duration-200 ease-out"
                  >
                    {item.content}
                  </motion.p>
                </AnimatePresence>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export type PlanCardProps = {
  plan: PlanSnapshot;
  expanded: boolean;
  onToggle: () => void;
  className?: string;
  title?: string;
  subtitle?: string;
};

export function PlanCard({
  plan,
  expanded,
  onToggle,
  className,
  title = "Agent plan",
  subtitle,
}: PlanCardProps) {
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onToggle();
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      onClick={onToggle}
      onKeyDown={handleKeyDown}
      className={cn(
        "group relative block w-full cursor-pointer select-none text-left outline-none",
        className
      )}
    >
      <div className="absolute inset-x-12 top-2 h-10 rounded-full bg-[hsl(var(--primary)/0.1)] blur-3xl transition-opacity duration-300 group-hover:opacity-90" />

      <div className="relative overflow-hidden rounded-t-[22px] border border-b-0 border-border bg-background shadow-lg">
        <div className="absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-primary/[0.04] to-transparent" />

        <div className="relative flex flex-col">
          <div
            className={cn(
              "flex items-start justify-between gap-3 px-3.5 py-3",
              expanded && "border-b border-border/70"
            )}
          >
            <PlanSummary plan={plan} title={title} subtitle={subtitle} />
            <PlanCounts plan={plan} />
          </div>

          <div
            className={cn(
              "overflow-hidden transition-[height,opacity] duration-300 ease-out",
              expanded ? "h-[184px] opacity-100" : "h-0 opacity-0"
            )}
          >
            <ScrollArea
              className="h-full px-2.5"
              onClick={(event) => event.stopPropagation()}
            >
              <PlanItems plan={plan} />
            </ScrollArea>
          </div>
        </div>
      </div>
    </div>
  );
}

