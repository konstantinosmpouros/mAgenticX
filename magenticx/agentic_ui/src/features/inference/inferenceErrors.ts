type ApiErrorLike = Error & {
  status?: number;
  detail?: string;
};

const INFERENCE_RATE_LIMIT_TITLE = "Agent run limit reached";
const INFERENCE_RATE_LIMIT_DESCRIPTION =
  "You have reached the maximum number of agent runs per minute. Please wait a few seconds and try again.";

export function isInferenceRateLimitError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as ApiErrorLike).status === 429;
}

export function getInferenceStartErrorCopy(
  error: unknown,
  fallback: { title: string; description: string },
): { title: string; description: string } {
  if (isInferenceRateLimitError(error)) {
    return {
      title: INFERENCE_RATE_LIMIT_TITLE,
      description: INFERENCE_RATE_LIMIT_DESCRIPTION,
    };
  }

  return fallback;
}
