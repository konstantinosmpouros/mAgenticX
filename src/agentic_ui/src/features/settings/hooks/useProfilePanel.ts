import { useCallback } from "react";

import { useSkills } from "@/features/settings/hooks/useSkills";
import type { CustomSkillCreatePayload, UserSkill } from "@/shared/lib/types";

type ToastFn = (opts: { title: string; description?: string; variant?: string; duration?: number }) => void;

type UseProfilePanelCtx = {
    userId: string | null;
    toast: ToastFn;
    initialPool?: UserSkill[] | null;
    requestPersist: () => void;
};

// Controller for the ProfilePanel's own hook layer. Wraps useSkills with the
// persist-aware mutation callbacks that are wired exclusively to the panel's
// "Skills" tab, so ChatPage no longer carries that skill plumbing inline.
// Shared data (the global catalog, tools, preferences, conversation lists) and
// the app-wide profile-open/active-tab UI state stay in ChatPage by design —
// they have consumers outside the panel.
export function useProfilePanel({ userId, toast, initialPool, requestPersist }: UseProfilePanelCtx) {
    const skills = useSkills({ userId, toast, initialPool });
    const { refreshMySkills, addGlobalToPool, createCustomInPool, removeFromPool } = skills;

    const handleRefreshMySkills = useCallback(async () => {
        await refreshMySkills({ bypassRedis: true });
        requestPersist();
    }, [refreshMySkills, requestPersist]);

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

    return {
        ...skills,
        handleRefreshMySkills,
        handleAddGlobalSkill,
        handleCreateCustomSkill,
        handleRemoveSkillFromPool,
    };
}
