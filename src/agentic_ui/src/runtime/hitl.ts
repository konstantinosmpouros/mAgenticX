import type { ParsedHitlAction, ParsedHitlRequest } from "@/lib/types";

// Parse a LangChain HITL interrupt payload into the human-readable parts.
// `content` is the wrapped interrupt {id, value: {action_requests: [{action|
// name, args, description}], review_configs}} — shapes vary across agents, so
// every access is defensive and `raw` always carries the full payload.
const parseHitlAction = (request: unknown): ParsedHitlAction => {
  if (!request || typeof request !== "object") return {};
  const r = request as Record<string, any>;
  const toolName = typeof r.action === "string" ? r.action : typeof r.name === "string" ? r.name : undefined;
  const description = typeof r.description === "string" ? r.description.trim() : undefined;
  let argsText: string | undefined;
  if (r.args !== undefined && r.args !== null) {
    try {
      argsText = typeof r.args === "string" ? r.args : JSON.stringify(r.args, null, 2);
    } catch {
      argsText = String(r.args);
    }
  }
  return { toolName, description, argsText };
};

export const parseHitlInterrupt = (content: unknown): ParsedHitlRequest => {
  let raw: string;
  try {
    raw = typeof content === "string" ? content : JSON.stringify(content, null, 2);
  } catch {
    raw = String(content);
  }
  const fallback: ParsedHitlRequest = { actions: [], requestCount: 0, raw };
  if (!content || typeof content !== "object") return fallback;

  const wrapped = (content as Record<string, any>).value ?? content;
  if (!wrapped || typeof wrapped !== "object") return fallback;
  const requests = (wrapped as Record<string, any>).action_requests;
  if (!Array.isArray(requests) || requests.length === 0) return fallback;

  const actions = requests.map(parseHitlAction);
  return { ...actions[0], actions, requestCount: requests.length, raw };
};
