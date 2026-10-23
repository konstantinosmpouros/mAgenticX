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
  revokeAllSessions,
  restoreSessionWhenReachable,
  refreshSession,
  logoutSession,
  getAccounts,
  switchAccount,
  logoutAccount,
  logoutAllAccounts,
  beginEntraLogin,
} from "./auth";

export {
  getAgents,
  getAgentTools,
  setAgentToolApproval,
  setAgentToolEnabled,
  getMyAgents,
  getMyAgentDetail,
  validateMyAgent,
  createMyAgent,
  updateMyAgent,
  deleteMyAgent,
} from "./agents";

export { getTools, getSuggestions } from "./catalog";

export {
  searchCatalogue,
  getUserAgentSkills,
  enableUserAgentSkill,
  disableUserAgentSkill,
  getMySkills,
  getMySkillDetail,
  addRemoteSkillToPool,
  createCustomSkill,
  removeSkillFromPool,
} from "./skills";

export { listAgentMemories, getAgentMemory, deleteAgentMemory } from "./memories";

export { searchWorkspace } from "./search";

export { getUserPreferences, updateUserPreferences } from "./preferences";

export {
  getUsageSummary,
  getUsageConversations,
  getUsageConversation,
  getUsageAgents,
  getUsageAgent,
} from "./usage";
export type { UsageRange, UsageConversationSort, UsageAgentKindFilter } from "./usage";

export {
  getConversations,
  getArchivedConversations,
  getConversationDetail,
  deleteConversation,
  archiveConversation,
  unarchiveConversation,
  getPinnedConversations,
  getSidebarConversations,
  setConversationPinned,
  saveConversation,
  reportConversation,
  renameConversation,
  forkConversation,
  compactConversation,
  undoCompaction,
} from "./conversations";

export {
  shareConversation,
  downloadConversationPdfExport,
  getSharedConversationLinks,
  revokeSharedConversationLink,
  getSharedConversation,
} from "./sharing";

export { likeMessage, dislikeMessage } from "./messages";

export {
  downloadAttachment,
  fetchAttachmentPreviewBlob,
  fetchDocxPreviewToken,
} from "./attachments";

export {
  generateMessageReadAloudAudio,
  generateReadAloudPreviewAudio,
  transcribeDictation,
  createRealtimeVoiceSession,
} from "./voice";

export {
  startInference,
  getActiveInferenceRuns,
  cancelInferenceRun,
  resumeInferenceRun,
} from "./inference";
export type { ResumeInferenceRunBody } from "./inference";

export { connectInferenceWebSocket } from "./inference-socket";

export {
  listScheduledTasks,
  createScheduledTask,
  updateScheduledTask,
  deleteScheduledTask,
} from "./tasks";

export { getExportStatus, requestExportToken, exportDownloadUrl } from "./export";
export {
  updateProfileName,
  uploadAvatar,
  removeAvatar,
  getAccountDeletionStatus,
  requestAccountDeletion,
  cancelAccountDeletion,
  beginReauthentication,
} from "./account";
export { getAgentCommands } from "./commands";
