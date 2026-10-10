import { useCallback, useState } from "react";

import { removeAvatar, updateProfileName, uploadAvatar } from "@/shared/lib/api";
import type { UserProfile } from "@/shared/lib/types";
import { toast } from "@/shared/hooks/use-toast";
import { toastError } from "@/shared/lib/toast";
import { useWorkspaceStore } from "@/shared/stores/workspaceStore";

/** The longest name the bridge accepts (users.preferred_name is String(64)). */
export const MAX_PROFILE_NAME_LENGTH = 64;

/** What the photo picker offers; the bridge checks the real format again. */
export const AVATAR_ACCEPT = "image/png,image/jpeg,image/webp";

/** The bridge's upload cap (AVATAR_MAX_UPLOAD_BYTES), checked here first only
 *  to answer at once instead of after an upload. */
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

/**
 * Edit profile: the name and the photo the app shows.
 *
 * The saved profile replaces the one in the store, so the sidebar, the account
 * menu and the greeting pick the change up at once. Each action resolves
 * `true` when the change was saved.
 */
export function useEditProfile(user: UserProfile | null) {
  const setUserProfile = useWorkspaceStore((s) => s.setUserProfile);
  const [saving, setSaving] = useState(false);

  const run = useCallback(
    async (action: () => Promise<UserProfile>, done: string, failed: string): Promise<boolean> => {
      if (!user || saving) return false;
      setSaving(true);
      try {
        setUserProfile(await action());
        toast({ title: done });
        return true;
      } catch (error) {
        toastError(toast, failed, error);
        return false;
      } finally {
        setSaving(false);
      }
    },
    [saving, setUserProfile, user],
  );

  const saveName = useCallback(
    async (name: string | null): Promise<boolean> =>
      user
        ? run(
            () => updateProfileName(user.id, name),
            name === null ? "Your Microsoft name is back" : "Name saved",
            "Could not save your name",
          )
        : false,
    [run, user],
  );

  const savePhoto = useCallback(
    async (photo: File): Promise<boolean> => {
      if (!user) return false;
      if (!AVATAR_ACCEPT.split(",").includes(photo.type)) {
        toast({ title: "Use a PNG, JPEG or WebP image.", variant: "destructive" });
        return false;
      }
      if (photo.size > MAX_AVATAR_BYTES) {
        toast({ title: "That photo is too large. Use one under 5 MB.", variant: "destructive" });
        return false;
      }
      return run(() => uploadAvatar(user.id, photo), "Photo saved", "Could not save your photo");
    },
    [run, user],
  );

  const removePhoto = useCallback(
    async (): Promise<boolean> =>
      user ? run(() => removeAvatar(user.id), "Photo removed", "Could not remove your photo") : false,
    [run, user],
  );

  return { saving, saveName, savePhoto, removePhoto };
}
