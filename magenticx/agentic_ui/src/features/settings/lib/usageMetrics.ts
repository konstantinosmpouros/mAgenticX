/**
 * The numbers the Usage tab derives from the bridge's totals (plan 33).
 *
 * Every ratio divides by the answers that actually report the quantity — the
 * `detailed*` counts — never by all answers: an answer from before usage
 * metrics has tokens but no call counts or model time, and counting it as
 * "0 calls, 0 s" would drag every average down. A ratio with nothing to divide
 * by is `null`, and the UI shows "—" rather than a misleading zero.
 */
import type { UsageRange } from "@/shared/lib/api";
import type { UsageDailyPoint, UsageWindow } from "@/shared/lib/types";

export const RANGE_OPTIONS: { value: UsageRange; label: string }[] = [
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "all", label: "All time" },
];

export const rangeLabel = (range: UsageRange) =>
  RANGE_OPTIONS.find((option) => option.value === range)?.label ?? "All time";

/** An agent needs this many answers in range before its per-answer ratios mean anything. */
export const MIN_ANSWERS_FOR_RATIOS = 5;

export const ratio = (part: number, whole: number): number | null => (whole > 0 ? part / whole : null);

type Detailed = Pick<UsageWindow, "cachedInputTokens" | "detailedInputTokens" | "modelMs" | "modelCalls" | "toolCalls" | "detailedAnswers">;

/** Share of input served from the provider's prompt cache. */
export const cacheHitRate = (w: Detailed) => ratio(w.cachedInputTokens, w.detailedInputTokens);
/** Model time per answer, in ms. */
export const timePerAnswer = (w: Detailed) => ratio(w.modelMs, w.detailedAnswers);
/** Model time per model call, in ms. */
export const timePerCall = (w: Detailed) => ratio(w.modelMs, w.modelCalls);
export const callsPerAnswer = (w: Detailed) => ratio(w.modelCalls, w.detailedAnswers);
export const toolsPerAnswer = (w: Detailed) => ratio(w.toolCalls, w.detailedAnswers);

export const formatPercent = (value: number | null) =>
  value === null ? "—" : `${Math.round(value * 100)}%`;

export const formatRatio = (value: number | null, digits = 1) =>
  value === null ? "—" : value.toFixed(digits);

/**
 * "vs the week before" for a KPI tile. Relative for amounts, absolute
 * percentage points for rates; `null` when there is nothing to compare with.
 */
export function describeChange(
  current: number | null,
  previous: number | null,
  kind: "amount" | "rate",
): { label: string; direction: "up" | "down" | "flat" } | null {
  if (current === null || previous === null) return null;
  if (kind === "rate") {
    const points = Math.round((current - previous) * 100);
    if (points === 0) return { label: "No change", direction: "flat" };
    return { label: `${points > 0 ? "+" : ""}${points} pts`, direction: points > 0 ? "up" : "down" };
  }
  if (previous <= 0) return null;
  const change = (current - previous) / previous;
  if (Math.abs(change) < 0.005) return { label: "No change", direction: "flat" };
  return {
    label: `${change > 0 ? "+" : ""}${Math.round(change * 100)}%`,
    direction: change > 0 ? "up" : "down",
  };
}

/** An agent's engine as the UI names it ("Deep agent", "LangGraph"). */
export const engineLabel = (engine: string | null) =>
  engine === "deep agent" ? "Deep agent" : engine === "langgraph agent" ? "LangGraph" : engine ? engine : null;

/** How full a context window is, 0–1, or null when unknown. */
export const contextFill = (tokens: number | null, window: number | null) =>
  tokens !== null && window ? Math.min(tokens / window, 1) : null;

export type DailyBar = {
  date: string;
  label: string;
  cached: number;
  fresh: number;
  output: number;
  seconds: number;
  answers: number;
};

/**
 * A sparse daily series → a dense one for the last `days` UTC days: cached
 * input, fresh (uncached) input and output tokens as separate layers, plus
 * model time — so the chart can show caching at work, or switch to time.
 */
export function fillDailySeries(points: UsageDailyPoint[], days: number): DailyBar[] {
  const byDate = new Map(points.map((point) => [point.date, point]));
  const bars: DailyBar[] = [];
  const cursor = new Date();
  cursor.setUTCDate(cursor.getUTCDate() - (days - 1));
  for (let i = 0; i < days; i += 1) {
    const iso = cursor.toISOString().slice(0, 10);
    const point = byDate.get(iso);
    const cached = Math.min(point?.cachedInputTokens ?? 0, point?.inputTokens ?? 0);
    bars.push({
      date: iso,
      label: `${cursor.getUTCDate()}/${cursor.getUTCMonth() + 1}`,
      cached,
      fresh: (point?.inputTokens ?? 0) - cached,
      output: point?.outputTokens ?? 0,
      seconds: Math.round((point?.modelMs ?? 0) / 100) / 10,
      answers: point?.aiMessages ?? 0,
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return bars;
}
