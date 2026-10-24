import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ChevronRight, X } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import { Orb } from "@/shared/ui/orb";
import {
  planProgressLabel,
  type ConversationPlans,
  type PlanAnswer,
} from "@/features/chat/lib/conversationPlans";
import { ComposerPanel } from "../ComposerPanel";
import { Collapse } from "../Collapse";
import { PlanChecklist } from "./PlanChecklist";
import { PlanProgressRing } from "./PlanProgressRing";

// The plan's panel, in the composer panels' shell (../ComposerPanel) beside
// the agent map's: above the composer on a desktop, a bottom sheet on a
// phone, modal. The latest plan leads, open; the plans of earlier answers
// follow, newest first, each folded to its question and its count. Which
// earlier plans are open is kept while the panel is closed.

type PlanPanelProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  plans: ConversationPlans;
  agentName: string;
  /** The button the panel opens from; the panel sits above its composer. */
  anchorRef: React.RefObject<HTMLElement>;
  /** For the button's `aria-controls`. */
  id?: string;
};

export function PlanPanel({ open, onOpenChange, plans, agentName, anchorRef, id }: PlanPanelProps) {
  const contentRef = React.useRef<HTMLDivElement>(null);
  // Earlier plans start folded; the latest starts open. Toggled ids flip that.
  const [toggled, setToggled] = React.useState<Set<string>>(() => new Set());
  const current = plans.current;
  const earlier = React.useMemo(
    () => plans.answers.filter((answer) => answer !== current).reverse(),
    [plans.answers, current],
  );

  const toggle = React.useCallback((answerId: string) => {
    setToggled((existing) => {
      const next = new Set(existing);
      if (next.has(answerId)) next.delete(answerId);
      else next.add(answerId);
      return next;
    });
  }, []);

  return (
    <ComposerPanel
      open={open}
      onOpenChange={onOpenChange}
      anchorRef={anchorRef}
      id={id}
      compact={!current}
      contentRef={contentRef}
      onOpenAutoFocus={(event) => {
        // The list, not the first button: reading starts at the plan.
        event.preventDefault();
        window.requestAnimationFrame(() =>
          contentRef.current
            ?.querySelector<HTMLElement>("[data-plan-view]")
            ?.focus({ preventScroll: true }),
        );
      }}
    >
      <PanelHeader current={current} agentName={agentName} onClose={() => onOpenChange(false)} />
      <div
        data-plan-view
        tabIndex={-1}
        className="scrollbar-muted relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-5 pt-1 focus:outline-none sm:px-5"
      >
        {current ? (
          <>
            <PlanSection
              answer={current}
              open={!toggled.has(current.id)}
              onToggle={() => toggle(current.id)}
            />
            {earlier.length ? (
              <div className="mt-5">
                <p className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/80">
                  Earlier plans
                </p>
                {earlier.map((answer) => (
                  <PlanSection
                    key={answer.id}
                    answer={answer}
                    open={toggled.has(answer.id)}
                    onToggle={() => toggle(answer.id)}
                  />
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <EmptyState agentName={agentName} />
        )}
      </div>
    </ComposerPanel>
  );
}

function PanelHeader({
  current,
  agentName,
  onClose,
}: {
  current: PlanAnswer | null;
  agentName: string;
  onClose: () => void;
}) {
  const working = Boolean(current && current.activeIndex >= 0);
  return (
    <div className="relative flex h-16 flex-shrink-0 items-center gap-3 px-4 sm:px-5">
      {/* The agent the plan belongs to, thinking while a step is being worked on. */}
      <Orb size={38} state={working ? "thinking" : "idle"} className="flex-shrink-0" />
      <div className="min-w-0 flex-1">
        <DialogPrimitive.Title className="text-base font-semibold leading-tight tracking-tight text-foreground">
          Plan
        </DialogPrimitive.Title>
        <p className="truncate text-xs text-muted-foreground tabular-nums">
          {agentName}
          {current ? (
            <>
              {" · "}
              <span className={cn(working && "text-foreground/80")}>
                {planProgressLabel(current)}
              </span>
            </>
          ) : null}
        </p>
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close plan"
        className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground transition-[background-color,color,transform] hover:bg-[hsl(var(--hover-surface))] hover:text-foreground active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}

/** One answer's plan: its question as a toggle, the checklist under it. */
function PlanSection({
  answer,
  open,
  onToggle,
}: {
  answer: PlanAnswer;
  open: boolean;
  onToggle: () => void;
}) {
  const headingId = React.useId();
  const listId = React.useId();
  const done = answer.completed >= answer.total;
  return (
    <section aria-labelledby={headingId} className="pt-1.5">
      <h3 className="m-0">
        <button
          type="button"
          id={headingId}
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          onClick={onToggle}
          className="group/plan flex h-11 w-full cursor-pointer items-center gap-2.5 rounded-xl px-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70 supports-[hover:hover]:hover:bg-[hsl(var(--hover-surface))]"
        >
          <ChevronRight
            aria-hidden
            className={cn(
              "h-4 w-4 flex-shrink-0 text-muted-foreground transition-transform duration-200",
              open && "rotate-90",
            )}
          />
          <span className="flex-shrink-0 rounded-md bg-primary/[0.1] px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-primary">
            Q{answer.number}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm text-foreground/90">
            {answer.question || "Untitled question"}
          </span>
          {answer.live ? (
            <span className="flex flex-shrink-0 items-center gap-1.5 rounded-full bg-[hsl(var(--subagent-active)/0.12)] px-2 py-0.5 text-[11px] font-medium text-[hsl(var(--subagent-active))]">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full rounded-full bg-current opacity-70 motion-safe:animate-ping" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
              </span>
              Live
            </span>
          ) : null}
          <span
            className={cn(
              "flex flex-shrink-0 items-center gap-1.5 text-xs tabular-nums",
              done ? "text-primary" : "text-muted-foreground",
            )}
          >
            <PlanProgressRing
              completed={answer.completed}
              total={answer.total}
              size={14}
              strokeWidth={2}
            />
            <span className="sr-only">
              {answer.completed} of {answer.total} steps done
            </span>
            <span aria-hidden>
              {answer.completed}/{answer.total}
            </span>
          </span>
        </button>
      </h3>
      <Collapse open={open} id={listId}>
        <PlanChecklist
          steps={answer.steps}
          label={`Plan for question ${answer.number}`}
          className="pb-2 pl-1 pr-1 pt-1"
        />
      </Collapse>
    </section>
  );
}

function EmptyState({ agentName }: { agentName: string }) {
  return (
    <div className="flex h-full min-h-[14rem] flex-col items-center justify-center gap-4 px-6 text-center">
      <Orb size={64} state="idle" />
      <div className="max-w-sm space-y-1.5">
        <p className="text-sm font-semibold text-foreground">No plan yet</p>
        <p className="text-sm leading-6 text-muted-foreground">
          When {agentName} breaks a task into steps, its plan appears here and fills in as each step
          is done.
        </p>
      </div>
    </div>
  );
}
