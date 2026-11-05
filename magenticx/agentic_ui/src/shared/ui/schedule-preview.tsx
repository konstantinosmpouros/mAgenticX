/**
 * A schedule editor's live preview card: the cadence in plain words and its
 * next runs (absolute and relative), with an optional note — shared by
 * Automations → Schedules' form and the workflow builder's schedule trigger,
 * which compute it with `schedulePreview` (shared/lib/schedule).
 */
import type { ReactNode } from "react";
import { CalendarClock } from "lucide-react";

import type { SchedulePreviewModel } from "@/shared/lib/types";
import { formatRelative, formatRunTime } from "@/shared/lib/schedule";
import { cn } from "@/shared/lib/utils";

export function SchedulePreview({
  preview,
  now,
  className,
  children,
}: {
  preview: SchedulePreviewModel;
  now: Date;
  className?: string;
  /** Extra lines under the runs (a paused note). */
  children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-2xl border border-primary/20 bg-primary/[0.05] p-3.5",
        className,
      )}
      aria-live="polite"
      data-testid="schedule-preview"
    >
      <div className="flex items-start gap-2.5">
        <span className="grid h-8 w-8 flex-shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
          <CalendarClock className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">{preview.summary}</p>
          {preview.runs.length ? (
            <ol className="mt-2 space-y-1" aria-label="Next runs">
              {preview.runs.map((run, i) => (
                <li key={run.getTime()} className="flex items-center gap-2 text-xs">
                  <span
                    className={cn(
                      "h-1.5 w-1.5 flex-shrink-0 rounded-full",
                      i === 0 ? "bg-primary" : "bg-primary/35",
                    )}
                    aria-hidden
                  />
                  <span className="tabular-nums text-foreground/90">{formatRunTime(run, now)}</span>
                  <span className="text-muted-foreground">{formatRelative(run, now)}</span>
                </li>
              ))}
            </ol>
          ) : null}
          {preview.note ? (
            <p className="mt-1.5 text-[11px] text-muted-foreground">{preview.note}</p>
          ) : null}
          {children}
        </div>
      </div>
    </div>
  );
}
