/**
 * "Try it" (plan 40) helpers that need no React: what counts as the same
 * draft between two messages, and how the server's refusal of a draft (a 422,
 * shaped like a create's or an update's) is read.
 */
import { ApiError } from "@/shared/lib/http";
import { CustomAgentValidationSchema } from "@/shared/lib/schemas";
import type { AgentIssue, AgentTrialStartRequest } from "@/shared/lib/types";

/**
 * The part of a trial message that is the agent itself — the draft and the
 * approval choices — as one string. Two messages ran the same agent when their
 * keys are equal; a different key puts a "Draft changed" marker before the turn.
 */
export const trialDraftKey = (body: Pick<AgentTrialStartRequest, "draft" | "approvals">): string =>
  JSON.stringify({ draft: body.draft, approvals: body.approvals });

export type TrialRefusal = {
  /** The server's one-line reason. */
  message: string;
  issues: AgentIssue[];
  errors: string[];
};

/**
 * A 422 on a trial message: the draft does not validate. Its body carries
 * `{message, errors, issues}`, which the builder places on the canvas as it
 * does a Commit's. Null for any other failure.
 */
export function trialRefusal(error: unknown): TrialRefusal | null {
  if (!(error instanceof ApiError) || error.status !== 422 || !error.detailObject) return null;
  const { errors, issues } = CustomAgentValidationSchema.parse(error.detailObject);
  const raw = error.detailObject.message;
  const message =
    typeof raw === "string" && raw.trim()
      ? raw
      : (issues[0]?.message ?? errors[0] ?? "The server refused this draft.");
  return { message, issues, errors };
}

/** A failure's message for the panel, whatever was thrown. */
export const trialErrorMessage = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : "The message could not be sent.";
