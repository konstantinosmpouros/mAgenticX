/**
 * Inference run REST API — start a run, list active runs, cancel, and resume a
 * HITL interrupt.
 *
 * Also owns `transformInferenceRunEvent`, the wire→app coercion for a run event
 * frame. It lives here (not in the socket module) so the dependency edge runs
 * one way only: `inference-socket.ts` imports from this module, never the
 * reverse.
 */
import type {
  InferenceRun,
  InferenceRunEvent,
  InferenceStartOutcome,
  InferenceStartRequest,
  InferenceStartResponse,
} from "../types";
import { requestJson } from "../http";
import { InferenceStartOrQueueSchema, WireObjectArraySchema, WireObjectSchema } from "../schemas";
import {
  transformConversationDetail,
  transformConversationSummary,
  transformInferenceRun,
  transformMessage,
} from "../consts";
import { INFERENCE_BASE_PATH } from "./paths";

// Folder-internal: exported for `inference-socket.ts`, deliberately NOT
// re-exported from the barrel — it is not part of the app-facing surface.
export const transformInferenceRunEvent = (event: Record<string, any>): InferenceRunEvent => ({
  type: event.type,
  run: transformInferenceRun(event.run ?? {}),
  message: event.message ? transformMessage(event.message) : null,
  summary: event.summary ? transformConversationSummary(event.summary) : null,
  // Raw AG-UI events of an "events" delta frame — consumed verbatim by the
  // timeline reducer, never field-mapped.
  events: Array.isArray(event.events) ? event.events : undefined,
});

// The start request's wire body: only the fields the caller set. Shared by a
// plain start and a start that may be queued (`startInferenceOrQueue`).
const toStartBody = (payload: InferenceStartRequest): Record<string, unknown> => {
  const body: Record<string, unknown> = {
    mode: payload.mode,
  };
  if (payload.agentId) body.agentId = payload.agentId;
  if (typeof payload.isPrivate === "boolean") body.isPrivate = payload.isPrivate;
  if (payload.title) body.title = payload.title;
  if (payload.sharedConversationToken)
    body.sharedConversationToken = payload.sharedConversationToken;
  if (payload.conversationId) body.conversationId = payload.conversationId;
  if (payload.parentMessageId) body.parentMessageId = payload.parentMessageId;
  if (payload.targetMessageId) body.targetMessageId = payload.targetMessageId;
  if (payload.messagePath?.length) body.messagePath = payload.messagePath;
  if (payload.message) body.message = payload.message;
  return body;
};

export async function startInference(
  userId: string,
  payload: InferenceStartRequest,
): Promise<InferenceStartResponse> {
  const data = await requestJson(`${INFERENCE_BASE_PATH}/runs/${userId}/start`, {
    method: "POST",
    csrf: true,
    body: toStartBody(payload),
    schema: WireObjectSchema,
    fallbackMessage: "Failed to start inference",
  });
  return toInferenceStartResponse(data);
}

/**
 * Send in a conversation that may have a run going (plan 41 §3.6). With
 * `queue_if_busy` the bridge does not answer 409 when the conversation is
 * busy: it keeps the message as the conversation's one queued message (a
 * second send replaces it) and answers 202 `{queued, queued_message}`. When
 * the conversation is free it starts the run as usual.
 */
export async function startInferenceOrQueue(
  userId: string,
  payload: InferenceStartRequest,
): Promise<InferenceStartOutcome> {
  const data = await requestJson(`${INFERENCE_BASE_PATH}/runs/${userId}/start`, {
    method: "POST",
    csrf: true,
    // The key as §14.4 names it; the rest of the body keeps its camelCase.
    body: { ...toStartBody(payload), queue_if_busy: true },
    schema: InferenceStartOrQueueSchema,
    fallbackMessage: "Failed to send the message",
  });
  return data.queued
    ? { queued: true, queuedMessage: data.queuedMessage }
    : { queued: false, response: toInferenceStartResponse(data.body) };
}

// Folder-internal: the wire→app coercion of a run start's answer, shared with
// the builder's "Try it" start (`./agents`), which answers in the same shape.
// The caller validates the body with `WireObjectSchema` first.
export const toInferenceStartResponse = (
  data: Record<string, unknown>,
): InferenceStartResponse => ({
  detail: transformConversationDetail(data.detail as Record<string, unknown>),
  summary: transformConversationSummary(data.summary as Record<string, unknown>),
  run: transformInferenceRun(data.run as Record<string, unknown>),
  message: transformMessage(data.message as Record<string, unknown>),
});

export async function getActiveInferenceRuns(userId: string): Promise<InferenceRun[]> {
  const data = await requestJson(`${INFERENCE_BASE_PATH}/runs/${userId}?status=active`, {
    schema: WireObjectArraySchema,
    fallbackMessage: "Failed to fetch active inference runs",
  });
  return data.map(transformInferenceRun);
}

export async function cancelInferenceRun(userId: string, runId: string): Promise<InferenceRun> {
  const data = await requestJson(`${INFERENCE_BASE_PATH}/runs/${userId}/${runId}/cancel`, {
    method: "POST",
    csrf: true,
    schema: WireObjectSchema,
    fallbackMessage: "Failed to cancel inference run",
  });
  return transformInferenceRun(data);
}

export type ResumeActionDecision = {
  decision: "approve" | "reject";
  reason?: string;
};

export type ResumeInferenceRunBody = {
  // LangGraph interrupt id from the HITL_INTERRUPT event the user is acting
  // on. Lets the bridge/agents service verify the right interrupt is being
  // resolved when multiple HITLs fire in sequence on the same conversation.
  interruptId: string;
  threadId: string;
  decision: "approve" | "reject";
  reason?: string;
  value?: unknown;
  // Per-action decisions for a batched interrupt (one entry per action_request,
  // in order). When present, the backend applies them positionally instead of
  // replicating the single `decision`. The `decision` field stays as the
  // overall/legacy fallback.
  decisions?: ResumeActionDecision[];
};

// Folder-internal: the resume body's wire shape, shared with a waiting task's
// resume (`./asyncTasks`) — §14.4 has it answer "as today's run resume".
export const toResumeWireBody = (body: ResumeInferenceRunBody): Record<string, unknown> => ({
  interruptId: body.interruptId,
  threadId: body.threadId,
  decision: body.decision,
  reason: body.reason ?? null,
  value: body.value ?? null,
  decisions: body.decisions ?? null,
});

export async function resumeInferenceRun(
  userId: string,
  runId: string,
  body: ResumeInferenceRunBody,
): Promise<InferenceRun> {
  const data = await requestJson(`${INFERENCE_BASE_PATH}/runs/${userId}/${runId}/resume`, {
    method: "POST",
    csrf: true,
    body: toResumeWireBody(body),
    schema: WireObjectSchema,
    fallbackMessage: "Failed to resume inference run",
  });
  return transformInferenceRun(data);
}
