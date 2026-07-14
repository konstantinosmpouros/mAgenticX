import { useMemo } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { AlertCircle, Gauge, MessagesSquare, RefreshCw } from "lucide-react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

import {
    ChartContainer,
    ChartTooltip,
    ChartTooltipContent,
    type ChartConfig,
} from "@/shared/ui/chart";
import { Skeleton } from "@/shared/ui/skeleton";
import { cn, formatCompactTokens } from "@/shared/lib/utils";
import type { ConversationUsage, UsageSummary, UsageWindow } from "@/shared/lib/types";
import { InfoCard, MetricCard, SoftPanel } from "./shared";

/**
 * UsageTab — workspace-wide token/run analytics (the former "coming soon"
 * section, now fed by GET /v1/usage/{userId}/summary) plus the per-conversation
 * stats that used to live in the composer's gauge popover. The current-
 * conversation card is computed client-side from the already-loaded messages,
 * so it renders instantly; the workspace rollup loads lazily via
 * useUsageSummary (owned by ProfilePanel).
 */
type UsageTabProps = {
    summary: UsageSummary | null;
    loading: boolean;
    error: string | null;
    onRefresh: () => void;
    /** Active-branch usage of the open conversation; null when none is open. */
    conversationUsage?: ConversationUsage | null;
    conversationTitle?: string | null;
};

const chartConfig = {
    input: { label: "Input", color: "hsl(var(--primary) / 0.45)" },
    output: { label: "Output", color: "hsl(var(--primary))" },
} satisfies ChartConfig;

/** Compact stat pill for the today / 7d / 30d recency windows. */
const WindowPill = ({ label, window: win }: { label: string; window: UsageWindow }) => (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-2xl bg-background/60 px-4 py-3">
        <span className="text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            {label}
        </span>
        <span className="text-lg font-semibold tabular-nums tracking-tight text-foreground">
            {formatCompactTokens(win.totalTokens)}
        </span>
        <span className="text-xs tabular-nums text-muted-foreground">
            {win.aiMessages} {win.aiMessages === 1 ? "response" : "responses"}
        </span>
    </div>
);

/** Fill the sparse daily series into a dense last-30-days axis (UTC days). */
const fillDailySeries = (summary: UsageSummary) => {
    const byDate = new Map(summary.daily.map((point) => [point.date, point]));
    const days: { date: string; label: string; input: number; output: number; aiMessages: number }[] = [];
    const cursor = new Date();
    cursor.setUTCDate(cursor.getUTCDate() - 29);
    for (let i = 0; i < 30; i += 1) {
        const iso = cursor.toISOString().slice(0, 10);
        const point = byDate.get(iso);
        days.push({
            date: iso,
            label: `${cursor.getUTCDate()}/${cursor.getUTCMonth() + 1}`,
            input: point?.inputTokens ?? 0,
            output: point?.outputTokens ?? 0,
            aiMessages: point?.aiMessages ?? 0,
        });
        cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return days;
};

export default function UsageTab({
    summary,
    loading,
    error,
    onRefresh,
    conversationUsage,
    conversationTitle,
}: UsageTabProps) {
    const reduceMotion = useReducedMotion();
    const dailySeries = useMemo(() => (summary ? fillDailySeries(summary) : []), [summary]);
    const maxAgentTokens = summary?.perAgent[0]?.totalTokens ?? 0;
    const hasWorkspaceUsage = (summary?.totals.aiMessages ?? 0) > 0;

    const refreshButton = (
        <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            aria-label="Refresh usage"
            className="inline-flex h-8 items-center gap-1.5 rounded-full bg-muted/50 px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
        >
            <RefreshCw size={13} className={cn(loading && "animate-spin")} aria-hidden />
            Refresh
        </button>
    );

    return (
        <div className="space-y-8">
            {conversationUsage ? (
                <InfoCard
                    eyebrow="Open now"
                    title="This conversation"
                    description={
                        conversationTitle
                            ? `Tokens consumed by the assistant in "${conversationTitle}".`
                            : "Tokens consumed by the assistant in the open conversation."
                    }
                >
                    <div className="grid gap-3 sm:grid-cols-3">
                        <MetricCard
                            label="Total tokens"
                            value={formatCompactTokens(conversationUsage.totalTokens)}
                            hint={`${conversationUsage.aiMessageCount} AI ${conversationUsage.aiMessageCount === 1 ? "response" : "responses"}`}
                        />
                        <MetricCard
                            label="Input"
                            value={formatCompactTokens(conversationUsage.totalInput)}
                            hint={`~${formatCompactTokens(conversationUsage.avgInput)} per response`}
                        />
                        <MetricCard
                            label="Output"
                            value={formatCompactTokens(conversationUsage.totalOutput)}
                            hint={`~${formatCompactTokens(conversationUsage.avgOutput)} per response`}
                        />
                    </div>
                </InfoCard>
            ) : null}

            <InfoCard
                eyebrow="Workspace"
                title="All-time usage"
                description="Everything your agents have processed across every conversation."
                headerAction={refreshButton}
            >
                {error ? (
                    <SoftPanel className="flex items-center justify-between gap-4 px-5 py-4">
                        <div className="flex min-w-0 items-center gap-3">
                            <AlertCircle size={16} className="shrink-0 text-destructive" aria-hidden />
                            <p className="text-sm text-muted-foreground">{error}</p>
                        </div>
                        <button
                            type="button"
                            onClick={onRefresh}
                            className="shrink-0 rounded-full bg-background/70 px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                            Retry
                        </button>
                    </SoftPanel>
                ) : !summary ? (
                    <div className="space-y-3">
                        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                            {Array.from({ length: 4 }, (_, index) => (
                                <Skeleton key={index} className="h-[6.5rem] rounded-[1.4rem]" />
                            ))}
                        </div>
                        <Skeleton className="h-24 rounded-[1.4rem]" />
                    </div>
                ) : (
                    <div className="space-y-3">
                        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                            <MetricCard
                                label="Total tokens"
                                value={formatCompactTokens(summary.totals.totalTokens)}
                                hint="Input + output, all time"
                            />
                            <MetricCard
                                label="Input"
                                value={formatCompactTokens(summary.totals.inputTokens)}
                                hint="Prompt + context tokens"
                            />
                            <MetricCard
                                label="Output"
                                value={formatCompactTokens(summary.totals.outputTokens)}
                                hint="Generated tokens"
                            />
                            <MetricCard
                                label="AI responses"
                                value={String(summary.totals.aiMessages)}
                                hint={`Across ${summary.conversations} ${summary.conversations === 1 ? "conversation" : "conversations"}`}
                            />
                        </div>
                        <SoftPanel className="flex gap-3 p-3 max-[520px]:flex-col">
                            <WindowPill label="Today" window={summary.today} />
                            <WindowPill label="Last 7 days" window={summary.last7Days} />
                            <WindowPill label="Last 30 days" window={summary.last30Days} />
                        </SoftPanel>
                    </div>
                )}
            </InfoCard>

            {summary && !error ? (
                <InfoCard
                    eyebrow="Activity"
                    title="Last 30 days"
                    description="Daily input and output tokens across all your conversations."
                >
                    {hasWorkspaceUsage ? (
                        <SoftPanel className="px-4 py-4">
                            <ChartContainer config={chartConfig} className="aspect-auto h-52 w-full">
                                <BarChart data={dailySeries} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
                                    <CartesianGrid vertical={false} strokeDasharray="3 3" />
                                    <XAxis
                                        dataKey="label"
                                        tickLine={false}
                                        axisLine={false}
                                        tickMargin={8}
                                        interval="preserveStartEnd"
                                        minTickGap={28}
                                    />
                                    <YAxis
                                        width={44}
                                        tickLine={false}
                                        axisLine={false}
                                        tickFormatter={(value: number) => formatCompactTokens(value)}
                                    />
                                    <ChartTooltip
                                        cursor={{ fill: "hsl(var(--muted) / 0.4)" }}
                                        content={<ChartTooltipContent />}
                                    />
                                    <Bar
                                        dataKey="input"
                                        stackId="tokens"
                                        fill="var(--color-input)"
                                        radius={[0, 0, 3, 3]}
                                        isAnimationActive={!reduceMotion}
                                    />
                                    <Bar
                                        dataKey="output"
                                        stackId="tokens"
                                        fill="var(--color-output)"
                                        radius={[3, 3, 0, 0]}
                                        isAnimationActive={!reduceMotion}
                                    />
                                </BarChart>
                            </ChartContainer>
                        </SoftPanel>
                    ) : (
                        <SoftPanel className="flex flex-col items-center gap-2 px-6 py-10 text-center">
                            <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                                <Gauge size={18} aria-hidden />
                            </span>
                            <p className="text-sm font-semibold text-foreground">No usage yet</p>
                            <p className="max-w-sm text-sm text-muted-foreground">
                                Start a conversation with an agent and its token usage will show up here.
                            </p>
                        </SoftPanel>
                    )}
                </InfoCard>
            ) : null}

            {summary && !error && summary.perAgent.length > 0 ? (
                <InfoCard
                    eyebrow="Breakdown"
                    title="By agent"
                    description="Which agents consume your tokens, ranked by total usage."
                >
                    <SoftPanel className="divide-y divide-border/40 overflow-hidden">
                        {summary.perAgent.map((agent, index) => {
                            const share = maxAgentTokens > 0 ? agent.totalTokens / maxAgentTokens : 0;
                            return (
                                <div key={agent.agentName} className="px-5 py-4">
                                    <div className="flex items-center justify-between gap-4">
                                        <div className="flex min-w-0 items-center gap-2.5">
                                            <MessagesSquare size={15} className="shrink-0 text-primary" aria-hidden />
                                            <p className="truncate text-sm font-semibold text-foreground">
                                                {agent.agentName}
                                            </p>
                                        </div>
                                        <p className="shrink-0 text-sm font-medium tabular-nums text-foreground">
                                            {formatCompactTokens(agent.totalTokens)}
                                            <span className="ml-2 text-xs font-normal text-muted-foreground">
                                                {agent.aiMessages} {agent.aiMessages === 1 ? "response" : "responses"}
                                            </span>
                                        </p>
                                    </div>
                                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-background/70">
                                        <motion.div
                                            className="h-full rounded-full bg-primary/70"
                                            initial={reduceMotion ? { width: `${share * 100}%` } : { width: 0 }}
                                            animate={{ width: `${Math.max(share * 100, 2)}%` }}
                                            transition={{ duration: 0.5, ease: "easeOut", delay: index * 0.04 }}
                                        />
                                    </div>
                                </div>
                            );
                        })}
                    </SoftPanel>
                </InfoCard>
            ) : null}
        </div>
    );
}
