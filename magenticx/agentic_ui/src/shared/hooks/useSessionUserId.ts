import { useWorkspaceStore } from "@/shared/stores/workspaceStore";

/**
 * The signed-in user's id, or null while signed out, before the session is
 * confirmed, or while the account awaits deletion (its session answers 403 to
 * everything else). For per-user URLs a component builds on its own — a site
 * icon, say — where a guest (a public share page) must not fire a request
 * that can only fail.
 */
export function useSessionUserId(): string | null {
  return useWorkspaceStore((s) => (s.isLoggedIn && !s.pendingDeletion ? s.userId : null));
}
