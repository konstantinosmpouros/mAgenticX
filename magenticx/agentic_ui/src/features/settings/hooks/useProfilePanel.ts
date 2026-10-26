import { useCallback } from "react";

import { useSkills } from "@/features/settings/hooks/useSkills";
import type { CustomSkillCreatePayload, UserSkill } from "@/shared/lib/types";

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
}: UseProfilePanelCtx) {
  const skills = useSkills({ userId, toast, initialPool, authResolved });
  const { addRemoteToPool, createCustomInPool, removeFromPool } = skills;

  const handleAddRemoteSkill = useCallback(
    async (sourceId: string, skillId: string): Promise<boolean> => {
      const added = await addRemoteToPool(sourceId, skillId);
      if (added) requestPersist();
      return added;
    },
    [addRemoteToPool, requestPersist],
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

  return {
    ...skills,
    handleAddRemoteSkill,
    handleCreateCustomSkill,
    handleRemoveSkillFromPool,
  };
}
