import { useMemo } from "react";

import { presentInterrupt, type ApprovalSummary } from "@/features/chat/lib/approvalPresentation";
import { useWorkspaceStore } from "@/shared/stores/workspaceStore";

/**
 * A HITL interrupt's actions as approval summaries, one per gated tool call.
 * MCP tools arrive under bare names; the workspace's tool catalog says which
 * server each belongs to, which is what titles them "Server · Tool".
 */
export function useApprovalSummaries(content: unknown): ApprovalSummary[] {
  const availableTools = useWorkspaceStore((s) => s.availableTools);
  return useMemo(
    () =>
      presentInterrupt(
        content,
        (toolName) =>
          availableTools.find((tool) => tool.toolName === toolName)?.serverId || undefined,
      ),
    [content, availableTools],
  );
}
