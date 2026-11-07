import { Check, CircleAlert, CircleSlash, Loader2 } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/shared/lib/utils";
import type { AsyncTaskStatus } from "@/shared/lib/types";

// The icon and tone of a task's end, so a line never relies on colour alone.
function outcomeIcon(status: AsyncTaskStatus): { icon: ReactNode; tone: string } {
  if (status === "success") {
    return { icon: <Check className="h-3.5 w-3.5" aria-hidden="true" />, tone: "text-success" };
  }
  if (status === "error") {
    return {
      icon: <CircleAlert className="h-3.5 w-3.5" aria-hidden="true" />,
      tone: "text-destructive",
    };
  }
  if (status === "cancelled") {
    return {
      icon: <CircleSlash className="h-3.5 w-3.5" aria-hidden="true" />,
      tone: "text-muted-foreground",
    };
  }
  return {
    icon: <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden="true" />,
    tone: "text-muted-foreground",
  };
}

type TaskOutcomeLineProps = {
  status: AsyncTaskStatus;
  text: string;
  /** Opens the task's drill-down; without it the line is plain text. */
  onOpen?: () => void;
  /** `center`: the notice row between messages; `start`: inline in an answer. */
  align?: "center" | "start";
};

/**
 * One compact line saying how a background task ended (plan 41): the notice
 * row of a wake-up ("✓ researcher finished · 2m 14s") and the inline marker
 * of a result pulled into a busy run. A button when it can open the task's
 * drill-down, plain text otherwise. Long names truncate; the line never wraps
 * into a bubble.
 */
export function TaskOutcomeLine({ status, text, onOpen, align = "center" }: TaskOutcomeLineProps) {
  const { icon, tone } = outcomeIcon(status);
  const body = (
    <>
      <span className={cn("flex-shrink-0", tone)}>{icon}</span>
      <span className="min-w-0 truncate">{text}</span>
    </>
  );
  const shape =
    "inline-flex min-h-[2rem] max-w-full items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 px-3 py-1 text-xs text-muted-foreground";
  return (
    <div
      className={cn("flex w-full min-w-0", align === "center" ? "justify-center" : "justify-start")}
    >
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          aria-label={`${text} — open the task`}
          className={cn(
            shape,
            "relative transition-colors duration-150 after:absolute after:-inset-1.5 after:content-[''] hover:bg-muted hover:text-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
          )}
        >
          {body}
        </button>
      ) : (
        <span className={shape}>{body}</span>
      )}
    </div>
  );
}
