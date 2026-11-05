import { useWorkspaceStore } from "@/shared/stores/workspaceStore";

/**
 * The user the workflow hooks load for, read from the workspace store so the
 * hooks need no `userId` argument. Null while signed out or while the account
 * awaits deletion (its session answers 403 to everything else), so no hook
 * fires a request that can only fail.
 */
export function useWorkflowUserId(): string | null {
  return useWorkspaceStore((s) => (s.pendingDeletion ? null : s.userId));
}
