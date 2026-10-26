import { createContext, useContext, type Dispatch } from "react";

import type { AgentDraft, AgentToolRow, UserSkill } from "@/shared/lib/types";
import type { AgentCatalogs } from "@/features/agents/hooks/useAgentCatalogs";
import type { DraftAction } from "@/features/agents/hooks/useAgentDraft";
import type { IssueField, PlacedIssue } from "@/features/agents/lib/agentIssues";
import type { ApprovalRow } from "@/features/agents/lib/agentApprovals";

/**
 * What the inspector's sections share, from the builder (BuilderWorkspace):
 * the draft and its dispatch, the catalogs to pick from, and the issues —
 * already placed on their node and field, and filtered to the ones the user
 * should see now (an empty required field only once touched or after a save
 * attempt).
 */
export type BuilderContextValue = {
  draft: AgentDraft;
  dispatch: Dispatch<DraftAction>;
  mode: "create" | "edit";
  catalogs: AgentCatalogs;
  mySkills: UserSkill[];
  /** The edited agent's live tool rows (the Approvals baselines); null for a new agent. */
  liveRows: AgentToolRow[] | null;
  approvalRows: ApprovalRow[];
  /** The visible issues on one field of one node. */
  issuesFor: (uid: string, field: IssueField) => PlacedIssue[];
  /** Mark a field as touched, so its "still empty" issue may show. */
  touch: (uid: string, field: IssueField) => void;
  modelLabel: (id: string) => string;
  select: (uid: string) => void;
  addChild: (parentUid: string) => void;
  duplicate: (uid: string) => void;
  requestDelete: (uid: string) => void;
  /** The reference file the Files tab should open (an issue named it). */
  openFile: string | null;
  setOpenFile: (path: string | null) => void;
};

export const BuilderContext = createContext<BuilderContextValue | null>(null);

export function useBuilder(): BuilderContextValue {
  const value = useContext(BuilderContext);
  if (!value) throw new Error("useBuilder must be used inside the agent builder");
  return value;
}
