import type { ReactNode } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";

import { cn, formatCompactTokens, formatModelTime } from "@/shared/lib/utils";
import { mapIcon } from "@/shared/lib/consts";
import type { UsageAgentEntity } from "@/shared/lib/types";
import {
  MIN_ANSWERS_FOR_RATIOS,
  cacheHitRate,
  callsPerAnswer,
  formatPercent,
  formatRatio,
  ratio,
  timePerAnswer,
  timePerCall,
  toolsPerAnswer,
  engineLabel,
} from "@/features/settings/lib/usageMetrics";
import { SoftPanel } from "../shared";
import { AgentKindBadge } from "./UsageParts";

// Two or three agents side by side, one row per measure. Per-answer measures
// lead because totals only say who was used most; the ▲/▼ marks show the
// highest and lowest in each row — neutral marks, not a verdict, since "more
// tokens per answer" can be a deeper agent as easily as a wasteful one.

type Measure = {
  label: string;
  value: (agent: UsageAgentEntity) => number | null;
  format: (value: number) => string;
  perAnswer?: boolean;
};

const MEASURES: Measure[] = [
  { label: "Answers", value: (a) => a.answers, format: (v) => v.toLocaleString() },
  { label: "Conversations", value: (a) => a.conversations, format: (v) => v.toLocaleString() },
  { label: "Tokens", value: (a) => a.totalTokens, format: formatCompactTokens },
  { label: "Tokens per answer", value: (a) => ratio(a.totalTokens, a.answers), format: formatCompactTokens, perAnswer: true },
  { label: "Calls per answer", value: callsPerAnswer, format: (v) => formatRatio(v), perAnswer: true },
  { label: "Tools per answer", value: toolsPerAnswer, format: (v) => formatRatio(v), perAnswer: true },
  { label: "Time per answer", value: timePerAnswer, format: formatModelTime, perAnswer: true },
  { label: "Time per call", value: timePerCall, format: formatModelTime, perAnswer: true },
  { label: "Cache hit", value: cacheHitRate, format: (v) => formatPercent(v), perAnswer: true },
];

function Cell({ children, mark }: { children: ReactNode; mark: "high" | "low" | null }) {
  return (
    <span className="flex items-center justify-end gap-1 tabular-nums">
      {children}
      {mark === "high" ? (
        <>
          <ArrowUp className="h-3 w-3 text-foreground" aria-hidden />
          <span className="sr-only">(highest)</span>
        </>
      ) : mark === "low" ? (
        <>
          <ArrowDown className="h-3 w-3 text-muted-foreground" aria-hidden />
          <span className="sr-only">(lowest)</span>
        </>
      ) : null}
    </span>
  );
}

export function UsageAgentCompare({
  agents,
  onOpenAgent,
}: {
  agents: UsageAgentEntity[];
  onOpenAgent: (agent: UsageAgentEntity) => void;
}) {
  const columns = `minmax(9rem,1.2fr) repeat(${agents.length}, minmax(7rem,1fr))`;

  const rows = MEASURES.map((measure) => {
    const values = agents.map((agent) =>
      measure.perAnswer && agent.detailedAnswers < MIN_ANSWERS_FOR_RATIOS ? null : measure.value(agent),
    );
    const known = values.filter((v): v is number => v !== null);
    const distinct = new Set(known).size > 1;
    const high = distinct ? Math.max(...known) : null;
    const low = distinct ? Math.min(...known) : null;
    return { measure, values, high, low };
  });

  return (
    <div className="space-y-4">
      <SoftPanel className="overflow-x-auto">
        <div className="min-w-[28rem]">
          <div className="grid items-end gap-3 border-b border-border/40 px-5 py-4" style={{ gridTemplateColumns: columns }}>
            <span />
            {agents.map((agent) => {
              const Icon = mapIcon(agent.icon);
              return (
                <button
                  key={agent.key}
                  type="button"
                  onClick={() => onOpenAgent(agent)}
                  className="flex min-w-0 flex-col items-end gap-1 rounded-lg text-right focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-background/70">
                    <Icon className="h-4 w-4" aria-hidden />
                  </span>
                  <span className="max-w-full truncate text-sm font-semibold text-foreground hover:underline">{agent.name}</span>
                  <span className="flex flex-wrap justify-end gap-1">
                    <AgentKindBadge kind={agent.kind} />
                  </span>
                  {engineLabel(agent.engine) ? (
                    <span className="text-[0.68rem] text-muted-foreground">{engineLabel(agent.engine)}</span>
                  ) : null}
                </button>
              );
            })}
          </div>
          {rows.map(({ measure, values, high, low }) => (
            <div
              key={measure.label}
              className="grid items-center gap-3 border-b border-border/30 px-5 py-2.5 text-sm last:border-b-0"
              style={{ gridTemplateColumns: columns }}
            >
              <span className="text-muted-foreground">{measure.label}</span>
              {values.map((value, index) => (
                <Cell key={agents[index].key} mark={value === null ? null : value === high ? "high" : value === low ? "low" : null}>
                  <span className={cn(value === null ? "text-muted-foreground" : "text-foreground")}>
                    {value === null ? "—" : measure.format(value)}
                  </span>
                </Cell>
              ))}
            </div>
          ))}
          {(["subagents", "models"] as const).map((field) => (
            <div
              key={field}
              className="grid items-start gap-3 border-t border-border/30 px-5 py-2.5 text-sm"
              style={{ gridTemplateColumns: columns }}
            >
              <span className="text-muted-foreground">{field === "subagents" ? "Sub-agents used" : "Models used"}</span>
              {agents.map((agent) => (
                <span key={agent.key} className="text-right text-xs text-foreground [overflow-wrap:anywhere]">
                  {agent[field].length ? agent[field].join(", ") : "—"}
                </span>
              ))}
            </div>
          ))}
        </div>
      </SoftPanel>
      <p className="text-xs text-muted-foreground">
        ▲ highest and ▼ lowest in each row. Per-answer measures need at least {MIN_ANSWERS_FOR_RATIOS} answers in the
        range; sub-agents, models, calls and time are recorded from Oct 8 onward.
      </p>
    </div>
  );
}
