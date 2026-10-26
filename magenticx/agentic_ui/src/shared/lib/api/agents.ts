/**
 * Agent catalog, per-agent tool toggles, and user-authored agent CRUD.
 */
import type {
  Agent,
  CustomAgentDetail,
  CustomAgentImportResult,
  CustomAgentValidation,
  CustomAgentWritePayload,
  MyAgent,
} from "../types";
import { requestJson, requestRaw, requestVoid } from "../http";
import { PROXY_LIMIT_MB } from "../uploadGuards";
import { getFilenameFromDisposition, triggerBrowserDownload } from "../download";
import {
  AgentToolsResponseSchema,
  CustomAgentDetailSchema,
  CustomAgentImportResultSchema,
  CustomAgentSummarySchema,
  CustomAgentValidationSchema,
  RenderedAgentYamlSchema,
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
// Per-agent tools (an agent's page). Two kinds of row: prebuilt tools, whose
// approval alone is configurable, and MCP tools, configurable on both axes.
// Proxied to the agents service by the bridge; both mutations are
// CSRF-protected and return refreshed rows.
// ---------------------------------------------------------------------------
export async function getAgentTools(userId: string, agentId: string) {
  const url = `${AGENTS_BASE_PATH}/${encodeURIComponent(userId)}/${encodeURIComponent(agentId)}/tools`;
  return requestJson(url, {
    schema: AgentToolsResponseSchema,
    fallbackMessage: "Failed to fetch agent tools",
  });
}

export async function setAgentToolEnabled(
  userId: string,
  agentId: string,
  toolKey: string,
  enabled: boolean,
) {
  const url = `${AGENTS_BASE_PATH}/${encodeURIComponent(userId)}/${encodeURIComponent(agentId)}/tools/enabled`;
  return requestJson(url, {
    method: "POST",
    csrf: true,
    body: { toolKey, enabled },
    schema: AgentToolsResponseSchema,
    fallbackMessage: "Failed to update tool",
  });
}

export async function setAgentToolApproval(
  userId: string,
  agentId: string,
  toolKey: string,
  approval: boolean,
) {
  const url = `${AGENTS_BASE_PATH}/${encodeURIComponent(userId)}/${encodeURIComponent(agentId)}/tools/approval`;
  return requestJson(url, {
    method: "POST",
    csrf: true,
    body: { toolKey, approval },
    schema: AgentToolsResponseSchema,
    fallbackMessage: "Failed to update approval",
  });
}

// Every approval choice at once — the builder's save, after the agent itself.
// `null` clears a stored choice so the tool follows the agent's default again.
// All or nothing on the bridge; returns the refreshed rows.
export async function setAgentToolApprovals(
  userId: string,
  agentId: string,
  approvals: Record<string, boolean | null>,
) {
  const url = `${AGENTS_BASE_PATH}/${encodeURIComponent(userId)}/${encodeURIComponent(agentId)}/tools/approvals`;
  return requestJson(url, {
    method: "PUT",
    csrf: true,
    body: { approvals },
    schema: AgentToolsResponseSchema,
    fallbackMessage: "Failed to save the approval choices",
  });
}

// ---------------------------------------------------------------------------
// User-authored agents (the agent builder)
// ---------------------------------------------------------------------------
const customAgentsUrl = (userId: string, agentId?: string) =>
  `${AGENTS_BASE_PATH}/${encodeURIComponent(userId)}/custom` +
  (agentId ? `/${encodeURIComponent(agentId)}` : "");

// The agents this user authored, in the catalog's shape. `summary` asks the
// bridge to add each one's model and tool/skill/sub-agent counts (one call for
// the whole list, read from the agents service's own summary) — what the
// gallery's cards show. Without it, or from a bridge that predates it, those
// fields come back null and the cards leave them out.
export async function getMyAgents(
  userId: string,
  { summary = false }: { summary?: boolean } = {},
): Promise<MyAgent[]> {
  const url = customAgentsUrl(userId) + (summary ? "?include=summary" : "");
  const data = await requestJson(url, {
    schema: WireObjectArraySchema,
    fallbackMessage: "Failed to load your agents",
  });
  return data.map((row) => ({
    // Every row here is the user's own, whether or not the bridge says so.
    ...transformAgent(row),
    kind: "custom" as const,
    ...CustomAgentSummarySchema.parse(row),
  }));
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

// A draft as agent.yaml text — the builder's YAML view, saved or not.
export async function renderMyAgentYaml(
  userId: string,
  payload: CustomAgentWritePayload,
): Promise<string> {
  const data = await requestJson(`${customAgentsUrl(userId)}/render`, {
    method: "POST",
    csrf: true,
    body: payload,
    schema: RenderedAgentYamlSchema,
    fallbackMessage: "Failed to show the agent as YAML",
  });
  return data.yaml;
}

// Check an agent.yaml without saving it: pasted text, or files — `agent.yaml`
// with its `.md`/`.txt` prompts, or one `.zip` of the folder (unpacked by the
// bridge). The answer carries the parsed spec whenever the YAML parsed, valid
// or not, so the builder can open it to fix.
export async function importMyAgent(
  userId: string,
  { yaml, files = [] }: { yaml?: string; files?: File[] },
): Promise<CustomAgentImportResult> {
  const form = new FormData();
  if (yaml !== undefined) form.append("yaml", yaml);
  for (const file of files) form.append("files", file, file.name);
  return requestJson(`${customAgentsUrl(userId)}/import`, {
    method: "POST",
    csrf: true,
    body: form,
    schema: CustomAgentImportResultSchema,
    errorMessages: {
      413: `These files are too large to import (limit ${PROXY_LIMIT_MB} MB).`,
      429: "Too many imports in a short time. Wait a minute and try again.",
    },
    fallbackMessage: "Failed to check the agent file",
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

// Export: the agent as a `.zip` of its `agent.yaml` and every file it carries,
// saved straight to disk under the server's filename (`<slug>.zip`). The slug
// is the fallback name only if the bridge sends no Content-Disposition.
export async function exportMyAgent(
  userId: string,
  agentId: string,
  fallbackName = "agent",
): Promise<void> {
  const res = await requestRaw(`${customAgentsUrl(userId, agentId)}/export`, {
    accept: "application/zip",
    fallbackMessage: "Failed to export the agent",
  });
  const blob = await res.blob();
  triggerBrowserDownload(
    blob,
    getFilenameFromDisposition(res.headers.get("Content-Disposition"), `${fallbackName}.zip`),
  );
}
