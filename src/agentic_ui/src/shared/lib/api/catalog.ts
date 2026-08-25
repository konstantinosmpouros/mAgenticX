/**
 * Catalog reads that are not agent-specific: the tool registry and the
 * personalized new-chat starter suggestions.
 */
import type { ToolMetadata } from "../types";
import { requestJson } from "../http";
import { SuggestionsSchema, ToolMetadataListSchema } from "../schemas";
import { CATALOG_BASE_PATH } from "./paths";

// Fetch available tools from backend
export async function getTools(): Promise<ToolMetadata[]> {
  return requestJson(`${CATALOG_BASE_PATH}/tools`, {
    schema: ToolMetadataListSchema,
    fallbackMessage: "Failed to fetch tools",
  });
}

// Fetch personalized starter suggestions for a new chat.
export async function getSuggestions(userId: string, agentId?: string | null): Promise<string[]> {
  const query = agentId ? `?agentId=${encodeURIComponent(agentId)}` : "";
  return requestJson(`${CATALOG_BASE_PATH}/${userId}/suggestions${query}`, {
    schema: SuggestionsSchema,
    fallbackMessage: "Failed to fetch suggestions",
  });
}
