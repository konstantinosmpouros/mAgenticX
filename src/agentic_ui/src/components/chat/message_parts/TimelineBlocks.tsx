import { memo, useMemo, useState } from "react";
import {
  Check,
  CheckCircle2,
  CircleSlash,
  Clock,
  ShieldQuestion,
  ShieldX,
  Wrench,
  X,
  XCircle,
} from "lucide-react";
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtStep,
} from "@/components/ui/ai-elements/chain-of-thought";
import { ToolInput, ToolOutput } from "@/components/ui/ai-elements/tool";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Response } from "@/components/ui/ai-elements/response";
import { ShimmeringText } from "@/components/ui/shadcn-io/shimmering-text";
import { MarkdownRenderer } from "@/components/ui/markdownRenderer";
import { SubagentCard } from "./SubagentContainer";
import { subagentBlockToItem } from "@/lib/timeline";
import { useHitl } from "@/lib/hitl-context";
import { cn, normalizeBulletMarkdown, parseHitlInterrupt } from "@/lib/utils";
import type {
  ContentBlock,
  ThinkingBlock,
  TimelineBlock,
  TimelineHitlApproval,
  TimelineTerminalStatus,
  TimelineToolExecution,
  RunTimeline,
} from "@/lib/types";

// Renderers for the derived run timeline: the AI message body is the block
// sequence [Thinking, Content, Subagent, Content, …] exactly as the reducer
// folded it from the event log — the structure mirrors how the model worked.

export const formatThinkingDuration = (seconds?: number | null) => {
  if (typeof seconds !== "number" || Number.isNaN(seconds) || seconds < 0) {
    return null;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`;
};

const blockDurationSeconds = (block: ThinkingBlock): number | null => {
  if (typeof block.startedAt !== "number" || typeof block.endedAt !== "number") return null;
  const seconds = (block.endedAt - block.startedAt) / 1000;
  return seconds >= 0 ? seconds : null;
};

const toolDurationLabel = (tool: TimelineToolExecution): string | undefined => {
  if (typeof tool.startedAt !== "number" || typeof tool.endedAt !== "number") return undefined;
  const ms = tool.endedAt - tool.startedAt;
  if (ms < 0) return undefined;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
};

// TOOL_CALL_ARGS deltas concatenate into a JSON document {"name", "args"} —
// surface just the args once the JSON is complete, the raw text while it
// still streams.
const parseToolArgs = (argsText: string): unknown => {
  const trimmed = argsText.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && "args" in (parsed as Record<string, unknown>)) {
      return (parsed as Record<string, unknown>).args;
    }
    return parsed;
  } catch {
    return trimmed;
  }
};

const RunningToolIcon = ({ className }: { className?: string }) => (
  <Clock className={cn("animate-pulse", className)} />
);

const PendingApprovalIcon = ({ className }: { className?: string }) => (
  <ShieldQuestion className={cn("animate-pulse", className)} />
);

// The approval lifecycle lives on the tool step itself: one row tells the
// whole story — proposed (needs approval), approved + executed (result in the
// same step), or rejected (never ran).
type ToolApprovalFace = "pending" | "decision-sent" | "approved" | "rejected" | null;

const toolStepIcon = (tool: TimelineToolExecution, face: ToolApprovalFace) => {
  if (face === "pending") return PendingApprovalIcon;
  if (face === "rejected") return ShieldX;
  if (tool.state === "output-error") return XCircle;
  if (tool.state === "output-available") return Wrench;
  return RunningToolIcon;
};

const TimelineToolItem = memo(
  ({ tool, runId, isLast }: { tool: TimelineToolExecution; runId: string; isLast: boolean }) => {
    const [open, setOpen] = useState(false);
    const hitl = useHitl();
    const args = useMemo(() => parseToolArgs(tool.argsText), [tool.argsText]);
    const duration = toolDurationLabel(tool);

    const approval = tool.approval;
    const clientResolved =
      approval && hitl ? hitl.isInterruptResolved(runId, approval.id) : false;
    const face: ToolApprovalFace = !approval
      ? null
      : approval.status === "pending"
        ? clientResolved
          ? "decision-sent"
          : "pending"
        : approval.status;

    return (
      <Collapsible open={open} onOpenChange={setOpen}>
        <ChainOfThoughtStep
          icon={toolStepIcon(tool, face)}
          hideConnector={isLast}
          className={cn(
            "text-sm",
            tool.state === "output-error" && "text-destructive",
            face === "pending" && "text-amber-500",
            face === "rejected" && "text-orange-500",
          )}
          label={
            <CollapsibleTrigger
              className="flex max-w-full items-center gap-2 text-left transition-colors hover:text-foreground"
              aria-label={`Toggle ${tool.name} details`}
            >
              <span className="truncate font-medium">{tool.name}</span>
              {duration ? (
                <span className="shrink-0 text-muted-foreground text-xs tabular-nums">{duration}</span>
              ) : null}
              {face === "pending" ? (
                <span className="shrink-0 text-amber-500 text-xs font-medium">Needs approval</span>
              ) : face === "decision-sent" ? (
                <span className="shrink-0 text-muted-foreground text-xs">Decision sent</span>
              ) : face === "approved" ? (
                <span className="flex shrink-0 items-center gap-1 text-emerald-500 text-xs font-medium">
                  <Check className="size-3" />
                  Approved
                </span>
              ) : face === "rejected" ? (
                <span className="shrink-0 text-orange-500 text-xs font-medium">Rejected</span>
              ) : null}
            </CollapsibleTrigger>
          }
        >
          <CollapsibleContent className="space-y-3 outline-none data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 data-[state=closed]:animate-out data-[state=open]:animate-in">
            {args !== null && args !== undefined ? <ToolInput input={args} /> : null}
            {face === "pending" ? (
              <div className="rounded-md border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 text-amber-500 text-xs">
                Waiting for your approval — respond in the bar below.
              </div>
            ) : null}
            {face === "rejected" ? (
              <div className="rounded-md border border-orange-500/25 bg-orange-500/[0.06] px-3 py-2 text-orange-500 text-xs">
                Rejected by you{approval?.reason ? ` — ${approval.reason}` : ""}. The tool never ran.
              </div>
            ) : null}
            <ToolOutput output={tool.result} truncated={tool.resultTruncated} />
          </CollapsibleContent>
        </ChainOfThoughtStep>
      </Collapsible>
    );
  },
);
TimelineToolItem.displayName = "TimelineToolItem";

// Resolved-only record of an approval inside the Thinking block. While the
// interrupt is PENDING the timeline shows nothing — the input-bar takeover is
// the one and only approval surface (the open block's header already reads
// "Waiting for approval…"). Once resolved, this compact record keeps the
// decision visible in the settled conversation's history.
const TimelineHitlItem = memo(
  ({ approval, runId, isLast }: { approval: TimelineHitlApproval; runId: string; isLast: boolean }) => {
    const hitl = useHitl();
    const clientResolved = hitl ? hitl.isInterruptResolved(runId, approval.id) : false;
    const parsed = useMemo(() => parseHitlInterrupt(approval.content), [approval.content]);
    const subject = parsed.toolName ? `${parsed.toolName}` : "agent action";

    if (approval.status === "pending" && !clientResolved) {
      return null;
    }
    if (approval.status === "rejected") {
      return (
        <ChainOfThoughtStep icon={X} hideConnector={isLast} className="text-sm text-orange-500">
          <div className="flex w-fit max-w-full items-center gap-2 rounded-2xl border border-orange-500/25 bg-orange-500/[0.06] px-3 py-1.5 text-[12px] text-orange-500">
            <span className="font-medium">Rejected</span>
            <span className="truncate text-orange-500/70">
              · {subject}
              {approval.reason ? ` — ${approval.reason}` : ""}
            </span>
          </div>
        </ChainOfThoughtStep>
      );
    }
    const label = approval.status === "approved" ? "Approved" : "Decision sent";
    return (
      <ChainOfThoughtStep icon={Check} hideConnector={isLast} className="text-sm text-emerald-500">
        <div className="flex w-fit max-w-full items-center gap-2 rounded-2xl border border-emerald-500/25 bg-emerald-500/[0.06] px-3 py-1.5 text-[12px] text-emerald-500">
          <span className="font-medium">{label}</span>
          <span className="truncate text-emerald-500/70">· {subject}</span>
        </div>
      </ChainOfThoughtStep>
    );
  },
);
TimelineHitlItem.displayName = "TimelineHitlItem";

const DONE_SENTINELS: Record<
  TimelineTerminalStatus,
  { icon: typeof CheckCircle2; label: string; className: string }
> = {
  completed: { icon: CheckCircle2, label: "Done", className: "text-emerald-500" },
  cancelled: { icon: CircleSlash, label: "Stopped", className: "text-muted-foreground" },
  failed: { icon: XCircle, label: "Failed", className: "text-destructive" },
};

type ThinkingBlockViewProps = {
  block: ThinkingBlock;
  runId: string;
  // The run is streaming and this block is still receiving items.
  isLiveActive: boolean;
  // Sentinel closing the block: blocks the inference moved past (content or
  // sub-agent followed) get "completed" even mid-stream; the run's last
  // thinking block gets the terminal status. The still-open last block gets
  // nothing — never derived from THINKING_END, so a HITL-paused run can't
  // look complete.
  doneStatus?: TimelineTerminalStatus;
  fallbackDurationSeconds?: number | null;
  open: boolean;
  onOpenChange: () => void;
};

const ThinkingBlockView = memo(
  ({ block, runId, isLiveActive, doneStatus, fallbackDurationSeconds, open, onOpenChange }: ThinkingBlockViewProps) => {
    const durationLabel = formatThinkingDuration(
      blockDurationSeconds(block) ?? fallbackDurationSeconds ?? null,
    );
    const sentinel = doneStatus ? DONE_SENTINELS[doneStatus] : null;
    const awaitingApproval = block.items.some(
      (item) =>
        (item.kind === "hitl" && item.status === "pending") ||
        (item.kind === "tool" && item.approval?.status === "pending"),
    );
    if (!block.items.length && !sentinel && !isLiveActive) return null;

    return (
      <ChainOfThought className="w-full max-w-full space-y-2" open={open} onOpenChange={onOpenChange}>
        <ChainOfThoughtHeader className="text-sm md:text-[0.95rem] font-medium text-muted-foreground hover:text-foreground">
          {isLiveActive ? (
            <ShimmeringText
              text={awaitingApproval ? "Waiting for approval..." : "Reasoning..."}
              duration={1.1}
              pause={1.4}
              color="hsl(var(--muted-foreground))"
              shimmeringColor="#2b2d36"
              className="text-sm md:text-[0.95rem] font-medium"
            />
          ) : durationLabel ? (
            `Thought for ${durationLabel}`
          ) : (
            "Reasoning"
          )}
        </ChainOfThoughtHeader>
        <ChainOfThoughtContent className="space-y-5">
          {block.items.map((item, index) => {
            const isLastItem = index === block.items.length - 1;
            const isLastRendered = isLastItem && !sentinel;
            if (item.kind === "thought") {
              return (
                <ChainOfThoughtStep
                  key={item.id}
                  status={isLiveActive && isLastItem ? "active" : "complete"}
                  hideConnector={isLastRendered}
                  className="text-sm"
                >
                  <MarkdownRenderer
                    content={item.text || "Working..."}
                    className="text-muted-foreground text-sm leading-relaxed"
                  />
                </ChainOfThoughtStep>
              );
            }
            if (item.kind === "tool") {
              return <TimelineToolItem key={item.id} tool={item} runId={runId} isLast={isLastRendered} />;
            }
            return <TimelineHitlItem key={item.id} approval={item} runId={runId} isLast={isLastRendered} />;
          })}
          {sentinel ? (
            <ChainOfThoughtStep
              icon={sentinel.icon}
              label={sentinel.label}
              hideConnector
              className={cn("text-sm font-medium", sentinel.className)}
            />
          ) : null}
        </ChainOfThoughtContent>
      </ChainOfThought>
    );
  },
);
ThinkingBlockView.displayName = "ThinkingBlockView";

const ContentBlockView = memo(({ block }: { block: ContentBlock }) => {
  const normalized = normalizeBulletMarkdown(block.text);
  if (!normalized.trim()) return null;
  return <Response>{normalized}</Response>;
});
ContentBlockView.displayName = "ContentBlockView";

type TimelineBlocksProps = {
  timeline: RunTimeline;
  runId: string;
  isStreaming: boolean;
  // Post-terminal the sub-agent panels leave the message body for the
  // action-bar side panel; inline they render only while streaming.
  hideSubagents?: boolean;
  fallbackThinkingSeconds?: number | null;
  expandedThinking: Record<string, boolean>;
  onToggleThinking: (key: string, next?: boolean) => void;
};

export function TimelineBlocks({
  timeline,
  runId,
  isStreaming,
  hideSubagents = false,
  fallbackThinkingSeconds,
  expandedThinking,
  onToggleThinking,
}: TimelineBlocksProps) {
  // Post-run the sub-agent containers leave the body for the side panel,
  // which would leave the thinking blocks around them stacked back-to-back —
  // merge those neighbours into one block so the settled message reads as a
  // single "Thought for Ns" per stretch of work.
  const renderBlocks = useMemo<TimelineBlock[]>(() => {
    if (!hideSubagents) return timeline.blocks;
    const merged: TimelineBlock[] = [];
    for (const block of timeline.blocks) {
      if (block.kind === "subagent") continue;
      const last = merged[merged.length - 1];
      if (block.kind === "thinking" && last?.kind === "thinking") {
        merged[merged.length - 1] = {
          ...last,
          items: [...last.items, ...block.items],
          startedAt: last.startedAt ?? block.startedAt,
          endedAt: block.endedAt ?? last.endedAt,
        };
        continue;
      }
      merged.push(block);
    }
    return merged;
  }, [timeline.blocks, hideSubagents]);

  const lastThinkingIndex = useMemo(() => {
    for (let i = renderBlocks.length - 1; i >= 0; i -= 1) {
      if (renderBlocks[i].kind === "thinking") return i;
    }
    return -1;
  }, [renderBlocks]);

  let subagentIndex = -1;
  return (
    <>
      {renderBlocks.map((block, index) => {
        if (block.kind === "content") {
          return <ContentBlockView key={block.id} block={block} />;
        }
        if (block.kind === "subagent") {
          subagentIndex += 1;
          return <SubagentCard key={block.id} subagent={subagentBlockToItem(block)} index={subagentIndex} />;
        }
        const isLast = index === lastThinkingIndex;
        const isLastBlock = index === renderBlocks.length - 1;
        const isLiveActive = isStreaming && !timeline.terminal && isLastBlock;
        const expandKey = `${runId}:${block.id}`;
        const open = expandedThinking[expandKey] ?? isLiveActive;
        return (
          <ThinkingBlockView
            key={block.id}
            block={block}
            runId={runId}
            isLiveActive={isLiveActive}
            doneStatus={
              timeline.terminal && isLast
                ? timeline.terminalStatus
                : !isLastBlock
                  ? "completed"
                  : undefined
            }
            fallbackDurationSeconds={isLast ? fallbackThinkingSeconds : null}
            open={open}
            onOpenChange={() => onToggleThinking(expandKey, !open)}
          />
        );
      })}
    </>
  );
}
