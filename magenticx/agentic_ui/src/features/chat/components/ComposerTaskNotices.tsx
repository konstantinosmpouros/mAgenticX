import { useMemo } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Clock3, ShieldAlert, X } from "lucide-react";

import { toTitleCase, useBackgroundTasksContext, waitingTasks } from "@/features/inference";
import type { QueuedMessage } from "@/shared/lib/types";

type ComposerTaskNoticesProps = {
  queuedMessage: QueuedMessage | null;
  onCancelQueued: () => void;
};

// Enter 200ms ease-out, exit at ~65% of it ease-in; transform + opacity only.
const ENTER = { opacity: 1, y: 0, transition: { duration: 0.2, ease: "easeOut" } } as const;
const EXIT = { opacity: 0, y: 4, transition: { duration: 0.13, ease: "easeIn" } } as const;

/**
 * The lines above the composer for the conversation's background work (plan
 * 41): the one queued message (§3.6) as a chip with its cancel, and a prompt
 * per task waiting on an approval (§3.8) — the approval itself lives in the
 * task's drill-down, which the prompt opens, so a waiting task never takes
 * the composer over the way a run's own approval does.
 */
export function ComposerTaskNotices({ queuedMessage, onCancelQueued }: ComposerTaskNoticesProps) {
  const tasks = useBackgroundTasksContext();
  const reduceMotion = useReducedMotion();
  const waiting = useMemo(() => (tasks ? waitingTasks(tasks.tree) : []), [tasks]);
  const initial = reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6 };
  const exit = reduceMotion ? { opacity: 0, transition: { duration: 0.1 } } : EXIT;

  // Each line carries its own bottom margin, so with nothing to show the slot
  // takes no room at all.
  return (
    <div className="flex min-w-0 flex-col">
      <AnimatePresence initial={false}>
        {waiting.map((task) => (
          <motion.div
            key={`approval:${task.taskId}`}
            initial={initial}
            animate={ENTER}
            exit={exit}
            className="mb-2 flex min-w-0 items-center gap-2 rounded-2xl border border-warning/40 bg-card px-3 py-1.5 text-xs shadow-card"
          >
            <ShieldAlert className="h-3.5 w-3.5 flex-shrink-0 text-warning" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-foreground">
              <span className="font-medium">{toTitleCase(task.name)}</span>
              <span className="text-muted-foreground"> is waiting for your approval</span>
            </span>
            <button
              type="button"
              onClick={() => tasks?.openTask(task.taskId)}
              aria-label={`Review ${task.name}'s approval`}
              className="relative min-h-[2rem] flex-shrink-0 rounded-full px-2.5 font-medium text-primary transition-colors duration-150 after:absolute after:-inset-1.5 after:content-[''] hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
            >
              Review
            </button>
          </motion.div>
        ))}
        {queuedMessage ? (
          <motion.div
            key="queued-message"
            initial={initial}
            animate={ENTER}
            exit={exit}
            className="mb-2 flex min-w-0 items-center gap-2 rounded-2xl border border-border/70 bg-card px-3 py-1.5 text-xs shadow-card"
            role="status"
          >
            <Clock3
              className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <span className="flex-shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              Queued
            </span>
            <span className="min-w-0 flex-1 truncate text-foreground" title={queuedMessage.content}>
              {queuedMessage.commandName ? (
                <span className="font-medium text-primary">/{queuedMessage.commandName} </span>
              ) : null}
              {queuedMessage.content ||
                (queuedMessage.attachmentCount
                  ? `${queuedMessage.attachmentCount} file${queuedMessage.attachmentCount === 1 ? "" : "s"}`
                  : "Your message")}
            </span>
            {queuedMessage.attachmentCount && queuedMessage.content ? (
              <span className="hidden flex-shrink-0 text-muted-foreground sm:inline">
                +{queuedMessage.attachmentCount} file
                {queuedMessage.attachmentCount === 1 ? "" : "s"}
              </span>
            ) : null}
            <button
              type="button"
              onClick={onCancelQueued}
              aria-label="Cancel the queued message"
              title="Cancel — it goes back into the composer"
              className="relative flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 after:absolute after:-inset-2 after:content-[''] hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/50"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
