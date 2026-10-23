import { useMemo, useState } from "react";
import { useReducedMotion } from "framer-motion";
import { Bot, Gauge, MessageSquareText, MessagesSquare } from "lucide-react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/shared/ui/chart";
import { Skeleton } from "@/shared/ui/skeleton";
import { cn, formatCompactTokens, formatModelTime, formatSeconds, formatTokensPerSecond } from "@/shared/lib/utils";
import type { UsageModelBreakdown, UsageSummary, UsageWindow } from "@/shared/lib/types";
import {
  avgTimeToFirstToken,
  cacheHitRate,
  costOf,
  costValue,
  describeChange,
  fillDailySeries,
  firstTokenPerAnswer,
  formatPercent,
  ratio,
  timePerAnswer,
  tokensPerSecond,
} from "@/features/settings/lib/usageMetrics";
import { SoftPanel } from "../shared";
import {
  DrillCard,
  KpiTile,
  SectionTitle,
  ShareBar,
  ToolsSection,
  TruncatedMark,
  TruncationNote,
  UsageEmpty,
  UsageError,
} from "./UsageParts";

// Level 0 of the Usage tab: the dashboard you land on. This week against the
// last (six KPI tiles: tokens, cost, answers, time, first token, cache), the
// recency windows, a 30-day chart that separates cached input from fresh input
// and output (or shows model time), the model ranking with each model's cost
// and speed, the most-called tools, and the two ways in — conversations and
// agents.

const DAYS = 30;

const tokenChart = {
  cached: { label: "Cached input", color: "hsl(var(--primary) / 0.28)" },
  fresh: { label: "Fresh input", color: "hsl(var(--primary) / 0.55)" },
  output: { label: "Output", color: "hsl(var(--primary))" },
} satisfies ChartConfig;

const timeChart = {
  seconds: { label: "Model time (s)", color: "hsl(var(--primary))" },
} satisfies ChartConfig;

function WindowPill({ label, window }: { label: string; window: UsageWindow }) {
  const cost = costOf(window);
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-2xl bg-background/60 px-4 py-3">
      <span className="text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{label}</span>
      <span className="text-lg font-semibold tabular-nums tracking-tight text-foreground">
        {formatCompactTokens(window.totalTokens)}
      </span>
      <span className="text-xs tabular-nums text-muted-foreground">
        {window.aiMessages.toLocaleString()} {window.aiMessages === 1 ? "answer" : "answers"}
        {cost.label !== "—" ? ` · ${cost.label}` : ""}
      </span>
    </div>
  );
}

/**
 * A model's cost and speed under its row. Each figure only when its
 * denominator exists — calls that streamed for first token and speed — so a
 * model used only before these metrics shows its cost line or nothing.
 */
function ModelSpeed({ model }: { model: UsageModelBreakdown }) {
  const cost = costOf(model);
  const ttft = avgTimeToFirstToken(model);
  const speed = tokensPerSecond(model);
  const parts = [
    cost.label !== "—" ? `${cost.label}${cost.note ? ` (${cost.note})` : ""}` : cost.note,
    ttft !== null ? `first token ${formatSeconds(ttft)}` : null,
    speed !== null ? formatTokensPerSecond(speed) : null,
  ].filter(Boolean);
  if (parts.length === 0) return null;
  return <p className="text-xs tabular-nums text-muted-foreground">{parts.join(" · ")}</p>;
}

function OverviewSkeleton() {
  return (
    <div className="space-y-6" aria-hidden>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-[6.75rem] rounded-[1.4rem]" />
        ))}
      </div>
      <Skeleton className="h-[5.5rem] rounded-[1.4rem]" />
      <Skeleton className="h-64 rounded-[1.4rem]" />
    </div>
  );
}

export function UsageOverview({
  summary,
  error,
  onRetry,
  openConversation,
  onOpenConversation,
  onOpenConversations,
  onOpenAgents,
}: {
  summary: UsageSummary | null;
  error: string | null;
  onRetry: () => void;
  openConversation: { id: string; title: string | null } | null;
  onOpenConversation: (id: string, title: string | null) => void;
  onOpenConversations: () => void;
  onOpenAgents: () => void;
}) {
  const reduceMotion = useReducedMotion();
  const [chartMode, setChartMode] = useState<"tokens" | "time">("tokens");
  const series = useMemo(() => (summary ? fillDailySeries(summary.daily, DAYS) : []), [summary]);

  if (error && !summary) return <UsageError message={error} onRetry={onRetry} />;
  if (!summary) return <OverviewSkeleton />;

  if (summary.totals.aiMessages === 0) {
    return (
      <UsageEmpty icon={Gauge} title="No usage yet">
        Start a conversation with an agent — what it spends, how fast it answers and how well it caches will
        show up here.
      </UsageEmpty>
    );
  }

  const week = summary.last7Days;
  const before = summary.previous7Days;
  const weekTime = timePerAnswer(week);
  const weekCost = costOf(week);
  const weekFirstToken = firstTokenPerAnswer(week);
  const leader = summary.perAgent[0];
  const leaderShare = leader ? ratio(leader.totalTokens, summary.totals.totalTokens) : null;
  const largestModel = Math.max(1, ...summary.perModel.map((m) => m.inputTokens + m.outputTokens));

  return (
    <div className="space-y-8">
      {openConversation ? (
        <DrillCard
          icon={MessageSquareText}
          title="This conversation"
          detail={`${openConversation.title || "Untitled conversation"} — context, agents and every answer`}
          onClick={() => onOpenConversation(openConversation.id, openConversation.title)}
        />
      ) : null}

      <section className="space-y-3" aria-label="Last 7 days">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <KpiTile
            label="Tokens · 7 days"
            value={formatCompactTokens(week.totalTokens)}
            change={describeChange(week.totalTokens, before.totalTokens, "amount")}
            hint="vs the week before"
          />
          <KpiTile
            label="Cost · 7 days"
            value={weekCost.label}
            change={describeChange(costValue(week), costValue(before), "amount")}
            hint={weekCost.note ?? "estimate at list prices"}
          />
          <KpiTile
            label="Answers · 7 days"
            value={week.aiMessages.toLocaleString()}
            change={describeChange(week.aiMessages, before.aiMessages, "amount")}
          />
          <KpiTile
            label="Time per answer"
            value={weekTime === null ? "—" : formatModelTime(weekTime)}
            change={describeChange(weekTime, timePerAnswer(before), "amount")}
            hint="model time"
          />
          <KpiTile
            label="First token"
            value={weekFirstToken === null ? "—" : formatSeconds(weekFirstToken)}
            change={describeChange(weekFirstToken, firstTokenPerAnswer(before), "amount")}
            hint="wait for the first words"
          />
          <KpiTile
            label="Cache hit"
            value={formatPercent(cacheHitRate(week))}
            change={describeChange(cacheHitRate(week), cacheHitRate(before), "rate")}
            hint="of input reused"
          />
        </div>
        <SoftPanel className="flex gap-3 p-3 max-[520px]:flex-col">
          <WindowPill label="Today" window={summary.today} />
          <WindowPill label="Last 30 days" window={summary.last30Days} />
          <WindowPill label="All time" window={summary.totals} />
        </SoftPanel>
        <TruncationNote
          truncatedCalls={summary.last30Days.truncatedCalls}
          modelCalls={summary.last30Days.modelCalls}
          scope="in the last 30 days"
        />
      </section>

      <section className="space-y-4">
        <SectionTitle
          title="Last 30 days"
          detail={chartMode === "tokens" ? "Input the cache served, fresh input, and output — per day." : "Time spent in the model, per day."}
          action={
            <div className="inline-flex rounded-xl bg-muted/40 p-1" role="group" aria-label="Chart metric">
              {(["tokens", "time"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={chartMode === mode}
                  onClick={() => setChartMode(mode)}
                  className={cn(
                    "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    chartMode === mode ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {mode === "tokens" ? "Tokens" : "Time"}
                </button>
              ))}
            </div>
          }
        />
        <SoftPanel className="px-4 py-4">
          <ChartContainer config={chartMode === "tokens" ? tokenChart : timeChart} className="aspect-auto h-56 w-full">
            <BarChart data={series} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} interval="preserveStartEnd" minTickGap={28} />
              <YAxis
                width={44}
                tickLine={false}
                axisLine={false}
                tickFormatter={(value: number) => (chartMode === "tokens" ? formatCompactTokens(value) : `${value}s`)}
              />
              <ChartTooltip cursor={{ fill: "hsl(var(--muted) / 0.4)" }} content={<ChartTooltipContent />} />
              {chartMode === "tokens" ? (
                <>
                  <Bar dataKey="cached" stackId="t" fill="var(--color-cached)" radius={[0, 0, 3, 3]} isAnimationActive={!reduceMotion} />
                  <Bar dataKey="fresh" stackId="t" fill="var(--color-fresh)" isAnimationActive={!reduceMotion} />
                  <Bar dataKey="output" stackId="t" fill="var(--color-output)" radius={[3, 3, 0, 0]} isAnimationActive={!reduceMotion} />
                </>
              ) : (
                <Bar dataKey="seconds" fill="var(--color-seconds)" radius={[3, 3, 3, 3]} isAnimationActive={!reduceMotion} />
              )}
            </BarChart>
          </ChartContainer>
        </SoftPanel>
      </section>

      <section className="space-y-4">
        <SectionTitle title="By model" detail="Which models do the work, what they cost, and how fast each one answers." />
        {summary.perModel.length === 0 ? (
          <UsageEmpty icon={Bot} title="No model split yet">
            The model behind each call is recorded from Oct 8 onward — your next answers will fill this in.
          </UsageEmpty>
        ) : (
          <SoftPanel className="divide-y divide-border/40 overflow-hidden">
            {summary.perModel.map((model) => {
              const tokens = model.inputTokens + model.outputTokens;
              const perCall = ratio(model.modelMs, model.calls);
              return (
                <div key={model.model} className="space-y-2 px-5 py-3.5">
                  <div className="flex items-center justify-between gap-4">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-mono text-sm text-foreground">{model.model}</span>
                      {model.truncatedCalls > 0 ? <TruncatedMark count={model.truncatedCalls} /> : null}
                    </span>
                    <span className="shrink-0 text-sm tabular-nums text-foreground">
                      <span className="font-semibold">{formatCompactTokens(tokens)}</span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        {model.calls.toLocaleString()} calls · {perCall === null ? "—" : formatModelTime(perCall)}/call
                      </span>
                    </span>
                  </div>
                  <ModelSpeed model={model} />
                  <ShareBar fraction={tokens / largestModel} />
                </div>
              );
            })}
          </SoftPanel>
        )}
      </section>

      <ToolsSection
        tools={summary.perTool}
        detail="The most-called tools, all time: how often each fails, how long a call takes, how much it returns."
      />

      <section className="grid gap-3 sm:grid-cols-2" aria-label="Explore">
        <DrillCard
          icon={MessagesSquare}
          title="Conversations"
          detail={`${summary.conversations.toLocaleString()} conversations${
            summary.nearCompactionCount ? ` · ${summary.nearCompactionCount} near compaction` : ""
          }`}
          onClick={onOpenConversations}
        />
        <DrillCard
          icon={Bot}
          title="Agents"
          detail={`${summary.agentCount} ${summary.agentCount === 1 ? "agent" : "agents"}${
            leader && leaderShare !== null ? ` · ${leader.agentName} leads (${formatPercent(leaderShare)})` : ""
          }`}
          onClick={onOpenAgents}
        />
      </section>
    </div>
  );
}
