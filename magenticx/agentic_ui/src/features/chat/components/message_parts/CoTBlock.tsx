import { memo, useMemo, useState } from "react";
import {
  Check,
  CheckCircle2,
  CircleSlash,
  Clock,
  ShieldQuestion,
  ShieldX,
  Wrench,
  XCircle,
} from "lucide-react";
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtStep,
} from "@/shared/ui/ai-elements/chain-of-thought";
import { toolIcon } from "@/shared/lib/consts";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/shared/ui/collapsible";
import { toolMeta, toolTitle, toolTitleHint } from "@/features/chat/lib/toolPresentation";
import { useWorkspaceStore } from "@/shared/stores/workspaceStore";
import { ToolCallArgsView, ToolCallResultView } from "./ToolCallViews";
import { ShimmeringText } from "@/shared/ui/shadcn-io/shimmering-text";
import { MarkdownRenderer } from "@/shared/ui/markdownRenderer";
import { useHitl } from "@/features/inference";
import { useApprovalSummaries } from "@/features/chat/hooks/useApprovalSummaries";
import {
  approvalHeadline,
  hasApprovalDetail,
  presentApproval,
} from "@/features/chat/lib/approvalPresentation";
import { HitlActionSummary, HitlSummaryList } from "./HitlActionSummary";
import { cn } from "@/shared/lib/utils";
import type {
  ThinkingBlock,
  TimelineHitlApproval,
  TimelineTerminalStatus,
  TimelineToolExecution,
} from "@/shared/lib/types";

// The CoT (chain-of-thought) object: one collapsible thinking block rendering
// its ordered items — thoughts, tool executions (carrying their own HITL
// approval lifecycle), and resolved HITL records — ending in the Done sentinel
// once the run is terminal.

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
  // Approval and failure outrank identity: a rejected `ls` must not read as a
  // successful one at a glance, so those states keep their own glyph.
  if (face === "pending") return PendingApprovalIcon;
  if (face === "rejected") return ShieldX;
  if (tool.state === "output-error") return XCircle;
  // A settled call shows what it *did* where we have a glyph for it — a column
  // of identical wrenches gives the eye nothing to scan by.
  if (tool.state === "output-available") return toolIcon(tool.name) ?? Wrench;
  return RunningToolIcon;
};

/** Tools whose settled step is its title alone (see TimelineToolItem). */
const TITLE_ONLY_TOOLS = new Set(["read_file"]);

const TimelineToolItem = memo(
  ({ tool, runId, isLast }: { tool: TimelineToolExecution; runId: string; isLast: boolean }) => {
    const [open, setOpen] = useState(false);
    const hitl = useHitl();
    const args = useMemo(() => parseToolArgs(tool.argsText), [tool.argsText]);
    const duration = toolDurationLabel(tool);
    // MCP tools arrive under bare names (`tavily-search`); the catalog says
    // which server each belongs to, which is what makes them "Server · Tool".
    const serverId = useWorkspaceStore(
      (s) => s.availableTools.find((t) => t.toolName === tool.name)?.serverId || undefined,
    );
    // "Read report.csv" rather than `read_file`; the full path on hover.
    const title = toolTitle(tool.name, args, serverId);
    const titleHint = toolTitleHint(tool.name, args);
    const meta =
      tool.state === "output-error" ? undefined : toolMeta(tool.name, args, tool.result, serverId);

    const approval = tool.approval;
    const clientResolved = approval && hitl ? hitl.isInterruptResolved(runId, approval.id) : false;
    const face: ToolApprovalFace = !approval
      ? null
      : approval.status === "pending"
        ? clientResolved
          ? "decision-sent"
          : "pending"
        : approval.status;
    // A gated call shows what was put to the user — the same summary the
    // approval bar showed — so the record reads as the decision was made.
    const approvalSummary = useMemo(
      () => (approval ? presentApproval({ toolName: tool.name, args }, serverId) : null),
      [approval, tool.name, args, serverId],
    );

    // A file read is told by its title ("Read report.pdf"); its content is the
    // agent's to read, not the user's (a PDF comes back as base64), so a plain
    // row with nothing to open. A failed or gated read still opens.
    if (TITLE_ONLY_TOOLS.has(tool.name) && tool.state !== "output-error" && !approval) {
      return (
        <ChainOfThoughtStep
          icon={toolStepIcon(tool, face)}
          hideConnector={isLast}
          className="text-sm"
          label={
            <span className="flex max-w-full items-center gap-2">
              <span className="truncate font-medium" title={titleHint}>
                {title}
              </span>
              {meta ? <span className="shrink-0 text-muted-foreground text-xs">{meta}</span> : null}
              {duration ? (
                <span className="shrink-0 text-muted-foreground text-xs tabular-nums">{duration}</span>
              ) : null}
            </span>
          }
        />
      );
    }

    return (
      <Collapsible open={open} onOpenChange={setOpen}>
        <ChainOfThoughtStep
          icon={toolStepIcon(tool, face)}
          hideConnector={isLast}
          className={cn(
            "text-sm",
            tool.state === "output-error" && "text-destructive",
            face === "pending" && "text-warning",
            face === "rejected" && "text-destructive",
          )}
          label={
            <CollapsibleTrigger
              className="flex max-w-full items-center gap-2 text-left transition-colors hover:text-foreground"
              aria-label={`Toggle ${title} details`}
            >
              <span className="truncate font-medium" title={titleHint}>
                {title}
              </span>
              {meta ? <span className="shrink-0 text-muted-foreground text-xs">{meta}</span> : null}
              {duration ? (
                <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
                  {duration}
                </span>
              ) : null}
              {face === "pending" ? (
                <span className="shrink-0 text-warning text-xs font-medium">Needs approval</span>
              ) : face === "decision-sent" ? (
                <span className="shrink-0 text-muted-foreground text-xs">Decision sent</span>
              ) : face === "approved" ? (
                <span className="flex shrink-0 items-center gap-1 text-success text-xs font-medium">
                  <Check className="size-3" />
                  Approved
                </span>
              ) : face === "rejected" ? (
                <span className="shrink-0 text-destructive text-xs font-medium">Rejected</span>
              ) : null}
            </CollapsibleTrigger>
          }
        >
          <CollapsibleContent className="space-y-3 outline-none data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 data-[state=closed]:animate-out data-[state=open]:animate-in">
            {approvalSummary ? (
              <HitlActionSummary summary={approvalSummary} className="text-foreground" />
            ) : (
              <ToolCallArgsView tool={tool} args={args} serverId={serverId} />
            )}
            {face === "pending" ? (
              <div className="rounded-md border border-warning/25 bg-warning/[0.06] px-3 py-2 text-warning text-xs">
                Waiting for your approval — respond in the bar below.
              </div>
            ) : null}
            {face === "rejected" ? (
              <div className="rounded-md border border-destructive/25 bg-destructive/[0.06] px-3 py-2 text-destructive text-xs">
                Rejected by you{approval?.reason ? ` — ${approval.reason}` : ""}. The tool never
                ran.
              </div>
            ) : null}
            <ToolCallResultView tool={tool} args={args} serverId={serverId} />
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
  ({
    approval,
    runId,
    isLast,
  }: {
    approval: TimelineHitlApproval;
    runId: string;
    isLast: boolean;
  }) => {
    const [open, setOpen] = useState(false);
    const hitl = useHitl();
    const clientResolved = hitl ? hitl.isInterruptResolved(runId, approval.id) : false;
    const summaries = useApprovalSummaries(approval.content);
    // A batch bound to one record shows only its own action.
    const own =
      typeof approval.actionIndex === "number" && summaries[approval.actionIndex]
        ? [summaries[approval.actionIndex]]
        : summaries;
    const headline = approvalHeadline(own);
    const hasDetail = own.some(hasApprovalDetail);

    if (approval.status === "pending" && !clientResolved) {
      return null;
    }
    const rejected = approval.status === "rejected";
    const label = rejected ? "Rejected" : approval.status === "approved" ? "Approved" : "Decision sent";
    return (
      <Collapsible open={open} onOpenChange={setOpen}>
        <ChainOfThoughtStep
          icon={rejected ? ShieldX : Check}
          hideConnector={isLast}
          className={cn("text-sm", rejected ? "text-destructive" : "text-success")}
          label={
            <CollapsibleTrigger
              disabled={!hasDetail}
              className="flex max-w-full items-center gap-2 text-left transition-colors hover:text-foreground disabled:cursor-default"
              aria-label={`Toggle ${headline} details`}
            >
              <span className={cn("shrink-0 font-medium", rejected ? "text-destructive" : "text-success")}>
                {label}
              </span>
              <span className="truncate text-muted-foreground">
                · {headline}
                {rejected && approval.reason ? ` — ${approval.reason}` : ""}
              </span>
            </CollapsibleTrigger>
          }
        >
          {hasDetail ? (
            <CollapsibleContent className="space-y-3 text-foreground outline-none data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 data-[state=closed]:animate-out data-[state=open]:animate-in">
              <HitlSummaryList summaries={own} />
            </CollapsibleContent>
          ) : null}
        </ChainOfThoughtStep>
      </Collapsible>
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

export const CoTBlock = memo(
  ({
    block,
    runId,
    isLiveActive,
    doneStatus,
    fallbackDurationSeconds,
    open,
    onOpenChange,
  }: ThinkingBlockViewProps) => {
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
      <ChainOfThought
        className="w-full max-w-full space-y-2"
        open={open}
        onOpenChange={onOpenChange}
      >
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
              return (
                <TimelineToolItem key={item.id} tool={item} runId={runId} isLast={isLastRendered} />
              );
            }
            return (
              <TimelineHitlItem
                key={item.id}
                approval={item}
                runId={runId}
                isLast={isLastRendered}
              />
            );
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
CoTBlock.displayName = "CoTBlock";
