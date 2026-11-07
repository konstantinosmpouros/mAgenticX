import { CornerDownRight } from "lucide-react";

import { MarkdownRenderer } from "@/shared/ui/markdownRenderer";
import type { TaskInputBlock } from "@/shared/lib/types";

/**
 * In a background task's drill-down: the follow-up its parent sent with
 * `update_async_task` (TASK_INPUT), drawn where the run it started begins — so
 * a continued or clarified task shows what it was asked, not only its answer.
 */
export function TaskInputBlockView({ block }: { block: TaskInputBlock }) {
  return (
    <div className="space-y-1.5">
      <p className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
        <CornerDownRight className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate">Follow-up from the parent agent</span>
      </p>
      <div className="min-w-0 rounded-2xl border border-border/60 bg-muted/40 px-3 py-2 text-sm [overflow-wrap:anywhere]">
        <MarkdownRenderer className="text-sm" content={block.text} />
      </div>
    </div>
  );
}
