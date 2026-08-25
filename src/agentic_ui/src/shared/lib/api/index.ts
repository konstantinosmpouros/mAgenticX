/**
 * Public API surface for the bridge client.
 *
 * Every call site imports from `@/shared/lib/api` — this barrel is the single
 * entry point, and the domain modules beside it are folder-internal detail.
 * Re-exports are named (never `export *`) so a helper that a domain module has
 * to export for a sibling — `transformInferenceRunEvent`, for one — cannot leak
 * into the app-facing surface by accident.
 *
 * Rule for the modules in this folder: never import from this barrel. Deep-import
 * the sibling leaf (`./paths`, `./inference`) instead, or you build a cycle.
 */

export {
  authenticate,
  getSessionMe,
  restoreSession,
  refreshSession,
  logoutSession,
  getAccounts,
  switchAccount,
  logoutAccount,
  logoutAllAccounts,
  getAuthConfig,
  beginEntraLogin,
} from "./auth";

export {
  getAgents,
  getAgentTools,
  toggleAgentTool,
  getMyAgents,
  getMyAgentDetail,
  validateMyAgent,
  createMyAgent,
  updateMyAgent,
  deleteMyAgent,
} from "./agents";

export { getTools, getSuggestions } from "./catalog";

export {
  getSkills,
  getUserAgentSkills,
  enableUserAgentSkill,
  disableUserAgentSkill,
  getMySkills,
  getMySkillDetail,
  addGlobalSkillToPool,
  createCustomSkill,
  removeSkillFromPool,
} from "./skills";

export { listAgentMemories, getAgentMemory, deleteAgentMemory } from "./memories";

export { searchWorkspace } from "./search";

export { getUserPreferences, updateUserPreferences, getUsageSummary } from "./preferences";

export {
  getConversations,
  getArchivedConversations,
  getConversationDetail,
  deleteConversation,
  archiveConversation,
  unarchiveConversation,
  reportConversation,
  renameConversation,
  createConversation,
  forkConversation,
} from "./conversations";

export {
  shareConversation,
  downloadConversationPdfExport,
  getSharedConversationLinks,
  revokeSharedConversationLink,
  getSharedConversation,
} from "./sharing";

export {
  addMessageToConversation,
  updateMessageInConversation,
  likeMessage,
  dislikeMessage,
} from "./messages";

export {
  downloadAttachment,
  fetchAttachmentBlob,
  getAttachmentPreviewUrl,
  fetchAttachmentPreviewBlob,
  fetchDocxPreviewToken,
} from "./attachments";

export {
  generateMessageReadAloudAudio,
  generateReadAloudPreviewAudio,
  transcribeDictation,
  createRealtimeVoiceSession,
  persistRealtimeVoiceConversationEvent,
  endRealtimeVoiceSession,
} from "./voice";

export {
  startInference,
  getActiveInferenceRuns,
  cancelInferenceRun,
  resumeInferenceRun,
} from "./inference";
export type { ResumeActionDecision, ResumeInferenceRunBody } from "./inference";

export { connectInferenceWebSocket } from "./inference-socket";

export {
  listScheduledTasks,
  createScheduledTask,
  updateScheduledTask,
  deleteScheduledTask,
} from "./tasks";
