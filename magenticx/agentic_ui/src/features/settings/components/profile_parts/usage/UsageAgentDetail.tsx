import { useEffect, useMemo } from "react";
import { useReducedMotion } from "framer-motion";
import { ArrowUpRight, Bot, ChevronRight, MessagesSquare } from "lucide-react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/shared/ui/chart";
import { Skeleton } from "@/shared/ui/skeleton";
import { cn, formatCompactTokens, formatModelTime } from "@/shared/lib/utils";
import { mapIcon } from "@/shared/lib/consts";
import { getUsageAgent } from "@/shared/lib/api";
import type { UsageRange } from "@/shared/lib/api";
import { useUsageQuery } from "@/features/settings/hooks/useUsageQuery";
import {
  MIN_ANSWERS_FOR_RATIOS,
  cacheHitRate,
  callsPerAnswer,
  costOf,
  fillDailySeries,
  formatPercent,
  formatRatio,
  rangeLabel,
  ratio,
  timePerAnswer,
  toolsPerAnswer,
  truncationRate,
  engineLabel,
} from "@/features/settings/lib/usageMetrics";
import { SoftPanel } from "../shared";
import {
  AgentGroupTable,
  AgentKindBadge,
  CoverageNote,
  KpiTile,
  RangeSelect,
  SectionTitle,
  ToolsSection,
  UsageEmpty,
  UsageError,
} from "./UsageParts";

// Level 2b of the Usage tab: one agent as an entity — what it is (platform or
// custom, its engine, version, when it was made) and how it behaves across
// every conversation: what it spends per answer, how hard it works, how well
// it caches, what it costs and how often it is cut off, where its tokens go
// (itself vs each sub-agent, by model), the tools it calls, its trend, and the
// conversations it spent the most in.

const MAX_TREND_DAYS = 90;
const RANGE_DAYS: Record<UsageRange, number> = { "7d": 7, "30d": 30, "90d": 90, all: MAX_TREND_DAYS };

const trendChart = {
  cached: { label: "Cached input", color: "hsl(var(--primary) / 0.28)" },
  fresh: { label: "Fresh input", color: "hsl(var(--primary) / 0.55)" },
  output: { label: "Output", color: "hsl(var(--primary))" },
} satisfies ChartConfig;

export function UsageAgentDetail({
  userId,
  agentKey,
  range,
  onRangeChange,
  refreshToken,
  onBusyChange,
  onOpenConversation,
  onManageAgents,
}: {
  userId: string | null;
  agentKey: string;
  range: UsageRange;
  onRangeChange: (range: UsageRange) => void;
  refreshToken: number;
  onBusyChange: (busy: boolean) => void;
  onOpenConversation: (id: string, title: string | null) => void;
  onManageAgents: () => void;
}) {
  const reduceMotion = useReducedMotion();
  const query = useUsageQuery(userId ? `agent:${agentKey}:${range}:${refreshToken}` : null, () =>
    getUsageAgent(userId ?? "", agentKey, { range }),
  );
  useEffect(() => onBusyChange(query.loading), [query.loading, onBusyChange]);

  const detail = query.data;
  const series = useMemo(() => (detail ? fillDailySeries(detail.daily, RANGE_DAYS[range]) : []), [detail, range]);

  if (query.error && !detail) return <UsageError message={query.error} onRetry={query.refresh} />;
  if (!detail) {
    return (
      <div className="space-y-6" aria-hidden>
        <Skeleton className="h-20 rounded-[1.4rem]" />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} className="h-[6.75rem] rounded-[1.4rem]" />
          ))}
        </div>
        <Skeleton className="h-56 rounded-[1.4rem]" />
      </div>
    );
  }

  const agent = detail.agent;
  const Icon = mapIcon(agent.icon);
  const ratios = agent.detailedAnswers >= MIN_ANSWERS_FOR_RATIOS;
  const perAnswerTime = timePerAnswer(agent);
  const modelTotals = new Map<string, number>();
  for (const group of detail.groups) {
    if (!group.model) continue;
    modelTotals.set(group.model, (modelTotals.get(group.model) ?? 0) + group.inputTokens + group.outputTokens);
  }
  const modelSum = [...modelTotals.values()].reduce((sum, value) => sum + value, 0);
  const models = [...modelTotals.entries()].sort((a, b) => b[1] - a[1]);
  const created = agent.createdAt ? new Date(agent.createdAt) : null;
  // The agent entity carries its total cost; whether some of it went unpriced
  // is only known per agent × model, so it is read from the groups.
  const cost = costOf({
    costMicros: agent.costMicros,
    unpricedCalls: detail.groups.reduce((sum, group) => sum + group.unpricedCalls, 0),
  });
  const cutOffRate = truncationRate(agent);

  return (
    <div className="space-y-8">
      <SoftPanel className="flex flex-wrap items-center gap-4 px-5 py-4">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Icon className="h-6 w-6" aria-hidden />
        </span>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <AgentKindBadge kind={agent.kind} />
            {engineLabel(agent.engine) ? (
              <span className="rounded-md bg-background/70 px-1.5 py-0.5 text-[0.68rem] text-muted-foreground">
                {engineLabel(agent.engine)}
              </span>
            ) : null}
            {agent.version ? (
              <span className="rounded-md bg-background/70 px-1.5 py-0.5 text-[0.68rem] text-muted-foreground">{agent.version}</span>
            ) : null}
            {agent.kind !== "deleted" && !agent.isActive ? (
              <span className="rounded-md bg-muted px-1.5 py-0.5 text-[0.68rem] text-muted-foreground">Inactive</span>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground tabular-nums">
            {agent.answers.toLocaleString()} answers · {agent.conversations.toLocaleString()} conversations ·{" "}
            {formatCompactTokens(agent.totalTokens)} tokens
            {cost.label !== "—" ? ` · ${cost.label}` : ""} in the {rangeLabel(range).toLowerCase()}
            {created && agent.kind === "custom" ? ` · created ${created.toLocaleDateString(undefined, { dateStyle: "medium" })}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <RangeSelect value={range} onChange={onRangeChange} />
          {agent.kind === "custom" ? (
            <button
              type="button"
              onClick={onManageAgents}
              className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-background/70 px-3 text-xs font-semibold text-foreground transition-colors hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Manage in Agents
              <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
            </button>
          ) : null}
        </div>
      </SoftPanel>

      {agent.answers === 0 ? (
        <UsageEmpty icon={Bot} title="No answers in this range">
          {agent.name} didn't answer in the {rangeLabel(range).toLowerCase()} — try a longer range.
        </UsageEmpty>
      ) : (
        <>
          <section className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <KpiTile
                label="Tokens per answer"
                value={ratios ? formatCompactTokens(ratio(agent.totalTokens, agent.answers) ?? 0) : "—"}
                hint={`${formatCompactTokens(agent.totalTokens)} in total`}
              />
              <KpiTile
                label="Calls per answer"
                value={ratios ? formatRatio(callsPerAnswer(agent)) : "—"}
                hint={ratios ? `${formatRatio(toolsPerAnswer(agent))} tool calls` : undefined}
              />
              <KpiTile
                label="Time per answer"
                value={ratios && perAnswerTime !== null ? formatModelTime(perAnswerTime) : "—"}
                hint="model time"
              />
              <KpiTile label="Cache hit" value={ratios ? formatPercent(cacheHitRate(agent)) : "—"} hint="of input reused" />
              <KpiTile label="Cost" value={cost.label} hint={cost.note ?? "estimate at list prices"} />
              <KpiTile
                label="Cut off"
                value={agent.truncatedCalls.toLocaleString()}
                hint={
                  agent.truncatedCalls > 0 && cutOffRate !== null
                    ? `${formatPercent(cutOffRate)} of calls hit the output limit`
                    : "calls that hit the output limit"
                }
              />
            </div>
            {!ratios ? (
              <p className="text-xs text-muted-foreground">
                Per-answer numbers appear once {agent.name} has {MIN_ANSWERS_FOR_RATIOS} answers with full details in
                this range.
              </p>
            ) : null}
          </section>

          <section className="space-y-4">
            <SectionTitle title="Trend" detail={`Tokens per day over the ${rangeLabel(range === "all" ? "90d" : range).toLowerCase()}.`} />
            <SoftPanel className="px-4 py-4">
              <ChartContainer config={trendChart} className="aspect-auto h-48 w-full">
                <BarChart data={series} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} interval="preserveStartEnd" minTickGap={28} />
                  <YAxis width={44} tickLine={false} axisLine={false} tickFormatter={(value: number) => formatCompactTokens(value)} />
                  <ChartTooltip cursor={{ fill: "hsl(var(--muted) / 0.4)" }} content={<ChartTooltipContent />} />
                  <Bar dataKey="cached" stackId="t" fill="var(--color-cached)" radius={[0, 0, 3, 3]} isAnimationActive={!reduceMotion} />
                  <Bar dataKey="fresh" stackId="t" fill="var(--color-fresh)" isAnimationActive={!reduceMotion} />
                  <Bar dataKey="output" stackId="t" fill="var(--color-output)" radius={[3, 3, 0, 0]} isAnimationActive={!reduceMotion} />
                </BarChart>
              </ChartContainer>
            </SoftPanel>
          </section>

          <section className="space-y-4">
            <SectionTitle title="Where its tokens go" detail="The agent itself and each sub-agent it delegated to, by model." />
            {detail.groups.length === 0 ? (
              <UsageEmpty icon={Bot} title="No split yet">
                The split between {agent.name} and its sub-agents is recorded from Oct 8 onward.
              </UsageEmpty>
            ) : (
              <AgentGroupTable groups={detail.groups} />
            )}
            {models.length > 0 ? (
              <div className="flex flex-wrap gap-2" aria-label="Models used">
                {models.map(([model, tokens]) => (
                  <span key={model} className="inline-flex items-center gap-1.5 rounded-lg bg-muted/40 px-2.5 py-1 text-xs">
                    <span className="font-mono text-foreground">{model}</span>
                    <span className="tabular-nums text-muted-foreground">{formatPercent(ratio(tokens, modelSum))}</span>
                  </span>
                ))}
              </div>
            ) : null}
            <CoverageNote detailed={agent.detailedAnswers} total={agent.answers} />
          </section>

          <ToolsSection
            tools={detail.tools}
            detail={`The tools ${agent.name} and its sub-agents called in the ${rangeLabel(range).toLowerCase()}.`}
          />

          <section className="space-y-4">
            <SectionTitle title="Heaviest conversations" detail={`Where ${agent.name} spent the most. Private chats are never listed.`} />
            {detail.topConversations.length === 0 ? (
              <UsageEmpty icon={MessagesSquare} title="Only private chats">
                Every conversation with {agent.name} in this range was private.
              </UsageEmpty>
            ) : (
              <SoftPanel className="divide-y divide-border/40 overflow-hidden">
                {detail.topConversations.map((conversation) => (
                  <button
                    key={conversation.id}
                    type="button"
                    onClick={() => onOpenConversation(conversation.id, conversation.title)}
                    className={cn(
                      "flex w-full min-w-0 items-center gap-3 px-5 py-3 text-left transition-colors",
                      "hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none",
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-foreground">
                        {conversation.title || "Untitled conversation"}
                      </span>
                      <span className="block text-xs text-muted-foreground tabular-nums">
                        {conversation.answers} {conversation.answers === 1 ? "answer" : "answers"} by {agent.name}
                      </span>
                    </span>
                    <span className="shrink-0 text-sm font-semibold tabular-nums text-foreground">
                      {formatCompactTokens(conversation.totalTokens)}
                    </span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  </button>
                ))}
              </SoftPanel>
            )}
          </section>
        </>
      )}
    </div>
  );
}
