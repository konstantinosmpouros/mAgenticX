import type { ParsedHitlAction, ParsedHitlRequest } from "@/shared/lib/types";

/**
 * One gated tool call from a LangChain HITL interrupt, as the approval UI needs
 * it: the tool's name, its arguments as the structured value the model produced
 * (never a stringified copy), and the request's description.
 */
export type HitlActionRequest = {
  toolName?: string;
  args?: unknown;
  description?: string;
};

// The text LangChain's HumanInTheLoopMiddleware writes when a gate carries no
// description of its own: `${prefix}\n\nTool: ${name}\nArgs: ${args}`, where
// `args` is a Python repr. It restates the tool name and arguments the UI
// already shows properly, so it is recognised and dropped; any other text is a
// description an agent chose to write and is kept.
const GENERIC_DESCRIPTION_PREFIX = "Tool execution requires approval";

export const isGenericHitlDescription = (description: string | undefined): boolean => {
  const text = description?.trim() ?? "";
  if (!text) return true;
  if (!text.startsWith(GENERIC_DESCRIPTION_PREFIX)) return false;
  const rest = text.slice(GENERIC_DESCRIPTION_PREFIX.length).trim();
  return rest === "" || rest.startsWith("Tool:");
};

const readActionRequest = (request: unknown): HitlActionRequest => {
  if (!request || typeof request !== "object") return {};
  const r = request as Record<string, unknown>;
  const toolName =
    typeof r.action === "string" ? r.action : typeof r.name === "string" ? r.name : undefined;
  const description = typeof r.description === "string" ? r.description.trim() : undefined;
  return { toolName, args: r.args ?? undefined, description };
};

/**
 * The action requests of a HITL interrupt, in order. `content` is the wrapped
 * interrupt {id, value: {action_requests: [{action|name, args, description}],
 * review_configs}} — shapes vary across agents, so every access is defensive.
 * Empty for a payload that is not a tool-approval interrupt.
 */
export const hitlActionRequests = (content: unknown): HitlActionRequest[] => {
  if (!content || typeof content !== "object") return [];
  const wrapped = (content as Record<string, unknown>).value ?? content;
  if (!wrapped || typeof wrapped !== "object") return [];
  const requests = (wrapped as Record<string, unknown>).action_requests;
  return Array.isArray(requests) ? requests.map(readActionRequest) : [];
};

const toParsedAction = ({ toolName, args, description }: HitlActionRequest): ParsedHitlAction => {
  let argsText: string | undefined;
  if (args !== undefined && args !== null) {
    try {
      argsText = typeof args === "string" ? args : JSON.stringify(args, null, 2);
    } catch {
      argsText = String(args);
    }
  }
  return { toolName, description, argsText };
};

// Parse a LangChain HITL interrupt payload into its parts. `raw` always carries
// the full payload. The approval UI presents actions through
// `features/chat/lib/approvalPresentation.ts`; this shape serves the timeline,
// which only needs each action's tool name.
export const parseHitlInterrupt = (content: unknown): ParsedHitlRequest => {
  let raw: string;
  try {
    raw = typeof content === "string" ? content : JSON.stringify(content, null, 2);
  } catch {
    raw = String(content);
  }
  const requests = hitlActionRequests(content);
  if (requests.length === 0) return { actions: [], requestCount: 0, raw };
  const actions = requests.map(toParsedAction);
  return { ...actions[0], actions, requestCount: requests.length, raw };
};
