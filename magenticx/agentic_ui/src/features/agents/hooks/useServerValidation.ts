import { useCallback, useMemo, useRef, useState } from "react";

import { validateMyAgent } from "@/shared/lib/api";
import type {
  AgentDraft,
  AgentDraftSubAgent,
  AgentIssue,
  CustomAgentWritePayload,
} from "@/shared/lib/types";
import { placeIssues, ROOT_UID, type PlacedIssue } from "@/features/agents/lib/agentIssues";
import type { DraftIssue } from "@/features/agents/lib/agentRules";

/** Each node's own content (its children excluded), by uid — what an edit changes. */
function nodeSignatures(draft: AgentDraft): Map<string, string> {
  const signatures = new Map<string, string>();
  const { subagents, ...root } = draft;
  signatures.set(ROOT_UID, JSON.stringify(root));
  const walk = (nodes: AgentDraftSubAgent[]) => {
    for (const { subagents: children, ...node } of nodes) {
      signatures.set(node.uid, JSON.stringify(node));
      walk(children);
    }
  };
  walk(subagents);
  return signatures;
}

/** A server answer's issues, placed on the draft it was about; bare `errors` when it has no issues. */
function placeServerIssues(
  answer: { issues: AgentIssue[]; errors: string[] },
  sentDraft: AgentDraft,
): PlacedIssue[] {
  const found: DraftIssue[] = (
    answer.issues.length
      ? answer.issues
      : answer.errors.map((message) => ({ path: "", message, severity: "error" as const }))
  ).map((item) => ({ ...item, source: "server" as const }));
  return placeIssues(found, sentDraft);
}

/**
 * The server's validate, for what only it can check — the model allowlist, the
 * MCP gateway's catalog, the skill pool, reserved slugs. It runs **only when
 * asked** (Create / Save, `validateNow`), never on a timer while the user edits:
 * the builder's own rules (`agentRules`) cover the rest live, in the browser.
 *
 * Its issues are placed on nodes against the draft that was sent (by uid). Once
 * the user edits a node, that node's server issues are dropped — they described
 * the content before the edit, and the next Save checks again.
 */
export function useServerValidation({
  userId,
  draft,
  payload,
}: {
  userId: string | null;
  draft: AgentDraft;
  payload: CustomAgentWritePayload;
}) {
  const [checked, setChecked] = useState<{
    issues: PlacedIssue[];
    signatures: Map<string, string>;
  } | null>(null);
  const [checking, setChecking] = useState(false);
  const sequence = useRef(0);

  const run = useCallback(
    async (sentDraft: AgentDraft, sent: CustomAgentWritePayload) => {
      if (!userId) return null;
      const mine = ++sequence.current;
      setChecking(true);
      try {
        const result = await validateMyAgent(userId, sent);
        const placed = placeServerIssues(result, sentDraft);
        if (mine === sequence.current) {
          setChecked({ issues: placed, signatures: nodeSignatures(sentDraft) });
        }
        return { valid: result.valid, issues: placed };
      } catch {
        return null;
      } finally {
        if (mine === sequence.current) setChecking(false);
      }
    },
    [userId],
  );

  // The last answer's issues, minus those on nodes edited since.
  const issues = useMemo(() => {
    if (!checked) return [];
    const now = nodeSignatures(draft);
    return checked.issues.filter(
      (item) => now.get(item.target.uid) === checked.signatures.get(item.target.uid),
    );
  }, [checked, draft]);

  /** Validate this draft now (Save's first step). Null when the call itself failed. */
  const validateNow = useCallback(() => run(draft, payload), [run, draft, payload]);

  /**
   * Take a server answer that came from elsewhere — a "Try it" message the
   * server refused (422) — as the latest check, placed like validate's own.
   */
  const adopt = useCallback(
    (answer: { issues: AgentIssue[]; errors: string[] }, sentDraft: AgentDraft) => {
      ++sequence.current;
      const placed = placeServerIssues(answer, sentDraft);
      setChecked({ issues: placed, signatures: nodeSignatures(sentDraft) });
      setChecking(false);
      return placed;
    },
    [],
  );

  return { issues, checking, checked: checked !== null, validateNow, adopt };
}
