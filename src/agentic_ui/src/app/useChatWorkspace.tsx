import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useNavigate, useParams, useLocation } from "react-router-dom";
import { useReducedMotion } from "framer-motion";
import { Building2 } from "lucide-react";
import { useToast } from "@/shared/hooks/use-toast";

// Import types for messages, thinking state, conversations, and agents
import type {
  MessageOut,
  ConversationDetail,
  ConversationSummary,
  SharedConversationDetail,
} from "@/shared/lib/types";
import { usePreferencesHandlers } from "@/features/settings/handlers/preferences";
import { computeConversationUsage } from "@/shared/lib/utils";
import { useProfilePanel } from "@/features/settings/hooks/useProfilePanel";
import { useSettingsPanels } from "@/features/settings/hooks/useSettingsPanels";
import { useAttachmentPreview } from "@/features/attachments/hooks/useAttachmentPreview";
import { useOverlayMenus } from "@/features/chat/hooks/useOverlayMenus";
import { useComposer } from "@/features/chat/hooks/useComposer";
import {
  useMessageInteraction,
  ROOT_BRANCH_KEY,
} from "@/features/chat/hooks/useMessageInteraction";
import { useConversationRouting } from "@/features/chat/hooks/useConversationRouting";
import { useShareDialogState } from "@/features/sharing/hooks/useShareDialogState";
import { useReportDialogState } from "@/features/reporting/hooks/useReportDialogState";
import { useMemories } from "@/features/settings/hooks/useMemories";
import {
  useEnsureDefaultAgentEffect,
  useHeaderDividerEffect,
} from "@/features/chat/hooks/useChatEffects";
import { useChatVoiceMode } from "@/features/voice/hooks/useChatVoiceMode";
import {
  useVoiceBodyTransition,
  type ConversationBodyMode,
} from "@/features/voice/hooks/useVoiceBodyTransition";
import {
  useAuthRehydrateEffect,
  useSessionAutoRefreshEffect,
  useSessionStateSyncEffect,
  useUISnapshotPersistence,
} from "@/features/auth/hooks/useSessionEffects";
import { useActiveRunBranchSnap } from "@/features/chat/hooks/useActiveRunBranchSnap";
import { useWorkspaceStore } from "@/shared/stores/workspaceStore";

// Handlers, imported from the feature that owns each one.
import { useAccountSwitching } from "@/features/auth/hooks/useAccountSwitching";
import { createAgentHandlers } from "@/features/catalog/handlers/agents";
import {
  createConversationHandlers,
  createConversationMessageSetter,
} from "@/features/chat/handlers/conversations";
import {
  createAiTransitionHandlers,
  createFeedbackHandlers,
  createMessageEditUiHandlers,
  createReadAloudHandlers,
  createUIHandlers,
} from "@/features/chat/handlers/messages";
import { runActiveUiDismissal } from "@/features/chat/handlers/ui";
import { createReportHandlers } from "@/features/reporting/handlers/report";
import {
  buildDefaultConversationSearchResults,
  createSearchResultHandlers,
  useWorkspaceSearch,
} from "@/features/search/handlers/search";
import {
  createShareConversationHandlers,
  createSharedConversationHandlers,
} from "@/features/sharing/handlers/share";
import {
  createInferenceHandlers,
  createMessageEditHandlers,
  createRetryHandlers,
  useInferenceRuns,
  pendingTimelineInterrupts,
} from "@/features/inference";
import { getAgents, getSuggestions } from "@/shared/lib/api";

// The two conversation-body surfaces this hook renders via renderConversationBody.
import ChatBody from "@/features/chat/components/ChatBody";
import VoiceModeBody from "@/features/voice/components/VoiceModeBody";
import { useScheduledTasks } from "@/features/tasks/hooks/useScheduledTasks";
import { clearUISnapshot } from "@/shared/lib/uiStateStorage";

const pickVisibleSuggestions = (suggestions: string[]) => {
  const unique = Array.from(new Set(suggestions.map((item) => item.trim()).filter(Boolean)));
  const count = Math.min(unique.length, 4 + Math.floor(Math.random() * 3));
  return [...unique].sort(() => Math.random() - 0.5).slice(0, count);
};

const previewText = (value?: string | null, maxLength: number = 72) => {
  const cleaned = (value ?? "").replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 3)}...` : cleaned;
};

const resolveConversationTitle = (conversation: ConversationDetail | null) => {
  if (!conversation) return "";
  const title = previewText(conversation.title, 90);
  if (title) return title;
  const messagePreview = previewText(
    conversation.messages?.find((message) => previewText(message.content))?.content,
    90,
  );
  if (messagePreview) return messagePreview;
  return previewText(conversation.agent?.name, 90) || "Untitled chat";
};

/**
 * Only set on the shared-conversation path, where the conversation arrives as a
 * prop under a token instead of being loaded from a `:conversationId` route.
 */
export type ChatWorkspaceOptions = {
  sharedConversationToken?: string;
  initialSharedConversation?: SharedConversationDetail | null;
};

// The entire chat-workspace body, extracted into a hook so the persistent
// shell (WorkspaceShell) and the route views (ChatView/TasksView) can share one
// instance of all state/effects/handlers. It calls all hooks unconditionally
// and returns the full bundle; the shell does the auth gate + chrome render.
export function useChatWorkspace({
  sharedConversationToken,
  initialSharedConversation,
}: ChatWorkspaceOptions = {}) {
  // ── Shared workspace state (Zustand store) ──────────────────────────────
  // The shell (sidebar/header) and the route views both read these; selectors
  // keep re-renders scoped to readers of each slice. Setters are
  // setState-compatible, so the hooks/handlers below consume them unchanged.
  const currentConversation = useWorkspaceStore((s) => s.currentConversation);
  const selectedAgent = useWorkspaceStore((s) => s.selectedAgent);
  const isPrivateMode = useWorkspaceStore((s) => s.isPrivateMode);
  const agents = useWorkspaceStore((s) => s.agents);
  const availableTools = useWorkspaceStore((s) => s.availableTools);
  const availableSkills = useWorkspaceStore((s) => s.availableSkills);
  const myRegistrySkills = useWorkspaceStore((s) => s.myRegistrySkills);
  const userPreferences = useWorkspaceStore((s) => s.userPreferences);
  const isSavingPreferences = useWorkspaceStore((s) => s.isSavingPreferences);
  const inactiveAgentFallback = useWorkspaceStore((s) => s.inactiveAgentFallback);
  const conversations = useWorkspaceStore((s) => s.conversations);
  const conversationsLoading = useWorkspaceStore((s) => s.conversationsLoading);
  const starterSuggestions = useWorkspaceStore((s) => s.starterSuggestions);
  const convPage = useWorkspaceStore((s) => s.convPage);
  const convHasMore = useWorkspaceStore((s) => s.convHasMore);
  const convIsLoadingMore = useWorkspaceStore((s) => s.convIsLoadingMore);
  const archivedConversations = useWorkspaceStore((s) => s.archivedConversations);
  const archivedConvPage = useWorkspaceStore((s) => s.archivedConvPage);
  const archivedConvHasMore = useWorkspaceStore((s) => s.archivedConvHasMore);
  const archivedConvIsLoading = useWorkspaceStore((s) => s.archivedConvIsLoading);
  const sharedConversations = useWorkspaceStore((s) => s.sharedConversations);
  const sharedConvPage = useWorkspaceStore((s) => s.sharedConvPage);
  const sharedConvHasMore = useWorkspaceStore((s) => s.sharedConvHasMore);
  const sharedConvIsLoading = useWorkspaceStore((s) => s.sharedConvIsLoading);
  const userProfile = useWorkspaceStore((s) => s.userProfile);
  const isLoggedIn = useWorkspaceStore((s) => s.isLoggedIn);
  const userId = useWorkspaceStore((s) => s.userId);
  const authResolved = useWorkspaceStore((s) => s.authResolved);
  const loadingConversation = useWorkspaceStore((s) => s.loadingConversation);
  const activeProfileTab = useWorkspaceStore((s) => s.activeProfileTab);
  const sidebarOpen = useWorkspaceStore((s) => s.sidebarOpen);
  // Setters are stable for the store's lifetime — read once without subscribing.
  const {
    setCurrentConversation,
    setSelectedAgent,
    setIsPrivateMode,
    setAgents,
    setAvailableTools,
    setAvailableSkills,
    setMyRegistrySkills,
    setUserPreferences,
    setIsSavingPreferences,
    setInactiveAgentFallback,
    setConversations,
    setConversationsLoading,
    setStarterSuggestions,
    setConvPage,
    setConvHasMore,
    setConvIsLoadingMore,
    setArchivedConversations,
    setArchivedConvPage,
    setArchivedConvHasMore,
    setArchivedConvIsLoading,
    setSharedConversations,
    setSharedConvPage,
    setSharedConvHasMore,
    setSharedConvIsLoading,
    setUserProfile,
    setIsLoggedIn,
    setUserId,
    setAuthResolved,
    setLoadingConversation,
    setActiveProfileTab,
    setSidebarOpen,
    resetForAccountSwitch,
  } = useWorkspaceStore.getState();

  // ── View-local state ────────────────────────────────────────────────────
  const CONV_PAGE_SIZE = 10;
  const ARCHIVED_CONV_PAGE_SIZE = 10;
  const SHARED_CONV_PAGE_SIZE = 10;

  // Branching, editing, and the transient per-message affordances. Declared
  // before the run machinery because that is handed `setThinkingState`,
  // `setShowAiTransition` and `setBranchSelections`.
  const messageInteraction = useMessageInteraction({ currentConversation });
  const {
    expandedThinking,
    setExpandedThinking,
    toggleThinking,
    thinkingState,
    setThinkingState,
    showAiTransition,
    setShowAiTransition,
    copiedId,
    setCopiedId,
    speakingMessageId,
    setSpeakingMessageId,
    stickyUserBarId,
    flashUserActionBar,
    setStickyUserBarId,
    branchSelections,
    setBranchSelections,
    activeMessages,
    activeBranchPath,
    editingMessageId,
    editingDraft,
    setEditingMessageId,
    setEditingDraft,
    setEditingBusy,
  } = messageInteraction;

  const { headerHasDivider, handleHeaderScrollState } = useHeaderDividerEffect();

  // UI components
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const agentTriggerRef = useRef<HTMLButtonElement>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  const { toast } = useToast();

  // ── Overlay/panel state ─────────────────────────────────────────────────
  // Each surface's open/closed state (and the values its dialog renders from)
  // lives in the feature that owns the surface. The behaviour stays here,
  // because the handler factories below need the conversation, the message list
  // and the user id — none of which belong to a dialog.
  const attachmentPreview = useAttachmentPreview();
  const {
    selectedImage,
    selectedFilePreview,
    openFilePreview,
    closeFilePreview,
    setSelectedImage,
  } = attachmentPreview;

  const overlayMenus = useOverlayMenus({ agentTriggerRef });
  const {
    isAgentPickerOpen,
    openAgentPicker,
    isHeaderActionMenuOpen,
    isSidebarFloatingUiOpen,
    dismissSidebarFloatingUi,
  } = overlayMenus;

  const sharePanel = useShareDialogState();
  const {
    shareDialogUrl,
    setShareDialogUrl,
    shareTargetMessage,
    setShareTargetMessage,
    shareMode,
    setShareMode,
    shareForceFullConversation,
    setShareForceFullConversation,
    shareExpiresAt,
    setShareExpiresAt,
    isCreatingShareLink,
    setIsCreatingShareLink,
    isExportingSharePdf,
    setIsExportingSharePdf,
    setIsShareCopyPulse,
  } = sharePanel;

  const reportPanel = useReportDialogState();
  const {
    isReportDialogOpen,
    setIsReportDialogOpen,
    reportTargetConversationId,
    setReportTargetConversationId,
    setReportTargetMessageId,
    setReportTargetMessagePreview,
    setReportConversationTitle,
    setIsSubmittingReport,
  } = reportPanel;

  const navigate = useNavigate();
  // The URL is the single source of truth for which view is shown:
  //   "/"               → empty new-chat state
  //   "/c/:id"          → that conversation
  //   "/tasks"          → the scheduled-tasks page
  // conversationId is undefined on "/" and "/tasks".
  const { conversationId } = useParams();
  const location = useLocation();
  const isTasksRoute = location.pathname === "/tasks";
  // Create toast wrapper for handlers
  const toastWrapper = useCallback(
    (opts: { title: string; description?: string; variant?: string; duration?: number }) => {
      toast({
        title: opts.title,
        description: opts.description,
        variant: (opts.variant === "error" ? "destructive" : opts.variant) as
          "default" | "destructive" | undefined,
        duration: opts.duration,
      });
    },
    [toast],
  );

  const {
    beginRun: beginInferenceRun,
    stopRun: stopInferenceRun,
    resumeRun: resumeInferenceRunHandler,
    isInterruptResolved,
    deriveBranchSelectionsForActiveRun,
    getRunForConversation,
    isConversationStreaming,
  } = useInferenceRuns({
    userId,
    currentConversationId: currentConversation?.id ?? null,
    currentActiveRunId: currentConversation?.activeRunId ?? null,
    setConversations,
    setCurrentConversation,
    setThinkingState,
    setShowAiTransition,
    toast: toastWrapper,
  });

  const activeConversationRun = getRunForConversation(currentConversation?.id ?? null);
  const isCurrentConversationStreaming =
    isConversationStreaming(currentConversation?.id ?? null) ||
    Boolean(currentConversation?.activeRunId);

  // The composer: draft, attachments, dictation, layout, and the send flag.
  // Declared here because it needs the streaming flag above to know whether it
  // may accept input, and everything below needs its setters to clear the
  // composer (send, conversation switch, shared-conversation open).
  const composer = useComposer({
    userId,
    currentConversation,
    toast: toastWrapper,
    isConversationStreaming: isCurrentConversationStreaming,
  });
  const {
    currentMessage,
    setCurrentMessage,
    attachments,
    setAttachments,
    setIsSendingMessage,
    isBusy: isCurrentConversationBusy,
    isMessagesEmpty,
    dictationStatus,
    cancelDictation,
    handleFileDownload,
  } = composer;

  const stopActiveInferenceRun = useCallback(() => {
    void stopInferenceRun(activeConversationRun?.id ?? currentConversation?.activeRunId ?? null);
  }, [activeConversationRun?.id, currentConversation?.activeRunId, stopInferenceRun]);

  useActiveRunBranchSnap({
    currentConversation,
    activeConversationRun,
    deriveBranchSelectionsForActiveRun,
    setBranchSelections,
  });

  const { requestPersist } = useUISnapshotPersistence({
    userId,
    selectedAgent,
    isPrivateMode,
    sidebarOpen,
    activeProfileTab,
    currentConversationId: currentConversation?.id ?? null,
    availableTools,
    availableSkills,
    myRegistrySkills,
    agents,
    conversations,
    userPreferences,
  });

  // Declared after `requestPersist`: opening the settings panel writes the
  // active tab into the persisted UI snapshot.
  const settingsPanels = useSettingsPanels({ setActiveProfileTab, requestPersist });
  const {
    showUserProfile,
    showShortcutsPanel,
    showHelpPanel,
    openProfilePanel,
    closeProfilePanel,
    openShortcutsPanel,
    closeShortcutsPanel,
    closeHelpPanel,
    setShowUserProfile,
  } = settingsPanels;

  // Manual refresh from the Skills tab — hits the bridge with bypass_redis=true,
  // which refetches from the agents service and upserts the bridge's Redis

  /**
   * Re-pull the agent catalog after the user creates, edits or deletes an agent.
   *
   * The catalog is otherwise fetched once at login and once per page load, so
   * without this every place that renders agents from it — the header picker,
   * the Skills/Memories per-agent lists, the task form, message attribution —
   * would keep serving the pre-mutation list until a refresh.
   *
   * `removedAgentId` additionally re-points the selection: the picker's
   * `selectedAgent` is just an id, and if it names a deleted agent the header
   * falls back to a placeholder while sends still carry the dead id.
   */
  const refreshAgentCatalog = useCallback(
    async ({ removedAgentId }: { removedAgentId?: string } = {}) => {
      try {
        const fresh = await getAgents();
        setAgents(fresh);
        // Read the live selection from the store rather than closing over it,
        // so this callback stays stable across agent switches.
        if (removedAgentId && useWorkspaceStore.getState().selectedAgent === removedAgentId) {
          const nextAgent = fresh.find((agent) => agent.isActive) ?? fresh[0];
          setSelectedAgent(nextAgent?.id ?? "");
        }
      } catch (error) {
        // The mutation itself already succeeded and reported its own outcome;
        // a failed re-pull only means the list is stale until the next load, so
        // don't raise a second, contradictory error toast.
        if (import.meta.env.DEV) console.error("Failed to refresh the agent catalog:", error);
      } finally {
        requestPersist();
      }
    },
    [requestPersist],
  );

  const {
    isSearchOpen,
    searchQuery,
    setSearchQuery,
    searchResults,
    searchLoading,
    searchError,
    openSearchPanel,
    closeSearchPanel,
  } = useWorkspaceSearch({
    userId,
    onOpen: dismissSidebarFloatingUi,
  });

  const scheduledTasks = useScheduledTasks({ userId, active: isTasksRoute });

  useEffect(() => {
    const title = resolveConversationTitle(currentConversation);
    document.title = title ? `${title}` : "mAgenticX";
  }, [currentConversation]);

  // Active profile tab handler
  const handleSetActiveProfileTab = useCallback(
    (tab: string) => {
      setActiveProfileTab(tab);
      requestPersist();
    },
    [requestPersist],
  );

  // Private mode toggle handler
  const handleTogglePrivateMode = useCallback(() => {
    if ((currentConversation?.messages?.length ?? 0) === 0 || !isPrivateMode) {
      setIsPrivateMode(!isPrivateMode);
      requestPersist();
    }
  }, [currentConversation?.messages?.length, isPrivateMode, requestPersist]);

  // Sidebar open state handler
  const handleSidebarOpenChange = useCallback(
    (open: boolean) => {
      setSidebarOpen(open);
      requestPersist();
    },
    [requestPersist],
  );

  // Preferences handlers
  const {
    resolvedPreferences,
    handleToggleSuggestionsEnabled,
    handleToggleShowMessageTokenUsage,
    handleToggleSearchPastConvs,
    handleToggleUseMemory,
    handleSelectPersonality,
    handleSaveCustomInstructions,
    handleSelectVoiceModeVoice,
    handleSelectVoiceModeLanguage,
  } = usePreferencesHandlers({
    userId,
    userPreferences,
    setUserPreferences,
    isSavingPreferences,
    setIsSavingPreferences,
    toast: toastWrapper,
    persistUIState: requestPersist,
  });

  // Per-(user, agent) skill selection + the user's pool (Phase 2 Skills
  // feature). useProfilePanel wraps useSkills with the persist-aware mutation
  // callbacks wired exclusively to the ProfilePanel "Skills" tab. The bridge
  // endpoints write through to the agents service's per-user filesystem
  // (which IS the source of truth).
  const {
    selections: skillSelections,
    isLoading: isAgentSkillLoading,
    ensureLoaded: loadAgentSkills,
    toggleSkill: toggleUserAgentSkill,
    isToggling: isSkillToggling,
    mySkills,
    loadingMySkills,
    skillDetail: mySkillDetails,
    loadingSkillDetail,
    ensureSkillDetail,
    handleRefreshMySkills,
    handleAddGlobalSkill,
    handleCreateCustomSkill,
    handleRemoveSkillFromPool,
    myAgents,
    busyAgentId,
    getAgentDefinition,
    validateAgent,
    handleCreateAgent,
    handleUpdateAgent,
    handleDeleteAgent,
  } = useProfilePanel({
    userId,
    toast: toastWrapper,
    initialPool: myRegistrySkills,
    requestPersist,
    authResolved,
    refreshAgentCatalog,
  });

  // Per-(user, agent) long-term memory inspector for the ProfilePanel "Memories"
  // tab — read + delete only (the agent owns writes via its `remember` tool).
  // Not snapshot-persisted: memory lives on the agents filesystem, not the UI
  // snapshot, so it needs no requestPersist plumbing.
  const memoryInspector = useMemories({ userId, toast: toastWrapper });

  // Keep ChatPage's myRegistrySkills mirrored from the hook so the snapshot
  // persistence path sees the live pool. The hook is the source of truth;
  // this useEffect is a one-way sync.
  useEffect(() => {
    setMyRegistrySkills(mySkills);
  }, [mySkills]);

  // Per-conversation token usage (AI messages only) for the Settings → Usage
  // tab's "This conversation" card.
  const conversationUsage = useMemo(
    () => computeConversationUsage(activeMessages),
    [activeMessages],
  );

  useEffect(() => {
    setIsPlanExpanded(true);
  }, [currentConversation?.id]);

  const [isPlanExpanded, setIsPlanExpanded] = useState(true);

  // Memoized because it is threaded into the edit / retry / inference / feedback
  // factories below — an unstable identity here invalidates all of them.
  const setConversationMessages = useMemo(
    () =>
      createConversationMessageSetter({
        agents,
        selectedAgent,
        isPrivateMode,
        setCurrentConversation,
      }),
    [agents, selectedAgent, isPrivateMode, setCurrentConversation],
  );

  const reduceMotion = useReducedMotion();
  const { voiceSession, handleVoiceMode } = useChatVoiceMode({
    toast: toastWrapper,
    userId,
    selectedAgent,
    voiceModeVoice: resolvedPreferences.voiceModeVoice,
    voiceModeLanguage: resolvedPreferences.voiceModeLanguage,
  });
  // Voice mode is in-component state (no URL) and runs on whatever conversation
  // is current. From the tasks page there is no conversation surface, so leave
  // it for "/" first; "/" ↔ "/tasks" doesn't change :conversationId, so the
  // load effect won't re-close voice and race this start.
  const triggerVoiceMode = useCallback(() => {
    if (isTasksRoute) navigate("/");
    handleVoiceMode();
  }, [isTasksRoute, navigate, handleVoiceMode]);

  // Staged voice-mode transition (empty conversation only):
  //   forward (chat -> voice): chat-bar erases at center -> persona orb enters
  //     -> voice-bar appears at sticky-bottom.
  //   reverse (voice -> chat): voice-bar exits at sticky-bottom -> persona
  //     exits -> chat-bar appears at center.
  // In non-empty conversations everything switches in parallel (no staging)
  // since chat-bar and voice-bar share the sticky-bottom slot there.
  const { bodyTransition, voiceBarReady, chatBarReady, settledVoiceActive } =
    useVoiceBodyTransition({
      voiceActive: voiceSession.isActive,
      isEmptyConversation: isMessagesEmpty,
    });

  const {
    closeReportDialog,
    handleReportConversationFromSidebar,
    handleReportCurrentConversation,
    handleReportAiMessage,
    handleSubmitConversationReport,
  } = createReportHandlers({
    userId,
    conversations,
    currentConversation,
    reportTargetConversationId,
    setConversations,
    setArchivedConversations,
    setCurrentConversation,
    setIsReportDialogOpen,
    setReportTargetConversationId,
    setReportTargetMessageId,
    setReportTargetMessagePreview,
    setReportConversationTitle,
    setIsSubmittingReport,
    toast: toastWrapper,
    persistUIState: requestPersist,
  });

  const {
    closeShareDialog,
    copyShareDialogUrl,
    openShareDialog,
    openFullConversationShareDialog,
    handleShareModeChange,
    handleShareExpiresAtChange,
    handleCreateShareLink,
    handleDownloadSharePdf,
  } = createShareConversationHandlers({
    userId,
    currentConversation,
    activeMessages,
    activeBranchPath,
    shareDialogUrl,
    shareTargetMessage,
    shareMode,
    shareForceFullConversation,
    shareExpiresAt,
    isCreatingShareLink,
    isExportingSharePdf,
    setShareDialogUrl,
    setShareTargetMessage,
    setShareMode,
    setShareForceFullConversation,
    setShareExpiresAt,
    setIsCreatingShareLink,
    setIsExportingSharePdf,
    setIsShareCopyPulse,
    toast: toastWrapper,
    onShareCreated: (shareUrl) => {
      setShareDialogUrl(shareUrl);
      setIsShareCopyPulse(true);
    },
  });

  // Message edit handlers
  const { handleConfirmEditMessage } = createMessageEditHandlers({
    userId,
    currentConversation,
    setConversationMessages,
    setCurrentConversation,
    setConversations,
    toast: toastWrapper,
    setThinkingState,
    setShowAiTransition,
    streamAbortRef,
    rootBranchKey: ROOT_BRANCH_KEY,
    setBranchSelections,
    setIsSendingMessage,
    beginInferenceRun,
    persistUIState: requestPersist,
  });

  const {
    handleEditDraftChange,
    handleRequestEditMessage,
    handleCancelEditMessage,
    submitEditFromState,
  } = createMessageEditUiHandlers({
    editingMessageId,
    editingDraft,
    setEditingMessageId,
    setEditingDraft,
    setEditingBusy,
    setStickyUserBarId,
    handleConfirmEditMessage,
  });

  // Effects
  useEnsureDefaultAgentEffect({
    isLoggedIn,
    userId,
    agents,
    selectedAgent,
    setSelectedAgent,
  });

  // Handle inactive agent fallback
  useEffect(() => {
    if (!currentConversation?.agent) {
      setInactiveAgentFallback(null);
      return;
    }
    const convAgent = currentConversation.agent;
    const existsInList = agents.some((agent) => agent.id === convAgent.id);
    if (!existsInList || !convAgent.isActive) {
      setInactiveAgentFallback(convAgent);
    } else {
      setInactiveAgentFallback(null);
    }
  }, [currentConversation, agents]);

  // Session auto-refresh effect
  useSessionAutoRefreshEffect({
    isLoggedIn,
    setIsLoggedIn,
    setUserId,
    setUserProfile,
    toast: toastWrapper,
  });

  // Session state sync effect
  useSessionStateSyncEffect({
    userId,
    selectedAgent,
    currentConversationId: currentConversation?.id || null,
    isPrivateMode,
  });

  // Everything the URL does to the workspace: loading `:conversationId` (with
  // the generation guard that makes the newest navigation win), hydrating a
  // shared conversation, promoting a newly-created one into the URL, tearing
  // voice down on navigation, and keeping the agent selection valid when no
  // conversation is open.
  useConversationRouting({
    conversationId,
    isTasksRoute,
    navigate,
    authResolved,
    isLoggedIn,
    userId,
    sharedConversationToken,
    initialSharedConversation,
    currentConversation,
    agents,
    selectedAgent,
    setCurrentConversation,
    setSelectedAgent,
    setIsPrivateMode,
    setInactiveAgentFallback,
    setLoadingConversation,
    setThinkingState,
    setExpandedThinking,
    setAttachments,
    setCurrentMessage,
    setBranchSelections,
    closeVoiceSession: voiceSession.close,
    deriveBranchSelectionsForActiveRun,
    requestPersist,
    toast: toastWrapper,
  });

  // Auth rehydration effect
  useAuthRehydrateEffect({
    setIsLoggedIn,
    setUserId,
    setUserProfile,
    setAuthResolved,
    setAgents,
    setAvailableTools,
    setAvailableSkills,
    setMyRegistrySkills,
    setUserPreferences,
    setConversations,
    setConversationsLoading,
    setCurrentConversation,
    setLoadingConversation,
    setSelectedAgent,
    setIsPrivateMode,
    setActiveProfileTab,
    setSidebarOpen,
    persistUIState: requestPersist,
    toast: toastWrapper,
  });

  // Create UI handlers
  const { handleCopy, handleImageClick, handleCloseImagePreview } = useMemo(
    () => createUIHandlers({ toast: toastWrapper, setCopiedId, setSelectedImage }),
    [toastWrapper, setCopiedId, setSelectedImage],
  );
  const { handleReadAloud, stopReadAloud } = useMemo(
    () =>
      createReadAloudHandlers({
        userId,
        conversationId: currentConversation?.id ?? null,
        setSpeakingMessageId,
        toast: toastWrapper,
      }),
    [userId, currentConversation?.id, setSpeakingMessageId, toastWrapper],
  );

  useEffect(() => () => stopReadAloud(), []);

  const dismissActiveUi = useCallback(() => {
    return runActiveUiDismissal({
      isSearchOpen,
      selectedFilePreview,
      selectedImage,
      dictationStatus,
      isReportDialogOpen,
      shareTargetMessage,
      showUserProfile,
      showShortcutsPanel,
      showHelpPanel,
      isAgentPickerOpen,
      isHeaderActionMenuOpen,
      isSidebarFloatingUiOpen,
      editingMessageId,
      closeSearchPanel,
      closeFilePreview,
      closeImagePreview: handleCloseImagePreview,
      cancelDictation,
      closeReportDialog,
      closeShareDialog,
      closeProfilePanel,
      closeShortcutsPanel,
      closeHelpPanel,
      handleCancelEditMessage,
      closeAgentPicker: overlayMenus.closeAgentPicker,
      closeHeaderActionMenu: overlayMenus.closeHeaderActionMenu,
      dismissSidebarFloatingUi,
    });
  }, [
    cancelDictation,
    closeSearchPanel,
    closeReportDialog,
    closeShareDialog,
    closeProfilePanel,
    closeShortcutsPanel,
    closeHelpPanel,
    closeFilePreview,
    dictationStatus,
    dismissSidebarFloatingUi,
    editingMessageId,
    handleCancelEditMessage,
    handleCloseImagePreview,
    isAgentPickerOpen,
    isHeaderActionMenuOpen,
    isReportDialogOpen,
    isSearchOpen,
    isSidebarFloatingUiOpen,
    overlayMenus.closeAgentPicker,
    overlayMenus.closeHeaderActionMenu,
    selectedFilePreview,
    selectedImage,
    shareTargetMessage,
    showUserProfile,
    showShortcutsPanel,
    showHelpPanel,
  ]);

  // Create AI transition handlers.
  // Memoized deliberately: this factory returns a *component*, and React
  // compares element types by identity. Calling it bare gave `<AiTransitionIndicator/>`
  // a brand-new type on every render, so the indicator's DOM was torn down and
  // rebuilt on every streamed token instead of simply re-rendering.
  const { AiTransitionIndicator } = useMemo(
    () =>
      createAiTransitionHandlers({
        showAiTransition,
        thinkingState,
        activeBranchPath,
      }),
    [showAiTransition, thinkingState, activeBranchPath],
  );

  // Retry handlers
  const { handleRetryAiMessage } = createRetryHandlers({
    userId,
    currentConversation,
    setConversationMessages,
    setCurrentConversation,
    setConversations,
    toast: toastWrapper,
    setThinkingState,
    setShowAiTransition,
    streamAbortRef,
    rootBranchKey: ROOT_BRANCH_KEY,
    setBranchSelections,
    setIsSendingMessage,
    beginInferenceRun,
    persistUIState: requestPersist,
  });

  // Inference handler
  const { handleSendMessage, handleStopStreaming } = createInferenceHandlers({
    userId,
    selectedAgent,
    isPrivateMode,
    messages: activeMessages,
    attachments,
    agents,
    currentConversation,
    currentMessage,
    isSendingMessage: isCurrentConversationBusy,
    setMessages: setConversationMessages,
    setCurrentMessage,
    setAttachments,
    setIsSendingMessage,
    setCurrentConversation,
    setConversations,
    toast: toastWrapper,
    setThinkingState,
    setShowAiTransition,
    streamAbortRef,
    beginInferenceRun,
    stopActiveInferenceRun,
    sharedConversationToken,
    persistUIState: requestPersist,
  });

  // Conversation handlers
  const {
    handleConversationSelect,
    handleDeleteConversation,
    handleNewChat,
    handleTitleClick,
    handleLoadMoreConversations,
    clearChatAndStopThinking,
    handleDeleteCurrentConversation,
    handleRenameConversation,
    handleArchiveConversation,
    handleUnarchiveConversation,
    handleArchiveCurrentConversation,
    handleUnarchiveCurrentConversation,
    handleOpenSearch,
    handleForkConversation,
    refreshArchivedConversations,
    handleLoadMoreArchivedConversations,
  } = createConversationHandlers({
    userId,
    setConversations,
    currentConversation,
    navigate,
    setLoadingConversation,
    setSelectedAgent,
    setCurrentConversation,
    setBranchSelections,
    setIsPrivateMode,
    setAttachments,
    setCurrentMessage,
    toast: toastWrapper,
    convPage,
    setConvPage,
    convHasMore,
    setConvHasMore,
    convIsLoadingMore,
    setConvIsLoadingMore,
    pageSize: CONV_PAGE_SIZE,
    setArchivedConversations,
    archivedConvPage,
    setArchivedConvPage,
    archivedConvHasMore,
    setArchivedConvHasMore,
    archivedConvIsLoading,
    setArchivedConvIsLoading,
    archivedPageSize: ARCHIVED_CONV_PAGE_SIZE,
    onSearch: openSearchPanel,
    persistUIState: requestPersist,
  });

  const {
    refreshSharedConversations,
    handleLoadMoreSharedConversations,
    handleOpenSharedConversation,
    handleRevokeSharedConversation,
  } = createSharedConversationHandlers({
    userId,
    sharedConversationsPage: sharedConvPage,
    sharedConversationsHasMore: sharedConvHasMore,
    sharedConversationsLoading: sharedConvIsLoading,
    pageSize: SHARED_CONV_PAGE_SIZE,
    setSharedConversations,
    setSharedConversationsPage: setSharedConvPage,
    setSharedConversationsHasMore: setSharedConvHasMore,
    setSharedConversationsLoading: setSharedConvIsLoading,
    closeProfilePanel,
    setLoadingConversation,
    setSelectedAgent,
    setCurrentConversation,
    setIsPrivateMode,
    setExpandedThinking,
    setAttachments,
    setCurrentMessage,
    toast: toastWrapper,
    persistUIState: requestPersist,
  });

  useEffect(() => {
    // "archived" is the pre-taxonomy id for the Data controls section; stale
    // persisted snapshots may still carry it, so honor both.
    if (
      !showUserProfile ||
      (activeProfileTab !== "data-controls" && activeProfileTab !== "archived")
    ) {
      return;
    }

    void refreshArchivedConversations();
    void refreshSharedConversations();
  }, [activeProfileTab, showUserProfile, userId]);

  const handleOpenArchivedConversation = useCallback(
    async (conversation: ConversationSummary) => {
      closeProfilePanel();
      await handleConversationSelect(conversation);
    },
    [closeProfilePanel, handleConversationSelect],
  );

  // Agent change handler
  const { handleAgentChange } = useMemo(
    () =>
      createAgentHandlers({
        setSelectedAgent,
        persistUIState: requestPersist,
      }),
    [setSelectedAgent, requestPersist],
  );

  const { handleSearchResultSelect } = useMemo(
    () =>
      createSearchResultHandlers({
        agents,
        onAgentSelect: handleAgentChange,
        onConversationSelect: (conversation) => void handleConversationSelect(conversation),
        onCloseSearch: closeSearchPanel,
      }),
    [agents, handleAgentChange, handleConversationSelect, closeSearchPanel],
  );
  const defaultSearchResults = useMemo(
    () => buildDefaultConversationSearchResults(conversations),
    [conversations],
  );

  // Handle thinking toggle. `next` carries the explicit target state when the
  // block's default (absent from the record) is open — a bare flip of an
  // unset key would no-op visually on the first click.
  // Multi-account sign-in: the switcher's state, the switch interstitial, and
  // the callbacks the sidebar and the account-limit dialog fire. `handleLogout`
  // comes back out because it is also the profile menu's Sign out and the
  // target of the `mx:unauthorized` listener below.
  const accountSwitching = useAccountSwitching({
    isLoggedIn,
    userId,
    navigate,
    auth: {
      setIsLoggedIn,
      setUserId,
      setUserProfile,
      setAgents,
      setConversationsLoading,
      setAvailableTools,
      setAvailableSkills,
      setMyRegistrySkills,
      setUserPreferences,
      setConversations,
      setShowUserProfile,
      clearChatAndStopThinking,
      persistUIState: requestPersist,
      toast: toastWrapper,
      loginUsername: "",
      loginPassword: "",
      onLoggedOut: () => navigate("/login", { replace: true }),
      onClearUISnapshot: (uid) => clearUISnapshot(uid).catch(() => {}),
      resetWorkspace: resetForAccountSwitch,
      // Read at call time, not closed over: the switch changes it mid-flight.
      activeUserId: () => useWorkspaceStore.getState().userId,
      // Leave the conversation route before the identity changes: the :id in the
      // URL belongs to the account being left and must not be refetched as the new
      // one's. The interstitial covers the transition.
      navigateHome: () => navigate("/", { replace: true }),
    },
  });
  const { handleLogout } = accountSwitching;

  // Unauthorized event listener
  useEffect(() => {
    const handleUnauthorized = () => {
      handleLogout();
      toast({
        title: "Session expired",
        description: "Please sign in again to continue.",
        variant: "destructive",
        duration: 3000,
      });
    };
    window.addEventListener("mx:unauthorized", handleUnauthorized);
    return () => {
      window.removeEventListener("mx:unauthorized", handleUnauthorized);
    };
  }, [handleLogout, toast]);

  // Redirect to login when session is missing/cleared
  useEffect(() => {
    if (authResolved && (!isLoggedIn || !userId)) {
      navigate("/login", { replace: true });
    }
  }, [authResolved, isLoggedIn, userId, navigate]);

  // Feedback handlers
  const { handleLike, handleDislike } = createFeedbackHandlers({
    userId,
    currentConversation,
    setConversationMessages,
    toast: toastWrapper,
  });

  // Determine current agent and its icon
  const conversationAgent = currentConversation?.agent ?? null;
  const selectedAgentFromList = agents.find((a) => a.id === selectedAgent) ?? null;
  const fallbackSelectedAgent =
    inactiveAgentFallback && inactiveAgentFallback.id === selectedAgent
      ? inactiveAgentFallback
      : null;
  const effectiveSelectedAgent = selectedAgentFromList ?? fallbackSelectedAgent ?? null;
  const currentAgent = conversationAgent ?? effectiveSelectedAgent ?? null;
  // The input bar reflects ONLY the header dropdown selection (the agent the
  // next message is sent to) — never the conversation's stored agent. With no
  // selection it stays null so the placeholder is vague and name-free rather
  // than showing the wrong agent.
  const inputBarAgent = effectiveSelectedAgent;
  const AgentIcon = currentAgent?.icon || Building2;

  // Per-message agent: each AI message renders the agent that produced it,
  // resolved from the catalog by id, falling back to the denormalized
  // agentName (deactivated/removed agent) and finally the conversation agent
  // (pre-migration messages with no agentId).
  const resolveMessageAgent = useCallback(
    (message: MessageOut) => {
      if (message.agentId) {
        const found = agents.find((a) => a.id === message.agentId);
        if (found) return { name: found.name, Icon: found.icon };
        if (message.agentName) return { name: message.agentName, Icon: Building2 };
      }
      return { name: currentAgent?.name ?? "Unknown agent", Icon: AgentIcon };
    },
    [agents, currentAgent, AgentIcon],
  );
  const activePlan = activeConversationRun?.timeline?.plan?.items?.length
    ? activeConversationRun.timeline.plan
    : null;
  const showPlanningCard = isCurrentConversationBusy && Boolean(activePlan);
  // Pending HITL approvals of the active run drive the input-bar takeover.
  // The timeline's own resolution state (BRIDGE_HITL_RESOLVED markers) is
  // overlaid with the client-side resolved set so the surface swaps back the
  // instant the bridge confirms the resume, before the next WS frame lands.
  const pendingRunInterrupts = useMemo(() => {
    const run = activeConversationRun;
    if (!run?.timeline) return [];
    return pendingTimelineInterrupts(run.timeline).filter(
      (item) => !isInterruptResolved(run.id, item.id),
    );
  }, [activeConversationRun, isInterruptResolved]);
  const activeHitlInterrupt = pendingRunInterrupts[0] ?? null;
  const canShareCurrentConversation = Boolean(
    currentConversation?.id && !currentConversation.id.startsWith("shared:"),
  );
  const canShareFullConversation =
    canShareCurrentConversation &&
    activeMessages.some(
      (message) =>
        message.sender === "ai" &&
        !String(message.id).startsWith("temp-") &&
        (Boolean(message.content?.trim()) || (message.attachments?.length ?? 0) > 0),
    );
  const canTogglePrivateMode = (currentConversation?.messages?.length ?? 0) === 0 || isPrivateMode;
  const canShowStarterSuggestions =
    !currentConversation &&
    currentMessage.trim().length === 0 &&
    resolvedPreferences.suggestionsEnabled !== false &&
    starterSuggestions.length > 0;

  const preferencesLoaded = userPreferences !== null;

  useEffect(() => {
    let cancelled = false;
    if (
      !userId ||
      !preferencesLoaded ||
      currentConversation ||
      currentMessage.trim().length > 0 ||
      resolvedPreferences.suggestionsEnabled === false
    ) {
      setStarterSuggestions([]);
      return () => {
        cancelled = true;
      };
    }

    getSuggestions(userId, selectedAgent || currentAgent?.id || null)
      .then((suggestions) => {
        if (cancelled) return;
        setStarterSuggestions(pickVisibleSuggestions(suggestions));
      })
      .catch(() => {
        if (!cancelled) setStarterSuggestions([]);
      });

    return () => {
      cancelled = true;
    };
  }, [
    userId,
    preferencesLoaded,
    selectedAgent,
    currentAgent?.id,
    currentConversation,
    currentMessage,
    resolvedPreferences.suggestionsEnabled,
  ]);

  const handleStarterSuggestionSelect = composer.applyDraft;

  const renderConversationBody = (mode: ConversationBodyMode) => {
    if (mode === "voice") {
      return (
        <VoiceModeBody
          status={voiceSession.status}
          muted={voiceSession.muted}
          currentAgent={currentAgent}
          errorMessage={voiceSession.errorMessage}
        />
      );
    }

    return (
      <ChatBody
        messages={activeMessages}
        showMessageTokenUsage={resolvedPreferences.showMessageTokenUsage === true}
        loadingConversation={loadingConversation}
        expandedThinking={expandedThinking}
        isImageFile={composer.isImageFile}
        onDownloadAttachment={handleFileDownload}
        onPreviewAttachment={openFilePreview}
        onImageClick={handleImageClick}
        onToggleThinking={toggleThinking}
        copiedId={copiedId}
        onCopy={handleCopy}
        onLike={handleLike}
        onDislike={handleDislike}
        onReportMessage={handleReportAiMessage}
        conversationIsReported={Boolean(currentConversation?.isReported)}
        stickyUserBarId={stickyUserBarId}
        onFlashUserActionBar={flashUserActionBar}
        AiTransitionIndicator={AiTransitionIndicator}
        thinkingState={thinkingState}
        messagesEndRef={messagesEndRef}
        AgentIcon={AgentIcon}
        currentAgent={currentAgent ?? undefined}
        resolveMessageAgent={resolveMessageAgent}
        onScrolledPastTop={handleHeaderScrollState}
        branchChildrenMap={messageInteraction.branchChildrenMap}
        branchSelections={branchSelections}
        onSelectBranch={messageInteraction.handleBranchSelectionChange}
        branchRootKey={ROOT_BRANCH_KEY}
        activeBranchPath={activeBranchPath}
        editingMessageId={editingMessageId}
        editingDraft={editingDraft}
        editingBusy={messageInteraction.editingBusy}
        onRequestEdit={handleRequestEditMessage}
        onChangeEditDraft={handleEditDraftChange}
        onCancelEdit={handleCancelEditMessage}
        onSubmitEdit={submitEditFromState}
        onRetryMessage={handleRetryAiMessage}
        onForkMessage={handleForkConversation}
        onShareMessage={openShareDialog}
        onReadAloud={handleReadAloud}
        speakingMessageId={speakingMessageId}
        isStreaming={isCurrentConversationBusy}
        liveTimeline={activeConversationRun?.timeline ?? null}
        activeRunAssistantMessageId={activeConversationRun?.assistantMessageId ?? null}
        scrollResetKey={currentConversation?.id ?? null}
      />
    );
  };

  // The hook returns the full workspace bundle. The shell (below) does the auth
  // gate and renders the chrome; the route views consume slices of this.
  return {
    // auth / gate
    authResolved,
    isLoggedIn,
    userId,
    // store data
    availableTools,
    availableSkills,
    isSavingPreferences,
    conversations,
    conversationsLoading,
    convHasMore,
    convIsLoadingMore,
    archivedConversations,
    archivedConvIsLoading,
    archivedConvHasMore,
    sharedConversations,
    sharedConvIsLoading,
    sharedConvHasMore,
    userProfile,
    activeProfileTab,
    sidebarOpen,
    // view-local state
    thinkingState,
    // The composer: draft, attachments, dictation, layout, refs.
    composer,
    // Overlay/panel state, one key per surface rather than ~28 loose flags.
    // Each object is a stable hook result, so a consumer that reads only its own
    // panel is not re-rendered by another panel opening.
    settingsPanels,
    attachmentPreview,
    overlayMenus,
    sharePanel,
    reportPanel,
    isPlanExpanded,
    setIsPlanExpanded,
    bodyTransition,
    voiceBarReady,
    chatBarReady,
    // refs
    agentTriggerRef,
    // hook outputs / context
    headerHasDivider,
    navigate,
    reduceMotion,
    voiceSession,
    scheduledTasks,
    resumeInferenceRunHandler,
    isInterruptResolved,
    resolvedPreferences,
    toast,
    isSearchOpen,
    searchQuery,
    searchResults,
    searchLoading,
    searchError,
    setSearchQuery,
    closeSearchPanel,
    conversationUsage,
    activeConversationRun,
    pendingRunInterrupts,
    activeHitlInterrupt,
    // profile/skills
    skillSelections,
    loadAgentSkills,
    toggleUserAgentSkill,
    isAgentSkillLoading,
    isSkillToggling,
    mySkills,
    loadingMySkills,
    mySkillDetails,
    loadingSkillDetail,
    ensureSkillDetail,
    handleRefreshMySkills,
    handleAddGlobalSkill,
    handleCreateCustomSkill,
    handleRemoveSkillFromPool,
    // profile/agents (the Agents-tab builder)
    myAgents,
    busyAgentId,
    getAgentDefinition,
    validateAgent,
    handleCreateAgent,
    handleUpdateAgent,
    handleDeleteAgent,
    // multi-account switcher — one key; the shell reads what it needs off it
    accountSwitching,
    memoryInspector,
    // derived
    inputBarAgent,
    settledVoiceActive,
    isCurrentConversationBusy,
    activePlan,
    showPlanningCard,
    canShareFullConversation,
    canTogglePrivateMode,
    canShowStarterSuggestions,
    defaultSearchResults,
    renderConversationBody,
    // handlers
    handleSidebarOpenChange,
    handleOpenSearch,
    triggerVoiceMode,
    openAgentPicker,
    handleTogglePrivateMode,
    openProfilePanel,
    closeProfilePanel,
    openShortcutsPanel,
    handleNewChat,
    dismissActiveUi,
    handleConversationSelect,
    handleDeleteConversation,
    handleRenameConversation,
    handleArchiveConversation,
    handleReportConversationFromSidebar,
    handleLoadMoreConversations,
    handleTitleClick,
    handleSearchResultSelect,
    handleAgentChange,
    handleArchiveCurrentConversation,
    handleUnarchiveCurrentConversation,
    handleReportCurrentConversation,
    handleDeleteCurrentConversation,
    openFullConversationShareDialog,
    handleToggleShowMessageTokenUsage,
    handleSendMessage,
    handleStopStreaming,
    handleImageClick,
    handleStarterSuggestionSelect,
    handleSetActiveProfileTab,
    handleLogout,
    handleLoadMoreArchivedConversations,
    handleOpenArchivedConversation,
    handleUnarchiveConversation,
    handleLoadMoreSharedConversations,
    handleOpenSharedConversation,
    handleRevokeSharedConversation,
    handleToggleSuggestionsEnabled,
    handleToggleSearchPastConvs,
    handleToggleUseMemory,
    handleSelectPersonality,
    handleSaveCustomInstructions,
    handleSelectVoiceModeVoice,
    handleSelectVoiceModeLanguage,
    closeReportDialog,
    handleSubmitConversationReport,
    handleShareModeChange,
    handleShareExpiresAtChange,
    closeShareDialog,
    copyShareDialogUrl,
    handleCreateShareLink,
    handleDownloadSharePdf,
    handleFileDownload,
    handleCloseImagePreview,
  };
}

// The full workspace bundle type, inferred from the hook. Consumed by the route
// views via `useChatWorkspaceContext` in app/workspaceContext.
export type ChatWorkspace = ReturnType<typeof useChatWorkspace>;
