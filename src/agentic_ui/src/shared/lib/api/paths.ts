/**
 * Base URL prefixes for every bridge API surface.
 *
 * Kept in one leaf module (imports nothing) so the domain API modules can each
 * deep-import just the prefixes they need without pulling in a sibling domain —
 * which is what would create an import cycle through the folder barrel.
 */

export const API_BASE_PATH = "/api/v1";
export const AUTH_BASE_PATH = `${API_BASE_PATH}/auth`;
export const CATALOG_BASE_PATH = `${API_BASE_PATH}/catalog`;
export const AGENTS_BASE_PATH = `${API_BASE_PATH}/agents`;
export const PREFERENCES_BASE_PATH = `${API_BASE_PATH}/preferences`;
export const CONVERSATIONS_BASE_PATH = `${API_BASE_PATH}/conversations`;
export const MESSAGES_BASE_PATH = `${API_BASE_PATH}/messages`;
export const ATTACHMENTS_BASE_PATH = `${API_BASE_PATH}/attachments`;
export const INFERENCE_BASE_PATH = `${API_BASE_PATH}/inference`;
export const SPEECH_BASE_PATH = `${API_BASE_PATH}/speech`;
export const VOICE_BASE_PATH = `${API_BASE_PATH}/voice`;
export const SHARED_CONVERSATIONS_BASE_PATH = `${API_BASE_PATH}/shared-conversations`;
export const SEARCH_BASE_PATH = `${API_BASE_PATH}/search`;
export const SKILLS_BASE_PATH = `${API_BASE_PATH}/skills`;
export const MEMORIES_BASE_PATH = `${API_BASE_PATH}/memories`;
export const SCHEDULED_TASKS_BASE_PATH = `${API_BASE_PATH}/scheduled-tasks`;
export const USAGE_BASE_PATH = `${API_BASE_PATH}/usage`;
