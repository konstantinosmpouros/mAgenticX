import * as React from "react";
import { ChevronDown, Wrench } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import type { WorkflowToolCall } from "@/shared/lib/types";
import { toolTitle } from "@/features/chat/lib/toolPresentation";
import {
  ToolCallArgsView,
  ToolCallResultView,
} from "@/features/chat/components/message_parts/ToolCallViews";
import { toTimelineTool } from "@/features/workflows/lib/format";
import { EXECUTION_STATUS_META } from "@/features/workflows/lib/status";
import { StatusChip } from "./StatusChip";

/**
 * An execution's tool calls, one folding row each — the chat's tool title
 * (`toolTitle`) on the row, and inside the chat's own argument and result
 * views (`ToolCallArgsView` / `ToolCallResultView`), fed through an adapter
 * (`toTimelineTool`), so a `write_file` or `execute` here reads exactly as it
 * does in a conversation.
 */
function ToolCallRow({ call, defaultOpen }: { call: WorkflowToolCall; defaultOpen: boolean }) {
  const [open, setOpen] = React.useState(defaultOpen);
  const tool = React.useMemo(() => toTimelineTool(call), [call]);
  const meta = call.error
    ? EXECUTION_STATUS_META.failed
    : tool.state === "output-available"
      ? EXECUTION_STATUS_META.succeeded
      : EXECUTION_STATUS_META.running;
  const bodyId = React.useId();
  return (
    <li className="overflow-hidden rounded-2xl border border-border/70 bg-card">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-controls={bodyId}
        className="flex min-h-[2.75rem] w-full items-center gap-2.5 px-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/60 supports-[hover:hover]:hover:bg-[hsl(var(--hover-surface))]"
      >
        <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-primary/[0.1] text-primary">
          <Wrench className="h-3 w-3" aria-hidden />
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
          {toolTitle(call.name, call.args)}
        </span>
        <StatusChip meta={meta} iconOnly />
        <ChevronDown
          aria-hidden
          className={cn(
            "h-4 w-4 flex-shrink-0 text-muted-foreground transition-transform duration-200",
            !open && "-rotate-90",
          )}
        />
      </button>
      {open ? (
        <div id={bodyId} className="space-y-2 border-t border-border/60 px-3 py-2.5">
          <ToolCallArgsView tool={tool} args={call.args} />
          <ToolCallResultView tool={tool} args={call.args} />
        </div>
      ) : null}
    </li>
  );
}

export function ToolCallList({ calls }: { calls: WorkflowToolCall[] }) {
  if (!calls.length) {
    return (
      <p className="rounded-xl bg-muted/30 px-3 py-2.5 text-xs italic text-muted-foreground">
        No tool calls.
      </p>
    );
  }
  return (
    <ul className="space-y-2" aria-label="Tool calls">
      {calls.map((call) => (
        <ToolCallRow key={call.toolCallId} call={call} defaultOpen={calls.length === 1} />
      ))}
    </ul>
  );
}
