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
  InferenceStartRequest,
  InferenceStartResponse,
} from "../types";
import { requestJson } from "../http";
import { WireObjectArraySchema, WireObjectSchema } from "../schemas";
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

export async function startInference(
  userId: string,
  payload: InferenceStartRequest,
): Promise<InferenceStartResponse> {
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

  const data = (await requestJson(`${INFERENCE_BASE_PATH}/runs/${userId}/start`, {
    method: "POST",
    csrf: true,
    body,
    schema: WireObjectSchema,
    fallbackMessage: "Failed to start inference",
  })) as Record<string, unknown>;

  return {
    detail: transformConversationDetail(data.detail as Record<string, unknown>),
    summary: transformConversationSummary(data.summary as Record<string, unknown>),
    run: transformInferenceRun(data.run as Record<string, unknown>),
    message: transformMessage(data.message as Record<string, unknown>),
  };
}

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

export async function resumeInferenceRun(
  userId: string,
  runId: string,
  body: ResumeInferenceRunBody,
): Promise<InferenceRun> {
  const data = await requestJson(`${INFERENCE_BASE_PATH}/runs/${userId}/${runId}/resume`, {
    method: "POST",
    csrf: true,
    body: {
      interruptId: body.interruptId,
      threadId: body.threadId,
      decision: body.decision,
      reason: body.reason ?? null,
      value: body.value ?? null,
      decisions: body.decisions ?? null,
    },
    schema: WireObjectSchema,
    fallbackMessage: "Failed to resume inference run",
  });
  return transformInferenceRun(data);
}
