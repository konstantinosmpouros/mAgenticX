import { memo, useMemo, useState } from "react";
import {
  Check,
  CheckCircle2,
  CircleSlash,
  Clock,
  MessageCircleQuestion,
  Network,
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
import { isAskUserAnswered, toTitleCase, useHitl } from "@/features/inference";
import { useApprovalSummaries } from "@/features/chat/hooks/useApprovalSummaries";
import {
  approvalHeadline,
  hasApprovalDetail,
  presentApproval,
} from "@/features/chat/lib/approvalPresentation";
import { HitlActionSummary, HitlSummaryList } from "./HitlActionSummary";
import { cn } from "@/shared/lib/utils";
import type {
  AskUserAnswer,
  AskUserQuestion,
  ThinkingBlock,
  TimelineDelegation,
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
    const decisionSent = approval && hitl ? hitl.isDecisionInFlight(runId, approval.id) : false;
    const face: ToolApprovalFace = !approval
      ? null
      : approval.status === "pending"
        ? decisionSent
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
                <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
                  {duration}
                </span>
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
    const decisionSent = hitl ? hitl.isDecisionInFlight(runId, approval.id) : false;
    const summaries = useApprovalSummaries(approval.content);
    // A batch bound to one record shows only its own action.
    const own =
      typeof approval.actionIndex === "number" && summaries[approval.actionIndex]
        ? [summaries[approval.actionIndex]]
        : summaries;
    const headline = approvalHeadline(own);
    const hasDetail = own.some(hasApprovalDetail);

    if (approval.status === "pending" && !decisionSent) {
      return null;
    }
    const rejected = approval.status === "rejected";
    const label = rejected
      ? "Rejected"
      : approval.status === "approved"
        ? "Approved"
        : "Decision sent";
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
              <span
                className={cn(
                  "shrink-0 font-medium",
                  rejected ? "text-destructive" : "text-success",
                )}
              >
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

// The agent's clarifying questions (`ask_user`), once resolved: "Answered ·
// 2 questions" (or "Skipped"), opening onto each question and what was
// answered — the picks as chips, the user's own words as a quote. Like an
// approval it says nothing while pending: the takeover is asking.
const AskUserAnswerView = ({ answer }: { answer: AskUserAnswer | undefined }) => {
  if (!answer || !isAskUserAnswered(answer)) {
    return <p className="text-muted-foreground text-xs italic">No preference</p>;
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {answer.selected.map((option) => (
        <span
          key={option}
          className="inline-flex max-w-full items-center gap-1 rounded-full border border-primary/25 bg-primary/[0.07] px-2.5 py-0.5 text-foreground text-xs"
        >
          <Check aria-hidden className="size-3 shrink-0 text-primary" strokeWidth={3} />
          <span className="truncate">{option}</span>
        </span>
      ))}
      {answer.text ? (
        <p className="w-full whitespace-pre-wrap border-primary/30 border-l-2 pl-2.5 text-foreground text-sm leading-relaxed">
          {answer.text}
        </p>
      ) : null}
    </div>
  );
};

export const AskUserList = ({
  questions,
  answers,
  skipped,
}: {
  questions: AskUserQuestion[];
  answers?: AskUserAnswer[];
  skipped: boolean;
}) => (
  <ol className="space-y-3">
    {questions.map((question, index) => (
      <li key={question.id} className="flex gap-2.5">
        <span
          aria-hidden
          className="mt-px flex size-5 shrink-0 items-center justify-center rounded-full bg-muted font-semibold text-[10px] text-muted-foreground tabular-nums"
        >
          {index + 1}
        </span>
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="font-medium text-foreground text-sm leading-snug">{question.question}</p>
          {skipped ? (
            <p className="text-muted-foreground text-xs italic">Skipped — left to the agent</p>
          ) : answers ? (
            <AskUserAnswerView answer={answers.find((answer) => answer.id === question.id)} />
          ) : (
            <p className="text-muted-foreground text-xs italic">Answer sent</p>
          )}
        </div>
      </li>
    ))}
  </ol>
);

const TimelineAskUserItem = memo(
  ({
    approval,
    questions,
    runId,
    isLast,
    soleItem,
  }: {
    approval: TimelineHitlApproval;
    questions: AskUserQuestion[];
    runId: string;
    isLast: boolean;
    // The block holds nothing else: open on the answers straight away.
    soleItem: boolean;
  }) => {
    const [open, setOpen] = useState<boolean | null>(null);
    const hitl = useHitl();
    const decisionSent = hitl ? hitl.isDecisionInFlight(runId, approval.id) : false;
    if (approval.status === "pending" && !decisionSent) return null;

    const skipped = approval.status === "rejected";
    const count = questions.length;
    const label = skipped
      ? "Skipped"
      : approval.status === "approved"
        ? "Answered"
        : "Answers sent";
    const detail = count === 1 ? questions[0].question : `${count} questions`;
    const expanded = open ?? soleItem;
    return (
      <Collapsible open={expanded} onOpenChange={setOpen}>
        <ChainOfThoughtStep
          icon={MessageCircleQuestion}
          hideConnector={isLast}
          className={cn("text-sm", skipped ? "text-muted-foreground" : "text-primary")}
          label={
            <CollapsibleTrigger
              disabled={!count}
              className="flex max-w-full items-center gap-2 text-left transition-colors hover:text-foreground disabled:cursor-default"
              aria-label={`Toggle ${label.toLowerCase()} questions`}
            >
              <span
                className={cn(
                  "shrink-0 font-medium",
                  skipped ? "text-muted-foreground" : "text-primary",
                )}
              >
                {label}
              </span>
              <span className="truncate text-muted-foreground">· {detail}</span>
            </CollapsibleTrigger>
          }
        >
          {count ? (
            <CollapsibleContent className="pt-1 text-foreground outline-none data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 data-[state=closed]:animate-out data-[state=open]:animate-in">
              <AskUserList questions={questions} answers={approval.answers} skipped={skipped} />
            </CollapsibleContent>
          ) : null}
        </ChainOfThoughtStep>
      </Collapsible>
    );
  },
);
TimelineAskUserItem.displayName = "TimelineAskUserItem";

/**
 * A sub-agent handing part of its work to a sub-agent of its own — shown where
 * it happened in the delegating agent's steps. Where the child can be opened
 * (the agent map's transcript), the row opens it.
 */
const TimelineDelegationItem = memo(
  ({
    item,
    isLast,
    onOpen,
  }: {
    item: TimelineDelegation;
    isLast: boolean;
    onOpen?: (taskId: string) => void;
  }) => {
    const title = toTitleCase(item.type) ?? "Sub-agent";
    return (
      <ChainOfThoughtStep
        icon={Network}
        hideConnector={isLast}
        className="text-sm"
        label={
          onOpen ? (
            <button
              type="button"
              onClick={() => onOpen(item.taskId)}
              className="rounded-sm text-left font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
              aria-label={`Open ${title}`}
            >
              Delegated to {title}
            </button>
          ) : (
            <span className="font-medium text-foreground">Delegated to {title}</span>
          )
        }
        description={item.description}
      />
    );
  },
);
TimelineDelegationItem.displayName = "TimelineDelegationItem";

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
  // Opens a sub-agent this block's agent delegated to (the agent map's
  // transcript); without it a delegation row is plain text.
  onOpenDelegation?: (taskId: string) => void;
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
    onOpenDelegation,
  }: ThinkingBlockViewProps) => {
    const durationLabel = formatThinkingDuration(
      blockDurationSeconds(block) ?? fallbackDurationSeconds ?? null,
    );
    const awaitingApproval = block.items.some(
      (item) =>
        (item.kind === "hitl" && item.status === "pending") ||
        (item.kind === "tool" && item.approval?.status === "pending"),
    );
    // The agent's own questions wait on an answer, not an approval.
    const awaitingAnswer = block.items.some(
      (item) => item.kind === "hitl" && item.status === "pending" && Boolean(item.questions),
    );
    // A block that is nothing but the agent's questions has no thinking to time.
    const askedOnly =
      block.items.length > 0 &&
      block.items.every((item) => item.kind === "hitl" && Boolean(item.questions));
    const askedCount = askedOnly
      ? block.items.reduce(
          (sum, item) => sum + (item.kind === "hitl" ? (item.questions?.length ?? 0) : 0),
          0,
        )
      : 0;
    // ...nor a "Done" to close: the answers are the whole record. (A run that
    // failed or stopped there still says so.)
    const sentinel =
      doneStatus && !(askedOnly && doneStatus === "completed") ? DONE_SENTINELS[doneStatus] : null;
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
              text={
                awaitingAnswer
                  ? "Waiting for your answer..."
                  : awaitingApproval
                    ? "Waiting for approval..."
                    : "Reasoning..."
              }
              duration={1.1}
              pause={1.4}
              color="hsl(var(--muted-foreground))"
              shimmeringColor="#2b2d36"
              className="text-sm md:text-[0.95rem] font-medium"
            />
          ) : askedOnly ? (
            askedCount === 1 ? (
              "Asked you a question"
            ) : (
              `Asked you ${askedCount} questions`
            )
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
            if (item.kind === "delegation") {
              return (
                <TimelineDelegationItem
                  key={item.id}
                  item={item}
                  isLast={isLastRendered}
                  onOpen={onOpenDelegation}
                />
              );
            }
            if (item.questions) {
              return (
                <TimelineAskUserItem
                  key={item.id}
                  approval={item}
                  questions={item.questions}
                  runId={runId}
                  isLast={isLastRendered}
                  soleItem={askedOnly}
                />
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
