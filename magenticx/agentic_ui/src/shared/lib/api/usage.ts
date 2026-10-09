/**
 * Usage analytics API — the Settings → Usage tab (plan 33).
 *
 * One call per page: the Overview summary, the conversation list (keyset
 * pages) and one conversation, the agent list and one agent. All read-only,
 * all scoped to the signed-in user by the bridge; every response is validated
 * against its contract in `../schemas` before a component sees it.
 */
import { requestJson } from "../http";
import {
  UsageAgentDetailSchema,
  UsageAgentListSchema,
  UsageConversationDetailSchema,
  UsageConversationPageSchema,
  UsageSummarySchema,
} from "../schemas";
import { USAGE_BASE_PATH } from "./paths";

export type UsageRange = "7d" | "30d" | "90d" | "all";
export type UsageConversationSort = "tokens" | "recent" | "context";
export type UsageAgentKindFilter = "all" | "platform" | "custom" | "deleted";

const userBase = (userId: string) => `${USAGE_BASE_PATH}/${encodeURIComponent(userId)}`;

const withQuery = (path: string, params: Record<string, string | number | null | undefined>) => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "") query.set(key, String(value));
  }
  const text = query.toString();
  return text ? `${path}?${text}` : path;
};

// The Overview: totals, windows, agent and model rankings, daily series.
export async function getUsageSummary(userId: string) {
  return requestJson(`${userBase(userId)}/summary`, {
    schema: UsageSummarySchema,
    fallbackMessage: "Failed to fetch usage summary",
  });
}

export async function getUsageConversations(
  userId: string,
  params: {
    sort: UsageConversationSort;
    range: UsageRange;
    agentId?: string | null;
    q?: string | null;
    cursor?: string | null;
    limit?: number;
  },
) {
  return requestJson(withQuery(`${userBase(userId)}/conversations`, params), {
    schema: UsageConversationPageSchema,
    fallbackMessage: "Failed to fetch conversation usage",
  });
}

export async function getUsageConversation(userId: string, conversationId: string) {
  return requestJson(`${userBase(userId)}/conversations/${encodeURIComponent(conversationId)}`, {
    schema: UsageConversationDetailSchema,
    fallbackMessage: "Failed to fetch this conversation's usage",
  });
}

export async function getUsageAgents(userId: string, params: { range: UsageRange; kind: UsageAgentKindFilter }) {
  return requestJson(withQuery(`${userBase(userId)}/agents`, params), {
    schema: UsageAgentListSchema,
    fallbackMessage: "Failed to fetch agent usage",
  });
}

// `agentKey` is the agent's id, or `name:<label>` for an agent since deleted.
export async function getUsageAgent(userId: string, agentKey: string, params: { range: UsageRange }) {
  return requestJson(withQuery(`${userBase(userId)}/agents/${encodeURIComponent(agentKey)}`, params), {
    schema: UsageAgentDetailSchema,
    fallbackMessage: "Failed to fetch this agent's usage",
  });
}
