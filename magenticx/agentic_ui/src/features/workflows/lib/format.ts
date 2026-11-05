import type {
  TimelineToolExecution,
  WorkflowRun,
  WorkflowStatePatchOp,
  WorkflowToolCall,
} from "@/shared/lib/types";

/**
 * Formatting for the workflow view: durations, times, triggers, error text,
 * and the adapter that lets the chat's tool-call views draw a workflow tool
 * call. Pure — no React, no clock of its own (callers pass `now`).
 */

/** 850 → "850 ms", 4200 → "4.2 s", 95000 → "1m 35s", 4000000 → "1h 6m". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const parseTime = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const value = Date.parse(iso);
  return Number.isNaN(value) ? null : value;
};

/** "just now", "4 min ago", "3 h ago", else the date ("12 Oct, 14:05"). */
export function formatRelativeTime(iso: string | null | undefined, now: number): string {
  const time = parseTime(iso);
  if (time === null) return "";
  const diff = Math.max(0, now - time);
  if (diff < 45_000) return "just now";
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(time).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Wall-clock time of an instant ("14:05:09"), for the timeline. */
export function formatClock(iso: string | null | undefined): string {
  const time = parseTime(iso);
  if (time === null) return "";
  return new Date(time).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** How long a run took (or has taken, while it runs). */
export function runDurationMs(
  run: Pick<WorkflowRun, "startedAt" | "finishedAt">,
  now: number,
): number | null {
  const start = parseTime(run.startedAt);
  if (start === null) return null;
  const end = parseTime(run.finishedAt) ?? now;
  return Math.max(0, end - start);
}

/** `manual` → "Manual", `schedule` → "Schedule", `api` → "API". */
export function formatTrigger(kind: string): string {
  const value = kind
    .replace(/^trigger\./, "")
    .replace(/[._-]+/g, " ")
    .trim();
  if (!value) return "Manual";
  if (value.toLowerCase() === "api") return "API";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** A thrown value or a hook's `error` as one readable line. */
export function errorText(error: unknown, fallback = "Something went wrong."): string {
  if (!error) return fallback;
  if (typeof error === "string") return error;
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message || fallback;
  }
  return fallback;
}

/** Pretty JSON for copy and for panes; never throws (cycles, BigInt). */
export function toPrettyJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Whether there is anything to show for a payload (not null/undefined/{}/[]/""). */
export function hasContent(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  return true;
}

/**
 * A workflow tool call in the chat timeline's shape, so the chat's own
 * argument/result views (`ToolCallArgsView` / `ToolCallResultView`) draw it the
 * way a chat draws the same tool.
 */
export function toTimelineTool(call: WorkflowToolCall): TimelineToolExecution {
  const hasResult = call.result !== null && call.result !== undefined;
  return {
    kind: "tool",
    id: call.toolCallId,
    name: call.name,
    argsText: typeof call.args === "string" ? call.args : toPrettyJson(call.args ?? {}),
    result: hasResult ? toPrettyJson(call.result) : undefined,
    state: call.error ? "output-error" : hasResult ? "output-available" : "input-available",
  };
}

/**
 * An execution's STATE_DELTA as patch ops for the State tab. The ops are
 * untyped on the wire; anything that is not an `{op, path}` object is shown as
 * an op called "?" so nothing in the delta is silently dropped.
 */
export function toPatchOps(delta: unknown[]): WorkflowStatePatchOp[] {
  return delta.map((entry) => {
    if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
      const record = entry as Record<string, unknown>;
      return {
        op: typeof record.op === "string" ? record.op : "?",
        path: typeof record.path === "string" ? record.path : "",
        value: record.value,
        hasValue: "value" in record,
      };
    }
    return { op: "?", path: "", value: entry, hasValue: true };
  });
}
