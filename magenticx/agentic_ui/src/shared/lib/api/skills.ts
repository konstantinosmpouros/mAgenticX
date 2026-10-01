/**
 * Skills API — the remote catalogue search, the per-(user, agent) enablement
 * toggles, and the user's personal skill pool (remote additions + custom
 * uploads).
 */
import type {
  CatalogueSearchPage,
  CustomSkillCreatePayload,
  UserSkill,
  UserSkillDetail,
} from "../types";
import { requestJson, requestVoid } from "../http";
import { PROXY_LIMIT_MB } from "../uploadGuards";
import {
  CatalogueSearchPageSchema,
  StringListSchema,
  UserSkillDetailSchema,
  UserSkillListSchema,
  UserSkillSchema,
} from "../schemas";
import { SKILLS_BASE_PATH } from "./paths";

// Search the remote skill catalogue (plan 30). The catalogue is a server-side
// full-text index of the allowlisted sources — there is no list to download —
// so the Skills tab calls this as the user types. `signal` lets a newer
// keystroke cancel a request still in flight.
export async function searchCatalogue(
  query: string,
  options: { limit: number; offset?: number; signal?: AbortSignal },
): Promise<CatalogueSearchPage> {
  const params = new URLSearchParams({
    q: query,
    limit: String(options.limit),
    offset: String(options.offset ?? 0),
  });
  return requestJson(`${SKILLS_BASE_PATH}/catalogue?${params.toString()}`, {
    schema: CatalogueSearchPageSchema,
    signal: options.signal,
    errorMessages: { 429: "Searching too quickly — wait a moment and try again." },
    fallbackMessage: "Failed to search the skill catalogue",
  });
}

// Fetch enabled skills for a (user, agent) pair.
// Returns a plain string[] of skill names. The bridge reads through a Redis
// cache; mutations invalidate the cache and the next GET re-fetches from the
// agents service (which is authoritative — the on-disk directory IS the state).
export async function getUserAgentSkills(userId: string, agentId: string): Promise<string[]> {
  const url = `${SKILLS_BASE_PATH}/users/${encodeURIComponent(userId)}/agents/${encodeURIComponent(agentId)}`;
  return requestJson(url, {
    schema: StringListSchema,
    fallbackMessage: "Failed to fetch user-agent skills",
  });
}

// Enable a skill for the (user, agent) pair. 204 on success.
export async function enableUserAgentSkill(
  userId: string,
  agentId: string,
  skillName: string,
): Promise<void> {
  const url = `${SKILLS_BASE_PATH}/users/${encodeURIComponent(userId)}/agents/${encodeURIComponent(agentId)}/${encodeURIComponent(skillName)}`;
  await requestVoid(url, {
    method: "PUT",
    csrf: true,
    fallbackMessage: `Failed to enable skill ${skillName}`,
  });
}

// Disable a skill for the (user, agent) pair. 204 on success (idempotent).
export async function disableUserAgentSkill(
  userId: string,
  agentId: string,
  skillName: string,
): Promise<void> {
  const url = `${SKILLS_BASE_PATH}/users/${encodeURIComponent(userId)}/agents/${encodeURIComponent(agentId)}/${encodeURIComponent(skillName)}`;
  await requestVoid(url, {
    method: "DELETE",
    csrf: true,
    fallbackMessage: `Failed to disable skill ${skillName}`,
  });
}

// ---------------------------------------------------------------------------
// Per-user skill pool (the user's personal registry of globals + customs)
// ---------------------------------------------------------------------------

// Fetch the user's pool manifest entries (no SKILL.md content).
//
// No bypass option: the bridge owns the pool in chat_db and re-imports from the
// agents service by itself whenever what it holds is missing or incomplete, so
// there is nothing a caller could usefully force.
export async function getMySkills(userId: string): Promise<UserSkill[]> {
  const url = `${SKILLS_BASE_PATH}/users/${encodeURIComponent(userId)}`;
  return requestJson(url, {
    schema: UserSkillListSchema,
    fallbackMessage: "Failed to fetch my skills",
  });
}

// Fetch a single user-pool skill with its SKILL.md body. Used when the user
// expands a card in the My skills view.
export async function getMySkillDetail(
  userId: string,
  skillName: string,
): Promise<UserSkillDetail> {
  const url = `${SKILLS_BASE_PATH}/users/${encodeURIComponent(userId)}/${encodeURIComponent(skillName)}`;
  return requestJson(url, {
    schema: UserSkillDetailSchema,
    fallbackMessage: `Failed to fetch skill detail ${skillName}`,
  });
}

// Add a remote skill to the user's pool, pinned to the version the catalogue
// showed. 201 with the new pool entry. The server downloads and verifies the
// skill on the first Add anyone makes, so this can take a few seconds. 409 if
// the name is already in the pool; 422 if the skill failed verification.
export async function addRemoteSkillToPool(
  userId: string,
  sourceId: string,
  skillId: string,
): Promise<UserSkill> {
  const url = `${SKILLS_BASE_PATH}/users/${encodeURIComponent(userId)}/remote/${encodeURIComponent(sourceId)}/${encodeURIComponent(skillId)}`;
  return requestJson(url, {
    method: "POST",
    csrf: true,
    schema: UserSkillSchema,
    errorMessages: { 429: "Too many skills added at once — wait a minute and try again." },
    fallbackMessage: `Failed to add ${skillId} to your skills`,
  });
}

// Create a user-owned custom skill in the pool. 201 with the new manifest
// entry on success; 409 on name collision with global or own pool.
export async function createCustomSkill(
  userId: string,
  payload: CustomSkillCreatePayload,
): Promise<UserSkill> {
  const url = `${SKILLS_BASE_PATH}/users/${encodeURIComponent(userId)}/custom`;
  return requestJson(url, {
    method: "POST",
    csrf: true,
    body: payload,
    schema: UserSkillSchema,
    errorMessages: {
      413: `This skill is too large for the server (limit ${PROXY_LIMIT_MB} MB including base64 overhead). Use smaller files.`,
    },
    fallbackMessage: "Failed to create custom skill",
  });
}

// Remove a skill from the user's pool. Cascades on the agents service —
// also removes the skill from every per-(user, agent) assignment folder.
export async function removeSkillFromPool(userId: string, skillName: string): Promise<void> {
  const url = `${SKILLS_BASE_PATH}/users/${encodeURIComponent(userId)}/${encodeURIComponent(skillName)}`;
  await requestVoid(url, {
    method: "DELETE",
    csrf: true,
    fallbackMessage: `Failed to remove skill ${skillName} from pool`,
  });
}
