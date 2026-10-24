import type {
  AskUserAnswer,
  AskUserQuestion,
  ParsedHitlAction,
  ParsedHitlRequest,
} from "@/shared/lib/types";

import { AskUserAnswerSchema, AskUserPayloadSchema, AskUserQuestionSchema } from "./agui";

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

// ------------------------------------------------------
// ask_user — the agent's clarifying questions
// ------------------------------------------------------

/** At most this many questions, and this many suggested answers per question. */
export const ASK_USER_MAX_QUESTIONS = 3;
export const ASK_USER_MAX_OPTIONS = 6;

// The interrupt's value: `content` is the wrapped interrupt {id, value}, or the
// value itself.
const askUserPayload = (content: unknown) => {
  if (!content || typeof content !== "object") return null;
  const wrapped = (content as Record<string, unknown>).value ?? content;
  const parsed = AskUserPayloadSchema.safeParse(wrapped);
  return parsed.success ? parsed.data : null;
};

/** Whether a HITL interrupt is the agent asking the user questions (`ask_user`), not a tool approval. */
export const isAskUserInterrupt = (content: unknown): boolean => askUserPayload(content) !== null;

const optionText = (option: unknown): string =>
  typeof option === "string" ? option.trim() : typeof option === "number" ? String(option) : "";

/**
 * The questions of an `ask_user` interrupt, cleaned up: text trimmed, empty
 * questions and options dropped, repeated options folded, counts capped, and a
 * missing id filled in by position (`q1`, `q2`, …). Empty for any other interrupt.
 */
export const askUserQuestions = (content: unknown): AskUserQuestion[] => {
  const payload = askUserPayload(content);
  if (!payload?.questions) return [];
  const questions: AskUserQuestion[] = [];
  const ids = new Set<string>();
  for (const entry of payload.questions) {
    if (questions.length >= ASK_USER_MAX_QUESTIONS) break;
    const parsed = AskUserQuestionSchema.safeParse(entry);
    if (!parsed.success) continue;
    const question = parsed.data.question.trim();
    if (!question) continue;
    const options = [...new Set((parsed.data.options ?? []).map(optionText).filter(Boolean))].slice(
      0,
      ASK_USER_MAX_OPTIONS,
    );
    const rawId = parsed.data.id == null ? "" : String(parsed.data.id).trim();
    const id = rawId && !ids.has(rawId) ? rawId : `q${questions.length + 1}`;
    ids.add(id);
    // "Pick several" means nothing without options to pick from.
    questions.push({
      id,
      question,
      options,
      multiple: Boolean(parsed.data.multiple) && options.length > 0,
    });
  }
  return questions;
};

/**
 * The `answers` of a resolved `ask_user` interrupt (BRIDGE_HITL_RESOLVED's
 * value), in the shape the resume sent. Undefined when there are none — a
 * skip, a tool approval, or a bridge that does not echo them.
 */
export const askUserAnswers = (raw: unknown): AskUserAnswer[] | undefined => {
  if (!Array.isArray(raw)) return undefined;
  const answers: AskUserAnswer[] = [];
  for (const entry of raw) {
    const parsed = AskUserAnswerSchema.safeParse(entry);
    if (!parsed.success) continue;
    answers.push({
      id: String(parsed.data.id),
      selected: (parsed.data.selected ?? []).map(optionText).filter(Boolean),
      text: (parsed.data.text ?? "").trim(),
    });
  }
  return answers.length ? answers : undefined;
};

/** Whether an answer says anything — an option picked or words written. */
export const isAskUserAnswered = (answer: AskUserAnswer | undefined): boolean =>
  Boolean(answer && (answer.selected.length > 0 || answer.text.trim()));
