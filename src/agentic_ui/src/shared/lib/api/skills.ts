/**
 * Skills API — the global registry, the per-(user, agent) enablement toggles,
 * and the user's personal skill pool (globals adopted + custom uploads).
 */
import type { CustomSkillCreatePayload, Skill, UserSkill, UserSkillDetail } from "../types";
import { requestJson, requestVoid } from "../http";
import { PROXY_LIMIT_MB } from "../uploadGuards";
import {
  SkillListSchema,
  StringListSchema,
  UserSkillDetailSchema,
  UserSkillListSchema,
  UserSkillSchema,
} from "../schemas";
import { SKILLS_BASE_PATH } from "./paths";

// Fetch the central skills registry. Used by the bootstrap path
// (auth handlers + auth rehydrate hook) the same way as ``getAgents`` and
// ``getTools`` — fetched on every page refresh, with an IndexedDB snapshot
// for instant paint while the request is in flight. Pass ``{ bypassRedis:
// true }`` to force the bridge to skip its Redis cache and re-fetch from the
// agents service — that path also upserts the cache so the next normal
// request benefits from the new data. Only the manual refresh button uses
// the bypass; everything else (login, page refresh) leaves it false so the
// cache absorbs the load.
export async function getSkills(options?: { bypassRedis?: boolean }): Promise<Skill[]> {
  const url = options?.bypassRedis ? `${SKILLS_BASE_PATH}?bypass_redis=true` : SKILLS_BASE_PATH;
  return requestJson(url, {
    schema: SkillListSchema,
    fallbackMessage: "Failed to fetch skills",
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

// Append a global-catalog skill into the user's pool. 204 on success. 404 if
// the skill isn't in the global catalog; 409 if it's already in the pool.
export async function addGlobalSkillToPool(userId: string, skillName: string): Promise<void> {
  const url = `${SKILLS_BASE_PATH}/users/${encodeURIComponent(userId)}/global/${encodeURIComponent(skillName)}`;
  await requestVoid(url, {
    method: "POST",
    csrf: true,
    fallbackMessage: `Failed to add global skill ${skillName} to pool`,
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
