import { useCallback, useEffect, useState } from "react";

import { getAgentTools, setAgentToolApproval, setAgentToolEnabled } from "@/shared/lib/api";
import type { AgentToolRow, AgentToolsResponse } from "@/shared/lib/types";

/**
 * One agent's live tool rows for this account, and the two switches on each:
 * whether the agent may use the tool, and whether it asks first.
 *
 * Moved out of the old Settings → Agents tab, unchanged in behaviour: each
 * switch is written optimistically, reconciled with the rows the server sends
 * back, and rolled back on failure. The agents service subtracts the disabled
 * set from the agent's declared tools at run time, so these apply to the next
 * run straight away — there is no Save.
 *
 * `agentId` null (or `enabled` false — only deep agents have a tool model) loads
 * nothing.
 */
export function useAgentTools({
  userId,
  agentId,
  enabled = true,
}: {
  userId: string | null;
  agentId: string | null;
  enabled?: boolean;
}) {
  const [resp, setResp] = useState<AgentToolsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [togglingKey, setTogglingKey] = useState<string | null>(null);

  useEffect(() => {
    setResp(null);
    setError(null);
    if (!agentId || !enabled) return;
    if (!userId) {
      setError("Sign in to manage agent tools.");
      return;
    }
    let cancelled = false;
    setLoading(true);
    getAgentTools(userId, agentId)
      .then((data) => {
        if (!cancelled) setResp(data);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load agent tools.");
        setResp(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, agentId, enabled]);

  /** Flip one row's field locally (the optimistic write, or its rollback). */
  const patchRow = (key: string, patch: Partial<AgentToolRow>) =>
    setResp((prev) =>
      prev
        ? { ...prev, tools: prev.tools.map((t) => (t.key === key ? { ...t, ...patch } : t)) }
        : prev,
    );

  const toggleTool = useCallback(
    async (row: AgentToolRow) => {
      if (!userId || !agentId || togglingKey) return;
      // A prebuilt tool is built downstream of the tool list we hand the runtime,
      // so nothing stored could switch it off; the server refuses it.
      if (row.kind === "builtin") return;
      setTogglingKey(row.key);
      setError(null);
      patchRow(row.key, { enabled: !row.enabled });
      try {
        setResp(await setAgentToolEnabled(userId, agentId, row.key, !row.enabled));
      } catch (err) {
        patchRow(row.key, { enabled: row.enabled });
        setError(err instanceof Error ? err.message : "Failed to update tool.");
      } finally {
        setTogglingKey(null);
      }
    },
    [userId, agentId, togglingKey],
  );

  const toggleApproval = useCallback(
    async (row: AgentToolRow) => {
      if (!userId || !agentId || togglingKey) return;
      // A locked gate is re-applied by the runtime after every user choice, so
      // storing "off" would show it cleared while every call still paused.
      if (row.approvalLocked) return;
      setTogglingKey(row.key);
      setError(null);
      patchRow(row.key, { approval: !row.approval });
      try {
        setResp(await setAgentToolApproval(userId, agentId, row.key, !row.approval));
      } catch (err) {
        patchRow(row.key, { approval: row.approval });
        setError(err instanceof Error ? err.message : "Failed to update approval.");
      } finally {
        setTogglingKey(null);
      }
    },
    [userId, agentId, togglingKey],
  );

  return {
    tools: resp?.tools ?? [],
    loading,
    error,
    togglingKey,
    toggleTool,
    toggleApproval,
  };
}
