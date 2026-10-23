import { useEffect, useMemo } from "react";
import { useReducedMotion } from "framer-motion";
import { ArrowUpRight, Bot, Scissors } from "lucide-react";
import { Area, AreaChart, CartesianGrid, ReferenceDot, ReferenceLine, XAxis, YAxis } from "recharts";

import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/shared/ui/chart";
import { Skeleton } from "@/shared/ui/skeleton";
import { describeCost, formatCompactTokens, formatModelTime, formatSeconds } from "@/shared/lib/utils";
import { getUsageConversation } from "@/shared/lib/api";
import type { UsageAgentGroup, UsageAnswerPoint } from "@/shared/lib/types";
import { useUsageQuery } from "@/features/settings/hooks/useUsageQuery";
import { cacheHitRate, contextFill, costOf, formatPercent, ratio, timePerAnswer } from "@/features/settings/lib/usageMetrics";
import { SoftPanel } from "../shared";
import {
  AgentGroupTable,
  CoverageNote,
  KpiTile,
  SectionTitle,
  ToolsSection,
  TruncatedMark,
  TruncationNote,
  UsageEmpty,
  UsageError,
} from "./UsageParts";

// Level 2a of the Usage tab: one conversation, analysed. What it spent (every
// answer, replaced ones included), how its main agent's context filled up
// along the branch it opens on — with the window, where summarizing kicks in,
// and the points where it likely compacted — who did the work (main agent vs
// each sub-agent, by model), the tools it called, and every answer on that
// branch with its cost, first-token wait and whether it was cut off.

const contextChart = {
  tokens: { label: "Context", color: "hsl(var(--primary))" },
} satisfies ChartConfig;

// A drop of more than this between consecutive answers is read as compaction:
// the summarizer replaced older messages with a summary. Inferred, so labelled
// "likely".
const COMPACTION_DROP = 0.3;

type ContextPoint = { index: number; label: string; tokens: number; compacted: boolean };

function contextSeries(branch: UsageAnswerPoint[]): ContextPoint[] {
  const points: ContextPoint[] = [];
  branch.forEach((answer, position) => {
    if (answer.contextTokens === null) return;
    const previous = points[points.length - 1];
    points.push({
      index: position + 1,
      label: `#${position + 1}`,
      tokens: answer.contextTokens,
      compacted: Boolean(previous && answer.contextTokens < previous.tokens * (1 - COMPACTION_DROP)),
    });
  });
  return points;
}

/** Average first-token wait over the answers on the branch that measured one. */
function branchFirstToken(branch: UsageAnswerPoint[]): number | null {
  const measured = branch.filter((answer) => answer.firstTokenMs !== null);
  return ratio(
    measured.reduce((sum, answer) => sum + (answer.firstTokenMs ?? 0), 0),
    measured.length,
  );
}

function AnswerRow({ answer, position }: { answer: UsageAnswerPoint; position: number }) {
  const fill = contextFill(answer.contextTokens, answer.contextWindow);
  const when = answer.createdAt ? new Date(answer.createdAt) : null;
  // Null on answers from before plan 41: the figure is left out, not "$0.00".
  const cost = answer.costMicros !== null ? describeCost(answer.costMicros, answer.unpricedCalls) : null;
  const details = [
    `${formatCompactTokens(answer.inputTokens + answer.outputTokens)} tokens`,
    cost ? (cost.note ? `${cost.label} (${cost.note})` : cost.label) : null,
    answer.modelCalls !== null ? `${answer.modelCalls} ${answer.modelCalls === 1 ? "call" : "calls"}` : null,
    answer.toolCalls ? `${answer.toolCalls} tools` : null,
    answer.modelMs !== null ? formatModelTime(answer.modelMs) : null,
    answer.firstTokenMs !== null ? `first token ${formatSeconds(answer.firstTokenMs)}` : null,
    fill !== null ? `${Math.round(fill * 100)}% context` : null,
  ].filter(Boolean);
  return (
    <div className="flex min-w-0 items-center gap-3 px-5 py-3">
      <span className="w-8 shrink-0 text-xs tabular-nums text-muted-foreground">#{position}</span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm text-foreground tabular-nums">{details.join(" · ")}</span>
          {answer.truncatedCalls ? <TruncatedMark count={answer.truncatedCalls} /> : null}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {[when?.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }), answer.agentName, answer.model]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </span>
    </div>
  );
}

export function UsageConversationDetail({
  userId,
  conversationId,
  refreshToken,
  onBusyChange,
  onOpenChat,
  onOpenAgent,
}: {
  userId: string | null;
  conversationId: string;
  /** Bumped by the panel's refresh button to reload this page. */
  refreshToken: number;
  onBusyChange: (busy: boolean) => void;
  onOpenChat: (conversationId: string) => void;
  onOpenAgent: (group: UsageAgentGroup) => void;
}) {
  const reduceMotion = useReducedMotion();
  const query = useUsageQuery(userId ? `conversation:${conversationId}:${refreshToken}` : null, () =>
    getUsageConversation(userId ?? "", conversationId),
  );
  useEffect(() => onBusyChange(query.loading), [query.loading, onBusyChange]);
  const detail = query.data;
  const points = useMemo(() => (detail ? contextSeries(detail.branch) : []), [detail]);

  if (query.error && !detail) return <UsageError message={query.error} onRetry={query.refresh} />;
  if (!detail) {
    return (
      <div className="space-y-6" aria-hidden>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} className="h-[6.75rem] rounded-[1.4rem]" />
          ))}
        </div>
        <Skeleton className="h-60 rounded-[1.4rem]" />
        <Skeleton className="h-40 rounded-[1.4rem]" />
      </div>
    );
  }

  const window = detail.branch.reduce<number | null>((found, a) => a.contextWindow ?? found, null);
  const compaction = detail.branch.reduce<number | null>((found, a) => a.compactionPercent ?? found, null);
  const perAnswer = timePerAnswer(detail);
  const cost = costOf(detail);
  const firstToken = branchFirstToken(detail.branch);
  const newestFirst = detail.branch.map((answer, index) => ({ answer, position: index + 1 })).reverse();

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground tabular-nums">
          {detail.answers} {detail.answers === 1 ? "answer" : "answers"}
          {detail.replaced ? ` (${detail.replaced} replaced by a retry or an edit)` : ""}
        </p>
        <button
          type="button"
          onClick={() => onOpenChat(detail.id)}
          className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-muted/40 px-3 text-xs font-semibold text-foreground transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Open chat
          <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>

      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <KpiTile label="Tokens" value={formatCompactTokens(detail.totalTokens)} hint={`${formatCompactTokens(detail.inputTokens)} in · ${formatCompactTokens(detail.outputTokens)} out`} />
          <KpiTile label="Cost" value={cost.label} hint={cost.note ?? "estimate at list prices"} />
          <KpiTile label="Cache hit" value={formatPercent(cacheHitRate(detail))} hint="of input reused" />
          <KpiTile
            label="Model calls"
            value={detail.modelCalls.toLocaleString()}
            hint={`${detail.toolCalls.toLocaleString()} tool calls${detail.callsComplete ? "" : " · partial"}`}
          />
          <KpiTile label="Time per answer" value={perAnswer === null ? "—" : formatModelTime(perAnswer)} hint="model time" />
          <KpiTile
            label="First token"
            value={firstToken === null ? "—" : formatSeconds(firstToken)}
            hint="avg wait, answers shown below"
          />
        </div>
        <TruncationNote truncatedCalls={detail.truncatedCalls} modelCalls={detail.modelCalls} scope="in this conversation" />
      </div>

      <section className="space-y-4">
        <SectionTitle
          title="Context over the conversation"
          detail="How full the main agent's window was after each answer on the branch the chat opens on."
        />
        {points.length < 2 ? (
          <UsageEmpty icon={Scissors} title="Not enough answers yet">
            Context is recorded from Oct 8 onward; the chart appears once two answers on this branch have it.
          </UsageEmpty>
        ) : (
          <SoftPanel className="space-y-3 px-4 py-4">
            <ChartContainer config={contextChart} className="aspect-auto h-56 w-full">
              <AreaChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 4 }}>
                <CartesianGrid vertical={false} strokeDasharray="3 3" />
                <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} />
                <YAxis
                  width={48}
                  tickLine={false}
                  axisLine={false}
                  domain={[0, window ?? "auto"]}
                  tickFormatter={(value: number) => formatCompactTokens(value)}
                />
                <ChartTooltip content={<ChartTooltipContent />} />
                {window ? <ReferenceLine y={window} stroke="hsl(var(--muted-foreground))" strokeDasharray="4 4" /> : null}
                {window && compaction ? (
                  <ReferenceLine y={(window * compaction) / 100} stroke="hsl(var(--warning))" strokeDasharray="2 4" />
                ) : null}
                <Area
                  dataKey="tokens"
                  type="monotone"
                  stroke="var(--color-tokens)"
                  fill="var(--color-tokens)"
                  fillOpacity={0.15}
                  strokeWidth={2}
                  isAnimationActive={!reduceMotion}
                />
                {points
                  .filter((point) => point.compacted)
                  .map((point) => (
                    <ReferenceDot key={point.index} x={point.label} y={point.tokens} r={4} fill="hsl(var(--warning))" stroke="none" />
                  ))}
              </AreaChart>
            </ChartContainer>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {window ? <span>— — window {formatCompactTokens(window)}</span> : null}
              {window && compaction ? <span className="text-warning">· · summarizing at {compaction}%</span> : null}
              {points.some((point) => point.compacted) ? <span className="text-warning">● likely compacted</span> : null}
            </div>
          </SoftPanel>
        )}
      </section>

      <section className="space-y-4">
        <SectionTitle title="Agents" detail="Who did the work — the main agent and each sub-agent, by model." />
        {detail.groups.length === 0 ? (
          <UsageEmpty icon={Bot} title="No agent split yet">
            The split between the main agent and its sub-agents is recorded from Oct 8 onward.
          </UsageEmpty>
        ) : (
          <AgentGroupTable groups={detail.groups} onOpenAgent={onOpenAgent} />
        )}
        <CoverageNote detailed={detail.detailedAnswers} total={detail.answers} />
      </section>

      <ToolsSection tools={detail.tools} detail="Every tool this conversation called, replaced answers included." />

      {newestFirst.length > 0 ? (
        <section className="space-y-4">
          <SectionTitle
            title="Answers"
            detail={`The branch the chat opens on, newest first${detail.branchTruncated ? " — the latest 500" : ""}.`}
          />
          <SoftPanel className="divide-y divide-border/40 overflow-hidden">
            {newestFirst.map(({ answer, position }) => (
              <AnswerRow key={answer.id} answer={answer} position={position} />
            ))}
          </SoftPanel>
        </section>
      ) : null}
    </div>
  );
}
