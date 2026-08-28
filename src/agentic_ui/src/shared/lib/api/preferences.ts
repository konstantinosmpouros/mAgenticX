/**
 * User preferences API, plus the workspace usage rollup that the Settings →
 * Usage tab renders alongside them.
 */
import { requestJson } from "../http";
import { UsageSummarySchema, WireObjectSchema } from "../schemas";
import {
  normalizeCustomInstructions,
  normalizePersonality,
  normalizeRealtimeVoice,
  normalizeVoiceModeLanguage,
} from "../utils";
import { PREFERENCES_BASE_PATH, USAGE_BASE_PATH } from "./paths";

// Map the raw preferences payload (mixed camelCase) into the app shape, applying
// the same per-field defaults on both read and write so the two paths cannot
// drift. Tool disable-list entries are passed through verbatim.
function mapUserPreferences(data: unknown) {
  const record = (data ?? {}) as Record<string, unknown>;
  const suggestionsEnabled =
    typeof record.suggestionsEnabled === "boolean" ? record.suggestionsEnabled : true;
  const showMessageTokenUsage =
    typeof record.showMessageTokenUsage === "boolean" ? record.showMessageTokenUsage : false;
  const searchPastConvs =
    typeof record.searchPastConvs === "boolean" ? record.searchPastConvs : false;
  const useMemory = typeof record.useMemory === "boolean" ? record.useMemory : true;
  const personality = normalizePersonality(record.personality);
  const customInstructions = normalizeCustomInstructions(record.customInstructions);
  const voiceModeVoice = normalizeRealtimeVoice(record.voiceModeVoice);
  const voiceModeLanguage = normalizeVoiceModeLanguage(record.voiceModeLanguage);

  return {
    suggestionsEnabled,
    showMessageTokenUsage,
    searchPastConvs,
    useMemory,
    personality,
    customInstructions,
    voiceModeVoice,
    voiceModeLanguage,
  };
}

// Fetch the workspace-wide usage rollup for the Settings → Usage tab.
export async function getUsageSummary(userId: string) {
  return requestJson(`${USAGE_BASE_PATH}/${encodeURIComponent(userId)}/summary`, {
    schema: UsageSummarySchema,
    fallbackMessage: "Failed to fetch usage summary",
  });
}

// Fetch user preferences
export async function getUserPreferences(userId: string) {
  const data = await requestJson(`${PREFERENCES_BASE_PATH}/${userId}`, {
    schema: WireObjectSchema,
    fallbackMessage: "Failed to fetch user preferences",
  });
  return mapUserPreferences(data);
}

// Update user preferences
export async function updateUserPreferences(userId: string, prefs: unknown) {
  const data = await requestJson(`${PREFERENCES_BASE_PATH}/${userId}`, {
    method: "PUT",
    csrf: true,
    body: prefs,
    schema: WireObjectSchema,
    fallbackMessage: "Failed to update user preferences",
  });
  return mapUserPreferences(data);
}
