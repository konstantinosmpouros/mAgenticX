/**
 * Scheduled tasks API — the user's one-off, recurring, and cron-driven jobs.
 */
import type {
  ScheduledTask,
  ScheduledTaskCreatePayload,
  ScheduledTaskUpdatePayload,
} from "../types";
import { requestJson, requestVoid } from "../http";
import { WireObjectArraySchema, WireObjectSchema } from "../schemas";
import { transformScheduledTask } from "../consts";
import { SCHEDULED_TASKS_BASE_PATH } from "./paths";

export async function listScheduledTasks(userId: string): Promise<ScheduledTask[]> {
  const data = await requestJson(`${SCHEDULED_TASKS_BASE_PATH}/${userId}`, {
    schema: WireObjectArraySchema,
    fallbackMessage: "Failed to fetch scheduled tasks",
  });
  return data.map(transformScheduledTask);
}

export async function createScheduledTask(
  userId: string,
  payload: ScheduledTaskCreatePayload,
): Promise<ScheduledTask> {
  const body: Record<string, unknown> = {
    agentId: payload.agentId,
    prompt: payload.prompt,
    targetMode: payload.targetMode,
    scheduleKind: payload.scheduleKind,
  };
  if (payload.title) body.title = payload.title;
  if (payload.runAt) body.runAt = payload.runAt;
  if (typeof payload.intervalSeconds === "number") body.intervalSeconds = payload.intervalSeconds;
  if (payload.cronExpr) body.cronExpr = payload.cronExpr;
  if (payload.timezone) body.timezone = payload.timezone;
  if (typeof payload.isPrivate === "boolean") body.isPrivate = payload.isPrivate;
  if (typeof payload.maxRuns === "number") body.maxRuns = payload.maxRuns;
  if (payload.expiresAt) body.expiresAt = payload.expiresAt;

  const data = await requestJson(`${SCHEDULED_TASKS_BASE_PATH}/${userId}`, {
    method: "POST",
    csrf: true,
    body,
    schema: WireObjectSchema,
    fallbackMessage: "Failed to create scheduled task",
  });
  return transformScheduledTask(data);
}

export async function updateScheduledTask(
  userId: string,
  taskId: string,
  payload: ScheduledTaskUpdatePayload,
): Promise<ScheduledTask> {
  const body: Record<string, unknown> = {};
  if (typeof payload.title === "string") body.title = payload.title;
  if (typeof payload.prompt === "string") body.prompt = payload.prompt;
  if (payload.status) body.status = payload.status;
  if (payload.agentId) body.agentId = payload.agentId;
  if (payload.targetMode) body.targetMode = payload.targetMode;
  if (typeof payload.isPrivate === "boolean") body.isPrivate = payload.isPrivate;
  if (typeof payload.maxRuns === "number") body.maxRuns = payload.maxRuns;
  if (payload.expiresAt) body.expiresAt = payload.expiresAt;
  if (payload.scheduleKind) body.scheduleKind = payload.scheduleKind;
  if (payload.runAt) body.runAt = payload.runAt;
  if (typeof payload.intervalSeconds === "number") body.intervalSeconds = payload.intervalSeconds;
  if (payload.cronExpr) body.cronExpr = payload.cronExpr;
  if (payload.timezone) body.timezone = payload.timezone;

  const data = await requestJson(`${SCHEDULED_TASKS_BASE_PATH}/${userId}/${taskId}`, {
    method: "PATCH",
    csrf: true,
    body,
    schema: WireObjectSchema,
    fallbackMessage: "Failed to update scheduled task",
  });
  return transformScheduledTask(data);
}

export async function deleteScheduledTask(userId: string, taskId: string): Promise<void> {
  await requestVoid(`${SCHEDULED_TASKS_BASE_PATH}/${userId}/${taskId}`, {
    method: "DELETE",
    csrf: true,
    fallbackMessage: "Failed to delete scheduled task",
  });
}
