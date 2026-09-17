/**
 * Per-(user, agent) memory API — list, read, and delete the facts an agent has
 * saved about the user.
 */
import type { MemoryDetail, MemorySummary } from "../types";
import { requestJson, requestVoid } from "../http";
import { MemoryDetailSchema, MemorySummaryListSchema } from "../schemas";
import { MEMORIES_BASE_PATH } from "./paths";

// List the memories this agent has saved about the user (metadata only).
export async function listAgentMemories(userId: string, agentId: string): Promise<MemorySummary[]> {
  const url = `${MEMORIES_BASE_PATH}/users/${encodeURIComponent(userId)}/agents/${encodeURIComponent(agentId)}`;
  return requestJson(url, {
    schema: MemorySummaryListSchema,
    fallbackMessage: "Failed to fetch agent memories",
  });
}

// Fetch one saved memory with its full content (click-to-preview).
export async function getAgentMemory(
  userId: string,
  agentId: string,
  name: string,
): Promise<MemoryDetail> {
  const url = `${MEMORIES_BASE_PATH}/users/${encodeURIComponent(userId)}/agents/${encodeURIComponent(agentId)}/${encodeURIComponent(name)}`;
  return requestJson(url, {
    schema: MemoryDetailSchema,
    fallbackMessage: `Failed to fetch memory ${name}`,
  });
}

// Delete one of the agent's saved memories. 204 on success (idempotent).
export async function deleteAgentMemory(
  userId: string,
  agentId: string,
  name: string,
): Promise<void> {
  const url = `${MEMORIES_BASE_PATH}/users/${encodeURIComponent(userId)}/agents/${encodeURIComponent(agentId)}/${encodeURIComponent(name)}`;
  await requestVoid(url, {
    method: "DELETE",
    csrf: true,
    fallbackMessage: `Failed to delete memory ${name}`,
  });
}
