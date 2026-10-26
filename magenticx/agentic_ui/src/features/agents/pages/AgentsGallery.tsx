import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";

import type { Agent } from "@/shared/lib/types";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { useAgentsPage } from "@/features/agents/context";
import { AgentsIndex } from "@/features/agents/components/gallery/AgentsIndex";
import { PageHeader } from "@/features/agents/components/page";
import { useEscapeTo, usePageTitle } from "@/features/agents/hooks/usePageChrome";
import { PRIMARY_BUTTON } from "@/features/agents/lib/styles";
import { useExportAgent } from "@/features/agents/hooks/useExportAgent";
import { buildAgentCards } from "@/features/agents/lib/gallery";
import { agentEditPath, agentPath, newAgentPath } from "@/features/agents/lib/routes";

/**
 * `/agents` — every agent the user can chat with, platform and their own, and
 * the way in to building one. A card opens the agent's page; a custom agent's
 * menu edits, duplicates, exports or deletes it.
 */
export default function AgentsGallery() {
  const { userId, agents, userAgents, onClose } = useAgentsPage();
  const navigate = useNavigate();
  const { exportAgent } = useExportAgent(userId);
  const [pendingDelete, setPendingDelete] = useState<Agent | null>(null);

  usePageTitle("Agents");
  useEscapeTo(onClose, !pendingDelete);

  const cards = useMemo(
    () => buildAgentCards(agents, userAgents.myAgents),
    [agents, userAgents.myAgents],
  );
  const canAuthor = Boolean(userId);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Agents"
        subtitle="The agents you can chat with — the platform's, and the ones you build."
        actions={
          canAuthor ? (
            <button
              type="button"
              onClick={() => navigate(newAgentPath())}
              className={PRIMARY_BUTTON}
            >
              <Plus className="h-4 w-4" aria-hidden />
              <span className="max-[380px]:sr-only">New agent</span>
            </button>
          ) : null
        }
      />

      <div className="scrollbar-muted min-h-0 flex-1 overflow-y-auto px-4 sm:px-6">
        <div className="mx-auto w-full max-w-5xl pb-10 pt-2">
          <AgentsIndex
            cards={cards}
            canAuthor={canAuthor}
            busyAgentId={userAgents.busyAgentId}
            onOpen={(agent) => navigate(agentPath(agent.id))}
            onCreate={() => navigate(newAgentPath())}
            onEdit={(agent) => navigate(agentEditPath(agent.id))}
            onDuplicate={(agent) => navigate(newAgentPath(agent.id))}
            onExport={(agent) => void exportAgent(agent)}
            onDelete={setPendingDelete}
          />
        </div>
      </div>

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title={`Delete ${pendingDelete?.name ?? "agent"}?`}
        description="Its instructions, skills, sub-agents and files are removed. Conversations that used it are kept, but it will no longer appear in your composer."
        confirmLabel="Delete agent"
        onConfirm={async () => {
          if (pendingDelete) await userAgents.deleteAgent(pendingDelete.id);
        }}
      />
    </div>
  );
}
