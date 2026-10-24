import {
  askUserQuestions,
  hitlActionRequests,
  isAskUserInterrupt,
  isGenericHitlDescription,
  type HitlActionRequest,
} from "@/features/inference/hitl";

import { mcpToolTitle } from "./mcpToolPresentation";
import {
  asToolArgs,
  humaniseName,
  isMcpTool,
  languageForPath,
  titleFromArgs,
  toDiff,
  type ToolArgs,
  undoDoubleEscaping,
} from "./toolPresentation";

/**
 * What a person needs to decide on a gated tool call.
 *
 * LangChain's approval request is `{name, args, description}`, and the default
 * description is a Python repr of the arguments under "Tool execution requires
 * approval". Shown as-is, a sub-agent hand-off read as one line of escaped
 * `\n`s followed by the same arguments again as JSON. This module turns a
 * request into a short title plus the few fields that matter, each tagged with
 * the form it renders in (plain value, Markdown, code). Pure data — the
 * rendering is `message_parts/HitlActionSummary.tsx`, used by the approval bar
 * and by the approval's record in the conversation history alike, so both say
 * the same thing.
 *
 * Titles reuse the chain of thought's (`toolPresentation.ts`) wherever those
 * read as a request; only the ones written in the past tense ("Remembered …")
 * are restated here.
 */

export type ApprovalField =
  /** A short value shown beside its label; `mono` for paths and identifiers. */
  | { kind: "text"; label: string; value: string; mono?: boolean }
  /** Prose the model wrote (a sub-agent brief, a memory): rendered as Markdown. */
  | { kind: "markdown"; label?: string; value: string }
  /** Multi-line plain text, line breaks kept. */
  | { kind: "prose"; label?: string; value: string }
  /** A command, file content, a diff or structured data. */
  | { kind: "code"; label?: string; value: string; language: string };

export type ApprovalSummary = {
  title: string;
  fields: ApprovalField[];
  /** A description the agent wrote for this gate — never the middleware's default. */
  note?: string;
};

const str = (args: ToolArgs | null, key: string): string =>
  typeof args?.[key] === "string" ? (args[key] as string) : "";

const clip = (text: string, max = 60): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

const quote = (text: string) => `"${clip(text, 50)}"`;

// A string longer than this, or with a line break, is a block, not a value.
const INLINE_MAX = 120;

const isEmpty = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  (typeof value === "string" && value.trim() === "") ||
  (Array.isArray(value) && value.length === 0) ||
  (typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === 0);

const isPrimitive = (value: unknown): value is string | number | boolean =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean";

/**
 * One argument as a field: short values inline, long text as a block, nested
 * data as JSON. `null` for an empty value — an unset option says nothing.
 */
export const argField = (key: string, value: unknown): ApprovalField | null => {
  if (isEmpty(value)) return null;
  const label = humaniseName(key);
  if (typeof value === "string") {
    return value.length > INLINE_MAX || value.includes("\n")
      ? { kind: "prose", label, value }
      : { kind: "text", label, value };
  }
  if (typeof value === "boolean") return { kind: "text", label, value: value ? "Yes" : "No" };
  if (typeof value === "number") return { kind: "text", label, value: String(value) };
  if (Array.isArray(value) && value.every(isPrimitive)) {
    const joined = value.map(String).join(", ");
    return joined.length > INLINE_MAX
      ? { kind: "prose", label, value: value.map((item) => `• ${String(item)}`).join("\n") }
      : { kind: "text", label, value: joined };
  }
  let json: string;
  try {
    json = JSON.stringify(value, null, 2);
  } catch {
    json = String(value);
  }
  return { kind: "code", label, value: json, language: "json" };
};

/** Every non-empty argument, in the order the model gave them. */
export const argFields = (args: unknown): ApprovalField[] => {
  const a = asToolArgs(args);
  if (!a) {
    // A bare string argument (or one that never parsed) is still worth reading.
    return typeof args === "string" && args.trim() ? [{ kind: "prose", value: args }] : [];
  }
  return Object.entries(a)
    .map(([key, value]) => argField(key, value))
    .filter((field): field is ApprovalField => field !== null);
};

const pathField = (path: string, label = "File"): ApprovalField[] =>
  path ? [{ kind: "text", label, value: path, mono: true }] : [];

/** The tools whose decision rests on something specific — and what that is. */
const PRESENTERS: Record<string, (a: ToolArgs) => Omit<ApprovalSummary, "note">> = {
  task: (a) => ({
    title: titleFromArgs("task", a) ?? "Hand off to a sub-agent",
    fields: str(a, "description")
      ? [{ kind: "markdown", value: undoDoubleEscaping(str(a, "description")) }]
      : [],
  }),
  write_file: (a) => ({
    title: titleFromArgs("write_file", a) ?? "Write a file",
    fields: [
      ...pathField(str(a, "file_path")),
      ...(str(a, "content")
        ? [
            {
              kind: "code" as const,
              label: "Content",
              value: str(a, "content"),
              language: languageForPath(str(a, "file_path")),
            },
          ]
        : []),
    ],
  }),
  edit_file: (a) => ({
    title: titleFromArgs("edit_file", a) ?? "Edit a file",
    fields: [
      ...pathField(str(a, "file_path")),
      ...(a.replace_all === true
        ? [{ kind: "text" as const, label: "Scope", value: "Every occurrence" }]
        : []),
      {
        kind: "code" as const,
        label: "Change",
        value: toDiff(str(a, "old_string"), str(a, "new_string")),
        language: "diff",
      },
    ],
  }),
  execute: (a) => ({
    title: "Run a shell command",
    fields: str(a, "command")
      ? [{ kind: "code", value: str(a, "command"), language: "bash" }]
      : [],
  }),
  read_file: (a) => ({
    title: titleFromArgs("read_file", a) ?? "Read a file",
    fields: pathField(str(a, "file_path")),
  }),
  view_image: (a) => ({
    title: titleFromArgs("view_image", a) ?? "View an image",
    fields: pathField(str(a, "path"), "Image"),
  }),
  remember: (a) => ({
    title: str(a, "name") ? `Remember ${quote(str(a, "name"))}` : "Save a memory",
    fields: [
      ...(str(a, "summary") ? [{ kind: "prose" as const, value: undoDoubleEscaping(str(a, "summary")) }] : []),
      ...(str(a, "content")
        ? [{ kind: "markdown" as const, value: undoDoubleEscaping(str(a, "content")) }]
        : []),
    ],
  }),
  forget: (a) => ({
    title: str(a, "name") ? `Forget ${quote(str(a, "name"))}` : "Forget a memory",
    fields: [],
  }),
  search_past_conversations: (a) => ({
    title: str(a, "query")
      ? `Search past chats for ${quote(str(a, "query"))}`
      : "Search past chats",
    fields: [],
  }),
  create_skill: (a) => {
    const files = Array.isArray(a.files)
      ? a.files
          .map((file) => str(asToolArgs(file), "path"))
          .filter(Boolean)
      : [];
    return {
      title: str(a, "name") ? `Create the skill ${quote(str(a, "name"))}` : "Create a skill",
      fields: [
        ...(str(a, "description") ? [{ kind: "text" as const, label: "Purpose", value: str(a, "description") }] : []),
        ...(str(a, "instructions")
          ? [{ kind: "markdown" as const, value: undoDoubleEscaping(str(a, "instructions")) }]
          : []),
        ...(files.length ? [{ kind: "prose" as const, label: "Files", value: files.join("\n") }] : []),
      ],
    };
  },
};

/**
 * One gated tool call as a person reads it. `serverId` comes from the tool
 * catalog and marks an MCP tool, titled "Server · Tool".
 */
export const presentApproval = (
  action: HitlActionRequest,
  serverId?: string,
): ApprovalSummary => {
  const name = action.toolName?.trim() ?? "";
  const description = action.description?.trim();
  const note = description && !isGenericHitlDescription(description) ? description : undefined;
  const args = asToolArgs(action.args);

  let summary: Omit<ApprovalSummary, "note">;
  if (!name) {
    summary = { title: "The agent is asking for your approval", fields: argFields(action.args) };
  } else if (isMcpTool(name, serverId)) {
    summary = { title: mcpToolTitle(name, serverId), fields: argFields(action.args) };
  } else if (args && PRESENTERS[name]) {
    summary = PRESENTERS[name](args);
  } else {
    summary = {
      title: titleFromArgs(name, args) ?? humaniseName(name),
      fields: argFields(action.args),
    };
  }
  return note ? { ...summary, note } : summary;
};

/**
 * Every action in an interrupt, presented. A payload that is not a tool
 * approval (a free-form question an agent raised) becomes one summary carrying
 * its text, so nothing is ever shown as a raw dump.
 */
export const presentInterrupt = (
  content: unknown,
  serverIdFor: (toolName: string) => string | undefined = () => undefined,
): ApprovalSummary[] => {
  if (isAskUserInterrupt(content)) return [presentAskUser(content)];
  const requests = hitlActionRequests(content);
  if (requests.length) {
    return requests.map((request) =>
      presentApproval(request, request.toolName ? serverIdFor(request.toolName) : undefined),
    );
  }
  const fallback = "The agent is asking for your approval";
  if (typeof content === "string") {
    return [{ title: fallback, fields: content.trim() ? [{ kind: "markdown", value: content.trim() }] : [] }];
  }
  const obj = asToolArgs(content);
  const value = obj && asToolArgs(obj.value) ? asToolArgs(obj.value) : obj;
  const question = value
    ? [value.question, value.prompt, value.message, value.text, value.description].find(
        (item): item is string => typeof item === "string" && item.trim() !== "",
      )
    : undefined;
  if (question) return [{ title: fallback, fields: [{ kind: "markdown", value: question.trim() }] }];
  return [{ title: fallback, fields: argFields(value) }];
};

/**
 * The agent's clarifying questions (`ask_user`) where a generic surface shows
 * an interrupt: "Asked: <first question>", each question (with its suggested
 * answers) as a field. The questions themselves are asked by AskUserTakeover.
 */
export const presentAskUser = (content: unknown): ApprovalSummary => {
  const questions = askUserQuestions(content);
  if (!questions.length) return { title: "The agent asked you a question", fields: [] };
  const more = questions.length > 1 ? ` (+${questions.length - 1} more)` : "";
  return {
    title: `Asked: ${clip(questions[0].question, 80)}${more}`,
    fields: questions.map((question, index) => ({
      kind: "prose" as const,
      label: questions.length > 1 ? `Question ${index + 1}` : "Question",
      value: question.options.length
        ? [question.question, ...question.options.map((option) => `• ${option}`)].join("\n")
        : question.question,
    })),
  };
};

/** "Hand off to the research sub-agent (+2 more)" — the one line under "Approval required". */
export const approvalHeadline = (summaries: ApprovalSummary[]): string => {
  if (!summaries.length) return "The agent is asking for your approval";
  const more = summaries.length > 1 ? ` (+${summaries.length - 1} more)` : "";
  return `${summaries[0].title}${more}`;
};

/** Whether a summary has anything to show beyond its title. */
export const hasApprovalDetail = (summary: ApprovalSummary): boolean =>
  summary.fields.length > 0 || Boolean(summary.note);

// Past either, a block starts clipped behind "Show more": the first lines are
// enough to recognise what is being approved.
const LONG_CHARS = 420;
const LONG_LINES = 8;

export const isLongField = (value: string): boolean =>
  value.length > LONG_CHARS || value.split("\n").length > LONG_LINES;
