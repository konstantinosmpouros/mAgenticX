import { useCallback } from "react";

import { useSkills } from "@/features/settings/hooks/useSkills";
import { useUserAgents } from "@/features/settings/hooks/useUserAgents";
import type {
  Agent,
  CustomAgentWritePayload,
  CustomSkillCreatePayload,
  UserSkill,
} from "@/shared/lib/types";

type ToastFn = (opts: {
  title: string;
  description?: string;
  variant?: string;
  duration?: number;
}) => void;

type UseProfilePanelCtx = {
  userId: string | null;
  toast: ToastFn;
  initialPool?: UserSkill[] | null;
  /** False until the session has been confirmed against the cookies. */
  authResolved?: boolean;
  requestPersist: () => void;
  /**
   * Re-pull the shared agent catalog after an agent mutation. Owned by
   * ChatPage because the catalog is app-wide state (the header picker, task
   * form and per-agent tabs all read it), not panel state — this hook's own
   * `myAgents` list is only the authoring view of it.
   */
  refreshAgentCatalog: (options?: { removedAgentId?: string }) => Promise<void>;
};

// Controller for the ProfilePanel's own hook layer. Wraps useSkills with the
// persist-aware mutation callbacks that are wired exclusively to the panel's
// "Skills" tab, so ChatPage no longer carries that skill plumbing inline.
// Shared data (the global catalog, tools, preferences, conversation lists) and
// the app-wide profile-open/active-tab UI state stay in ChatPage by design —
// they have consumers outside the panel.
export function useProfilePanel({
  userId,
  toast,
  initialPool,
  authResolved,
  requestPersist,
  refreshAgentCatalog,
}: UseProfilePanelCtx) {
  const skills = useSkills({ userId, toast, initialPool, authResolved });
  const { addGlobalToPool, createCustomInPool, removeFromPool } = skills;
  const userAgents = useUserAgents({ userId, toast, authResolved });

  const handleAddGlobalSkill = useCallback(
    async (skillName: string) => {
      await addGlobalToPool(skillName);
      requestPersist();
    },
    [addGlobalToPool, requestPersist],
  );

  const handleCreateCustomSkill = useCallback(
    async (payload: CustomSkillCreatePayload): Promise<UserSkill | null> => {
      const created = await createCustomInPool(payload);
      if (created) requestPersist();
      return created;
    },
    [createCustomInPool, requestPersist],
  );

  const handleRemoveSkillFromPool = useCallback(
    async (skillName: string) => {
      await removeFromPool(skillName);
      requestPersist();
    },
    [removeFromPool, requestPersist],
  );

  // A created/edited/deleted agent changes the shared catalog every other
  // surface renders from (header picker, Skills/Memories per-agent lists, task
  // form), so each mutation re-pulls it. `refreshAgentCatalog` also persists
  // the snapshot, which is why these no longer call `requestPersist` directly —
  // doing both would write the snapshot twice, once with the stale list.
  const handleCreateAgent = useCallback(
    async (payload: CustomAgentWritePayload): Promise<Agent | null> => {
      const created = await userAgents.createAgent(payload);
      if (created) await refreshAgentCatalog();
      return created;
    },
    [userAgents, refreshAgentCatalog],
  );

  const handleUpdateAgent = useCallback(
    async (agentId: string, payload: CustomAgentWritePayload): Promise<Agent | null> => {
      const saved = await userAgents.updateAgent(agentId, payload);
      if (saved) await refreshAgentCatalog();
      return saved;
    },
    [userAgents, refreshAgentCatalog],
  );

  const handleDeleteAgent = useCallback(
    async (agentId: string): Promise<boolean> => {
      const removed = await userAgents.deleteAgent(agentId);
      // Pass the id so a selection pointing at the deleted agent is
      // re-pointed instead of leaving the picker on a dead id.
      if (removed) await refreshAgentCatalog({ removedAgentId: agentId });
      return removed;
    },
    [userAgents, refreshAgentCatalog],
  );

  return {
    ...skills,
    ...userAgents,
    handleCreateAgent,
    handleUpdateAgent,
    handleDeleteAgent,
    handleAddGlobalSkill,
    handleCreateCustomSkill,
    handleRemoveSkillFromPool,
  };
}
