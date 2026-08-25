/**
 * Workspace search API — cross-entity search over the signed-in user's active
 * workspace.
 */
import type { WorkspaceSearchResult } from "../types";
import { requestJson } from "../http";
import { WorkspaceSearchResultListSchema } from "../schemas";
import { SEARCH_BASE_PATH } from "./paths";

// Search the signed-in user's active workspace data.
export async function searchWorkspace(
  userId: string,
  query: string,
  limit: number = 20,
): Promise<WorkspaceSearchResult[]> {
  const params = new URLSearchParams({
    q: query,
    limit: String(limit),
  });
  return requestJson(`${SEARCH_BASE_PATH}/${encodeURIComponent(userId)}?${params.toString()}`, {
    schema: WorkspaceSearchResultListSchema,
    fallbackMessage: "Failed to search workspace",
  });
}
