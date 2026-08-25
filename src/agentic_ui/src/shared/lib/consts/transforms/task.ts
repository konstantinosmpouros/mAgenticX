import type { ScheduledTask } from "../../types/tasks";
import { toDate } from "./base";

// Transform a scheduled task from backend to frontend type.
export const transformScheduledTask = (task: Record<string, any>): ScheduledTask => {
  const nextRunAt = task.nextRunAt ?? task.next_run_at;
  const lastRunAt = task.lastRunAt ?? task.last_run_at;
  const expiresAt = task.expiresAt ?? task.expires_at;
  const spec = task.scheduleSpec ?? task.schedule_spec;
  return {
    id: task.id,
    agentId: task.agentId ?? task.agent_id ?? null,
    agentName: task.agentName ?? task.agent_name ?? null,
    agentSlug: task.agentSlug ?? task.agent_slug ?? null,
    conversationId: task.conversationId ?? task.conversation_id ?? null,
    title: task.title ?? null,
    prompt: task.prompt ?? "",
    isPrivate: Boolean(task.isPrivate ?? task.is_private),
    targetMode: task.targetMode ?? task.target_mode ?? "fresh",
    scheduleKind: task.scheduleKind ?? task.schedule_kind ?? "interval",
    scheduleSpec: spec && typeof spec === "object" ? spec : {},
    timezone: task.timezone ?? null,
    status: task.status ?? "active",
    nextRunAt: nextRunAt ? toDate(nextRunAt) : null,
    lastRunAt: lastRunAt ? toDate(lastRunAt) : null,
    lastRunStatus: task.lastRunStatus ?? task.last_run_status ?? null,
    lastRunMessageId: task.lastRunMessageId ?? task.last_run_message_id ?? null,
    lastError: task.lastError ?? task.last_error ?? null,
    runCount: task.runCount ?? task.run_count ?? 0,
    maxRuns: task.maxRuns ?? task.max_runs ?? null,
    expiresAt: expiresAt ? toDate(expiresAt) : null,
    createdAt: toDate(task.createdAt ?? task.created_at),
    updatedAt: toDate(task.updatedAt ?? task.updated_at),
    liveStatus: task.liveStatus ?? task.live_status ?? null,
    lastRunConversationId: task.lastRunConversationId ?? task.last_run_conversation_id ?? null,
  };
};
