import { useCallback, useState } from "react";

import { exportMyAgent } from "@/shared/lib/api";
import { useToast } from "@/shared/hooks/use-toast";
import { toastError } from "@/shared/lib/toast";
import type { Agent } from "@/shared/lib/types";
import { slugify } from "@/features/agents/lib/agentSpec";

/**
 * Export a custom agent as a `.zip` (its `agent.yaml` and files), from the
 * gallery's menu or the agent's page. `exportingId` lets the trigger show the
 * download is under way and blocks a second click while it is.
 */
export function useExportAgent(userId: string | null) {
  const { toast } = useToast();
  const [exportingId, setExportingId] = useState<string | null>(null);

  const exportAgent = useCallback(
    async (agent: Agent) => {
      if (!userId || exportingId) return;
      setExportingId(agent.id);
      try {
        await exportMyAgent(userId, agent.id, slugify(agent.name) || "agent");
      } catch (error) {
        toastError(toast, "Could not export the agent", error, {
          description: error instanceof Error ? error.message : "Please try again.",
        });
      } finally {
        setExportingId(null);
      }
    },
    [userId, exportingId, toast],
  );

  return { exportAgent, exportingId };
}
