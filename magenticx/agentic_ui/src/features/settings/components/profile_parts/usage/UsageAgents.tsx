import { useEffect, useMemo, useState } from "react";
import { Bot, Check, ChevronRight, GitCompareArrows, X } from "lucide-react";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/select";
import { cn, formatCompactTokens, formatModelTime } from "@/shared/lib/utils";
import { mapIcon } from "@/shared/lib/consts";
import { getUsageAgents } from "@/shared/lib/api";
import type { UsageRange } from "@/shared/lib/api";
import type { UsageAgentEntity, UsageAgentKind } from "@/shared/lib/types";
import { useUsageQuery } from "@/features/settings/hooks/useUsageQuery";
import {
  MIN_ANSWERS_FOR_RATIOS,
  cacheHitRate,
  formatPercent,
  rangeLabel,
  ratio,
  timePerAnswer,
  engineLabel,
} from "@/features/settings/lib/usageMetrics";
import { SoftPanel } from "../shared";
import { AgentKindBadge, RangeSelect, RowsSkeleton, ShareBar, UsageEmpty, UsageError } from "./UsageParts";

// Level 1b of the Usage tab: every agent the user has worked with, as an
// entity — Omni and the other platform agents beside the user's own custom
// agents (and any since deleted) — with the numbers that make different agents
// comparable: per answer, not just in total. Tick two or three to compare them
// side by side; a row otherwise opens that agent's profile.

const MAX_COMPARE = 3;

type KindTab = "all" | "platform" | "custom";
type AgentSort = "tokens" | "perAnswer" | "time" | "cache";

const SORTS: { value: AgentSort; label: string }[] = [
  { value: "tokens", label: "Most tokens" },
  { value: "perAnswer", label: "Tokens per answer" },
  { value: "time", label: "Slowest per answer" },
  { value: "cache", label: "Best cache hit" },
];

const GROUPS: { kind: UsageAgentKind; title: string }[] = [
  { kind: "platform", title: "Platform" },
  { kind: "custom", title: "Your custom agents" },
  { kind: "deleted", title: "Deleted" },
];

const enoughAnswers = (agent: UsageAgentEntity) => agent.detailedAnswers >= MIN_ANSWERS_FOR_RATIOS;

function sortValue(agent: UsageAgentEntity, sort: AgentSort): number {
  if (sort === "tokens") return agent.totalTokens;
  if (!enoughAnswers(agent)) return -1;
  if (sort === "perAnswer") return ratio(agent.totalTokens, agent.answers) ?? -1;
  if (sort === "time") return timePerAnswer(agent) ?? -1;
  return cacheHitRate(agent) ?? -1;
}

function AgentRow({
  agent,
  largest,
  selecting,
  selected,
  onActivate,
}: {
  agent: UsageAgentEntity;
  largest: number;
  selecting: boolean;
  selected: boolean;
  onActivate: () => void;
}) {
  const Icon = mapIcon(agent.icon);
  const ratios = enoughAnswers(agent);
  const perAnswerTime = timePerAnswer(agent);
  return (
    <button
      type="button"
      onClick={onActivate}
      aria-pressed={selecting ? selected : undefined}
      className={cn(
        "group block w-full min-w-0 space-y-2 px-4 py-3.5 text-left transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none",
        selected && "bg-primary/5",
      )}
    >
      <span className="flex min-w-0 items-center gap-3">
        {selecting ? (
          <span
            className={cn(
              "flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition-colors",
              selected ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background",
            )}
            aria-hidden
          >
            {selected ? <Check className="h-3.5 w-3.5" /> : null}
          </span>
        ) : null}
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-background/70 text-foreground">
          <Icon className="h-4 w-4" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="truncate text-sm font-semibold text-foreground">{agent.name}</span>
            <AgentKindBadge kind={agent.kind} />
            {engineLabel(agent.engine) ? (
              <span className="rounded-md bg-background/70 px-1.5 py-0.5 text-[0.68rem] text-muted-foreground">
                {engineLabel(agent.engine)}
              </span>
            ) : null}
          </span>
          <span className="block truncate text-xs text-muted-foreground tabular-nums">
            {agent.answers.toLocaleString()} {agent.answers === 1 ? "answer" : "answers"} · {agent.conversations}{" "}
            {agent.conversations === 1 ? "conversation" : "conversations"}
            {agent.subagents.length ? ` · ${agent.subagents.length} sub-agents` : ""}
          </span>
        </span>
        <span className="hidden shrink-0 grid-cols-3 gap-4 text-right text-xs tabular-nums text-muted-foreground md:grid">
          <span>
            <span className="block font-medium text-foreground">
              {ratios ? formatCompactTokens(ratio(agent.totalTokens, agent.answers) ?? 0) : "—"}
            </span>
            per answer
          </span>
          <span>
            <span className="block font-medium text-foreground">
              {ratios && perAnswerTime !== null ? formatModelTime(perAnswerTime) : "—"}
            </span>
            time / answer
          </span>
          <span>
            <span className="block font-medium text-foreground">{ratios ? formatPercent(cacheHitRate(agent)) : "—"}</span>
            cache hit
          </span>
        </span>
        <span className="w-16 shrink-0 text-right text-sm font-semibold tabular-nums text-foreground">
          {formatCompactTokens(agent.totalTokens)}
        </span>
        {selecting ? null : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />}
      </span>
      <ShareBar fraction={agent.totalTokens / largest} />
      {!ratios ? (
        <span className="block text-[0.7rem] text-muted-foreground md:text-right">
          Too few answers in this range for per-answer numbers
        </span>
      ) : null}
    </button>
  );
}

export function UsageAgents({
  userId,
  range,
  onRangeChange,
  refreshToken,
  onBusyChange,
  onOpenAgent,
  onCompare,
}: {
  userId: string | null;
  range: UsageRange;
  onRangeChange: (range: UsageRange) => void;
  refreshToken: number;
  onBusyChange: (busy: boolean) => void;
  onOpenAgent: (agent: UsageAgentEntity) => void;
  onCompare: (agents: UsageAgentEntity[]) => void;
}) {
  const [kind, setKind] = useState<KindTab>("all");
  const [sort, setSort] = useState<AgentSort>("tokens");
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const query = useUsageQuery(userId ? `agents:${range}:${refreshToken}` : null, () =>
    getUsageAgents(userId ?? "", { range, kind: "all" }),
  );

  useEffect(() => onBusyChange(query.loading), [query.loading, onBusyChange]);

  const agents = useMemo(() => query.data?.items ?? [], [query.data]);
  const visible = useMemo(
    () =>
      agents
        .filter((agent) => kind === "all" || agent.kind === kind)
        .sort((a, b) => sortValue(b, sort) - sortValue(a, sort)),
    [agents, kind, sort],
  );
  const largest = Math.max(1, ...visible.map((agent) => agent.totalTokens));

  const toggle = (key: string) =>
    setSelected((current) =>
      current.includes(key) ? current.filter((k) => k !== key) : current.length < MAX_COMPARE ? [...current, key] : current,
    );

  const stopSelecting = () => {
    setSelecting(false);
    setSelected([]);
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-xl bg-muted/40 p-1" role="group" aria-label="Agent kind">
          {(["all", "platform", "custom"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              aria-pressed={kind === tab}
              onClick={() => setKind(tab)}
              className={cn(
                "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                kind === tab ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {tab === "all" ? "All" : tab === "platform" ? "Platform" : "Custom"}
            </button>
          ))}
        </div>
        <RangeSelect value={range} onChange={onRangeChange} />
        <Select value={sort} onValueChange={(value) => setSort(value as AgentSort)}>
          <SelectTrigger
            aria-label="Sort agents by"
            className="h-9 w-auto min-w-[9rem] gap-2 rounded-xl border-border/60 bg-background/60 px-3 text-xs font-medium"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="z-[90] rounded-xl border border-border/60 bg-background text-foreground shadow-lg">
            {SORTS.map((option) => (
              <SelectItem key={option.value} value={option.value} className="rounded-lg text-xs">
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="ml-auto flex items-center gap-2">
          {selecting ? (
            <>
              <button
                type="button"
                onClick={() => onCompare(agents.filter((agent) => selected.includes(agent.key)))}
                disabled={selected.length < 2}
                className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-primary px-3 text-xs font-semibold text-primary-foreground transition-[opacity,transform] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                Compare {selected.length ? `(${selected.length})` : ""}
              </button>
              <button
                type="button"
                onClick={stopSelecting}
                aria-label="Stop comparing"
                className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-muted/40 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setSelecting(true)}
              disabled={agents.length < 2}
              className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-muted/40 px-3 text-xs font-semibold text-foreground transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              <GitCompareArrows className="h-3.5 w-3.5" aria-hidden />
              Compare
            </button>
          )}
        </div>
      </div>
      {selecting ? (
        <p className="text-xs text-muted-foreground" aria-live="polite">
          Pick two or three agents to compare ({selected.length}/{MAX_COMPARE}).
        </p>
      ) : null}

      {query.error && !query.data ? (
        <UsageError message={query.error} onRetry={query.refresh} />
      ) : !query.data ? (
        <RowsSkeleton rows={4} />
      ) : visible.length === 0 ? (
        <UsageEmpty icon={Bot} title="No agents in this range">
          No {kind === "all" ? "" : `${kind} `}agent answered in the {rangeLabel(range).toLowerCase()}.
        </UsageEmpty>
      ) : (
        <div className="space-y-6">
          {GROUPS.map((group) => {
            const members = visible.filter((agent) => agent.kind === group.kind);
            if (members.length === 0) return null;
            return (
              <section key={group.kind} className="space-y-2">
                <p className="text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground">{group.title}</p>
                <SoftPanel className="divide-y divide-border/40 overflow-hidden">
                  {members.map((agent) => (
                    <AgentRow
                      key={agent.key}
                      agent={agent}
                      largest={largest}
                      selecting={selecting}
                      selected={selected.includes(agent.key)}
                      onActivate={() => (selecting ? toggle(agent.key) : onOpenAgent(agent))}
                    />
                  ))}
                </SoftPanel>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
