/**
 * The builder's Approvals: Ask / Don't ask for every tool the agent will have,
 * chosen while building and saved after the agent itself as this user's
 * approval preferences — the rows the agent's own Approvals tab edits, so the
 * two always agree (plan 44 §0, decision 4).
 *
 * Each switch has three values to keep apart:
 *
 * - its **default**: what the definition says before anyone chooses — the
 *   definition's own `hitl` if it names the tool (an imported YAML), else the
 *   platform's (`hitlDefault` for a built-in, off for an MCP tool);
 * - its **baseline**: what is in force now — on an agent being edited its
 *   current row (the user's earlier choice included), else the default;
 * - its **value**: what the user picked here, else the baseline.
 *
 * Saving sends only what moved off the baseline, and a value back on the
 * default as `null`, which clears the stored choice instead of pinning it.
 * `execute` is locked on Ask and `ask_user` never asks; neither is ever sent.
 */
import type { AgentDraft, AgentToolRow, BuiltinToolInfo, ToolMetadata } from "@/shared/lib/types";
import { toolNameOf } from "./agentSpec";

export type ApprovalRow = {
  /** The tool's key in the agent's tool rows: a built-in's name, an MCP tool's `server/tool`. */
  key: string;
  name: string;
  description: string;
  /** A built-in's family, or the MCP server id. */
  group: string;
  builtin: boolean;
  /** `execute`: always asks, whatever anyone chooses. */
  locked: boolean;
  /** False for a tool that is itself a question to the user (`ask_user`). */
  gateable: boolean;
  /** What the definition asks before anyone chooses. */
  defaultValue: boolean;
  /** What is in force now (see the module note). */
  baseline: boolean;
  value: boolean;
  /** The value differs from the default — marked in the list, with a way back. */
  changed: boolean;
};

/**
 * Plain words for turning off a tool that asks by default. Named per tool where
 * we know what it does; any other risky one gets the generic line.
 */
const RISK_NOTES: Record<string, string> = {
  write_file: "This agent will write files without asking.",
  edit_file: "This agent will change files without asking.",
  task: "This agent will hand work to its sub-agents without asking.",
  forget: "This agent will forget things it remembered without asking.",
  create_skill: "This agent will create skills without asking.",
};

/** The warning to show when this row is set not to ask, or null when that is not risky. */
export const riskNote = (row: ApprovalRow): string | null =>
  row.value || !row.defaultValue || row.locked
    ? null
    : (RISK_NOTES[row.name] ?? `This agent will use ${row.name} without asking.`);

/**
 * The rows the Approvals tab lists: every built-in, then the MCP tools the
 * agent declares, in their order. `liveRows` is the agent's current tool rows
 * when editing — the baselines — and null for a new agent.
 */
export function approvalRows({
  draft,
  builtins,
  catalog,
  liveRows,
}: {
  draft: AgentDraft;
  builtins: BuiltinToolInfo[];
  catalog: ToolMetadata[];
  liveRows: AgentToolRow[] | null;
}): ApprovalRow[] {
  const live = new Map((liveRows ?? []).map((row) => [row.key, row]));
  const hitl = draft.hitl ?? {};
  const make = (base: Omit<ApprovalRow, "baseline" | "value" | "changed">): ApprovalRow => {
    const current = live.get(base.key);
    const baseline = base.locked
      ? true
      : !base.gateable
        ? false
        : current
          ? current.approval
          : base.defaultValue;
    const chosen = draft.approvals?.[base.key];
    const value = base.locked ? true : !base.gateable ? false : (chosen ?? baseline);
    return { ...base, baseline, value, changed: value !== base.defaultValue };
  };

  // The catalog first; an older bridge without it still has the edited
  // agent's own built-in rows to show.
  const builtinRows: Array<Omit<ApprovalRow, "baseline" | "value" | "changed">> = builtins.length
    ? builtins.map((tool) => ({
        key: tool.name,
        name: tool.name,
        description: tool.description,
        group: tool.group || "Built-in",
        builtin: true,
        locked: tool.locked,
        gateable: tool.gateable,
        defaultValue: tool.locked ? true : tool.gateable && (hitl[tool.name] ?? tool.hitlDefault),
      }))
    : (liveRows ?? [])
        .filter((row) => row.kind === "builtin")
        .map((row) => ({
          key: row.key,
          name: row.name,
          description: row.description,
          group: row.group,
          builtin: true,
          locked: row.approvalLocked && row.approval,
          gateable: !(row.approvalLocked && !row.approval),
          defaultValue: hitl[row.name] ?? row.approval,
        }));

  const byKey = new Map(catalog.map((tool) => [`${tool.serverId}/${tool.toolName}`, tool]));
  const mcpRows = draft.tools.map((key) => {
    const tool = byKey.get(key);
    const name = toolNameOf(key);
    return {
      key,
      name,
      description: tool?.description ?? live.get(key)?.description ?? "",
      group: key.slice(0, Math.max(0, key.indexOf("/"))) || "MCP",
      builtin: false,
      locked: false,
      gateable: true,
      defaultValue: hitl[name] ?? false,
    };
  });

  return [...builtinRows, ...mcpRows].map(make);
}

/**
 * What a save sends to `PUT …/tools/approvals`: every switchable row whose
 * value moved off its baseline — `null` when it moved back to the default, so
 * the stored choice is cleared rather than pinned. Empty means no call at all.
 */
export function approvalChanges(rows: ApprovalRow[]): Record<string, boolean | null> {
  const changes: Record<string, boolean | null> = {};
  for (const row of rows) {
    if (row.locked || !row.gateable || row.value === row.baseline) continue;
    changes[row.key] = row.value === row.defaultValue ? null : row.value;
  }
  return changes;
}

/** Rows grouped for the list: built-in families first, then MCP servers. */
export function groupApprovalRows(rows: ApprovalRow[]): Array<{ id: string; builtin: boolean; rows: ApprovalRow[] }> {
  const groups = new Map<string, { id: string; builtin: boolean; rows: ApprovalRow[] }>();
  for (const row of rows) {
    const id = `${row.builtin ? "b" : "m"}:${row.group}`;
    const group = groups.get(id) ?? { id: row.group, builtin: row.builtin, rows: [] };
    group.rows.push(row);
    groups.set(id, group);
  }
  return [...groups.values()];
}
