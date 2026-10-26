import { useCallback, useMemo, useRef, useState } from "react";

import { validateMyAgent } from "@/shared/lib/api";
import type { AgentDraft, AgentDraftSubAgent, CustomAgentWritePayload } from "@/shared/lib/types";
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
        const found: DraftIssue[] = (
          result.issues.length
            ? result.issues
            : result.errors.map((message) => ({ path: "", message, severity: "error" as const }))
        ).map((item) => ({ ...item, source: "server" as const }));
        const placed = placeIssues(found, sentDraft);
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

  return { issues, checking, checked: checked !== null, validateNow };
}
