/**
 * Agent catalog, per-agent tool toggles, and user-authored agent CRUD.
 */
import type {
  Agent,
  CustomAgentDetail,
  CustomAgentValidation,
  CustomAgentWritePayload,
} from "../types";
import { requestJson, requestVoid } from "../http";
import { PROXY_LIMIT_MB } from "../uploadGuards";
import {
  AgentToolsResponseSchema,
  CustomAgentDetailSchema,
  CustomAgentValidationSchema,
  WireObjectArraySchema,
  WireObjectSchema,
} from "../schemas";
import { transformAgent } from "../consts";
import { AGENTS_BASE_PATH, CATALOG_BASE_PATH } from "./paths";

// Fetch agents from backend via nginx proxy. The wire shape is validated as an
// array of objects; each row is coerced into the app `Agent` by the shared
// transform (icon name → the Lucide component, snake/camel `is_active`
// reconciled) — the same one the custom-agent calls below use.
export async function getAgents(): Promise<Agent[]> {
  const data = await requestJson(`${CATALOG_BASE_PATH}/agents`, {
    schema: WireObjectArraySchema,
    fallbackMessage: "Failed to fetch agents",
  });
  return data.map((agent) => transformAgent(agent));
}

// ---------------------------------------------------------------------------
// Per-agent tools (Agents tab). List the tools an agent may use with their
// per-(user, agent) disabled flags, and toggle one. Proxied to the agents
// service by the bridge; the toggle is CSRF-protected + returns refreshed rows.
// ---------------------------------------------------------------------------
export async function getAgentTools(userId: string, agentId: string) {
  const url = `${AGENTS_BASE_PATH}/${encodeURIComponent(userId)}/${encodeURIComponent(agentId)}/tools`;
  return requestJson(url, {
    schema: AgentToolsResponseSchema,
    fallbackMessage: "Failed to fetch agent tools",
  });
}

export async function toggleAgentTool(
  userId: string,
  agentId: string,
  toolKey: string,
  disabled: boolean,
) {
  const url = `${AGENTS_BASE_PATH}/${encodeURIComponent(userId)}/${encodeURIComponent(agentId)}/tools/toggle`;
  return requestJson(url, {
    method: "POST",
    csrf: true,
    body: { toolKey, disabled },
    schema: AgentToolsResponseSchema,
    fallbackMessage: "Failed to update tool",
  });
}

// ---------------------------------------------------------------------------
// User-authored agents (the agent builder)
// ---------------------------------------------------------------------------
const customAgentsUrl = (userId: string, agentId?: string) =>
  `${AGENTS_BASE_PATH}/${encodeURIComponent(userId)}/custom` +
  (agentId ? `/${encodeURIComponent(agentId)}` : "");

// The agents this user authored. Returned in the same shape as the catalog, so
// they slot straight into the existing `Agent` list.
export async function getMyAgents(userId: string): Promise<Agent[]> {
  const data = await requestJson(customAgentsUrl(userId), {
    schema: WireObjectArraySchema,
    fallbackMessage: "Failed to load your agents",
  });
  return data.map((row) => transformAgent(row));
}

// One owned agent's full definition, for the edit view.
export async function getMyAgentDetail(
  userId: string,
  agentId: string,
): Promise<CustomAgentDetail> {
  return requestJson(customAgentsUrl(userId, agentId), {
    schema: CustomAgentDetailSchema,
    fallbackMessage: "Failed to load the agent definition",
  });
}

// Dry run: report every problem with a definition without writing anything.
export async function validateMyAgent(
  userId: string,
  payload: CustomAgentWritePayload,
): Promise<CustomAgentValidation> {
  return requestJson(`${customAgentsUrl(userId)}/validate`, {
    method: "POST",
    csrf: true,
    body: payload,
    schema: CustomAgentValidationSchema,
    fallbackMessage: "Failed to validate the agent",
  });
}

export async function createMyAgent(
  userId: string,
  payload: CustomAgentWritePayload,
): Promise<Agent> {
  const data = await requestJson(customAgentsUrl(userId), {
    method: "POST",
    csrf: true,
    body: payload,
    schema: WireObjectSchema,
    errorMessages: {
      413: `This agent definition is too large for the server (limit ${PROXY_LIMIT_MB} MB including base64 overhead).`,
    },
    fallbackMessage: "Failed to create the agent",
  });
  return transformAgent(data);
}

export async function updateMyAgent(
  userId: string,
  agentId: string,
  payload: CustomAgentWritePayload,
): Promise<Agent> {
  const data = await requestJson(customAgentsUrl(userId, agentId), {
    method: "PUT",
    csrf: true,
    body: payload,
    schema: WireObjectSchema,
    fallbackMessage: "Failed to update the agent",
  });
  return transformAgent(data);
}

export async function deleteMyAgent(userId: string, agentId: string): Promise<void> {
  return requestVoid(customAgentsUrl(userId, agentId), {
    method: "DELETE",
    csrf: true,
    fallbackMessage: "Failed to delete the agent",
  });
}
