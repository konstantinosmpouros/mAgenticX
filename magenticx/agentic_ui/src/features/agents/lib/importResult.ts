/**
 * What an import came back as, in the three shapes the import page shows:
 *
 * - **unparsed**: the YAML didn't parse (or wasn't a mapping) — no spec, the
 *   parser's message (with its line and column) and a way to try again;
 * - **invalid**: it parsed, but the checks found errors — the agent drawn on
 *   the canvas with its issues on the nodes, to open in the builder and fix;
 * - **valid**: ready — create it as it is, or open it in the builder first.
 */
import type { AgentDraft, CustomAgentImportResult, CustomAgentWritePayload } from "@/shared/lib/types";
import { draftFromImport } from "./agentSpec";
import { placeIssues, type PlacedIssue } from "./agentIssues";
import { walkSubagents } from "./agentRules";

export type ImportOutcome =
  | { kind: "unparsed"; messages: string[] }
  | {
      kind: "valid" | "invalid";
      draft: AgentDraft;
      issues: PlacedIssue[];
      /** The payload to create it with, exactly as the server returned it. */
      payload: CustomAgentWritePayload;
      summary: ImportSummary;
    };

export type ImportSummary = {
  name: string;
  description: string;
  model: string;
  tools: number;
  skills: number;
  /** Sub-agents at every depth. */
  team: number;
  /** How deep the team goes (0 with none). */
  levels: number;
  files: number;
};

export function importOutcome(result: CustomAgentImportResult): ImportOutcome {
  const draft = draftFromImport(result);
  if (!draft) {
    const messages = result.issues.map((item) => item.message).filter(Boolean);
    return {
      kind: "unparsed",
      messages: messages.length ? messages : result.errors.length ? result.errors : ["The file couldn't be read as YAML."],
    };
  }
  const issues = placeIssues(
    result.issues.map((item) => ({ ...item, source: "server" as const })),
    draft,
  );
  let team = 0;
  let levels = 0;
  for (const { depth } of walkSubagents(draft.subagents)) {
    team += 1;
    levels = Math.max(levels, depth);
  }
  return {
    kind: result.valid && !issues.some((item) => item.severity === "error") ? "valid" : "invalid",
    draft,
    issues,
    payload: {
      spec: result.spec ?? {},
      files: result.files.map((file) => ({
        path: file.path,
        content: file.content,
        encoding: file.encoding,
      })),
    },
    summary: {
      name: draft.name,
      description: draft.description,
      model: draft.model,
      tools: draft.tools.length,
      skills: draft.skills.length,
      team,
      levels,
      files: result.files.length,
    },
  };
}

/** The file types the import takes. */
export const IMPORT_ACCEPT = ".yaml,.yml,.md,.txt,.zip";
