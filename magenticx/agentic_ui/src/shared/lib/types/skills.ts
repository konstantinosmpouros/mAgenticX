// ------------------------------------------------------
// Skill Schemas
// ------------------------------------------------------
import type { SkillFile } from "../schemas";

// `Skill`, `UserSkill`, `SkillFile`, `UserSkillDetail` are inferred from their
// Zod schemas (see `../schemas`).
export type { Skill, UserSkill, SkillFile, UserSkillDetail } from "../schemas";

// Skills tab sub-view. The tab opens on the hub (a row per area); each row
// navigates into a dedicated view, and a Back control returns to the hub.
export type SkillsSubView = "hub" | "global" | "mine" | "agents" | "create";

// A node in a skill's folder tree, derived from a flat list of file paths.
// `path` is the full relative path to this node; folders have children.
export type SkillTreeNode = {
  name: string;
  path: string;
  isDir: boolean;
  children: SkillTreeNode[];
};

// Form payload for creating a user-owned custom skill. The folder is described
// as a list of files; exactly one must be "SKILL.md".
export type CustomSkillCreatePayload = {
  name: string;
  description: string;
  files: SkillFile[];
};

// Per-(user, agent) skill selection. Map shape is { [agentId]: Set<skillName> }
// stored as plain object so it serialises cleanly through React state.
// The bridge endpoint returns a plain string[] per (user, agent); the hook
// hydrates this map by fetching per-agent on demand.
export type UserAgentSkillSelection = Record<string, string[]>;
