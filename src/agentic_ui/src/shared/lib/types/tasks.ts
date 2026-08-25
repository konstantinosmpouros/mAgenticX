// ------------------------------------------------------
// Scheduled Tasks — recurring/one-off agent jobs that fire headlessly.
// ------------------------------------------------------
import type { InferenceRunStatus } from "./inference";

export type ScheduleKind = "one_off" | "interval" | "cron";
export type TaskTargetMode = "fresh" | "bound";
export type ScheduledTaskStatus = "active" | "paused" | "completed" | "failed";

export type ScheduledTask = {
  id: string;
  agentId?: string | null;
  agentName?: string | null;
  agentSlug?: string | null;
  conversationId?: string | null;
  title?: string | null;
  prompt: string;
  isPrivate: boolean;
  targetMode: TaskTargetMode | string;
  scheduleKind: ScheduleKind | string;
  scheduleSpec: Record<string, any>;
  timezone?: string | null;
  status: ScheduledTaskStatus | string;
  nextRunAt?: Date | null;
  lastRunAt?: Date | null;
  lastRunStatus?: string | null;
  lastRunMessageId?: string | null;
  lastError?: string | null;
  runCount: number;
  maxRuns?: number | null;
  expiresAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
  // Derived server-side from the latest fire's message — the authoritative live
  // status of the most recent run, and the conversation to open for its result.
  liveStatus?: InferenceRunStatus | string | null;
  lastRunConversationId?: string | null;
};

export type ScheduledTaskCreatePayload = {
  agentId: string;
  prompt: string;
  title?: string;
  targetMode: TaskTargetMode;
  scheduleKind: ScheduleKind;
  runAt?: string; // ISO-8601 UTC (one_off)
  intervalSeconds?: number; // interval
  cronExpr?: string; // cron
  timezone?: string; // IANA tz (cron)
  isPrivate?: boolean;
  maxRuns?: number;
  expiresAt?: string; // ISO-8601 UTC
};

export type ScheduledTaskUpdatePayload = {
  title?: string;
  prompt?: string;
  status?: "active" | "paused";
  agentId?: string;
  targetMode?: TaskTargetMode;
  isPrivate?: boolean;
  maxRuns?: number;
  expiresAt?: string; // ISO-8601 UTC
  scheduleKind?: ScheduleKind;
  runAt?: string; // ISO-8601 UTC (one_off)
  intervalSeconds?: number; // interval
  cronExpr?: string; // cron
  timezone?: string; // IANA tz (cron)
};
