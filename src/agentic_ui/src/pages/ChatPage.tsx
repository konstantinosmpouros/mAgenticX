import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Building2, X } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

// Import types for messages, thinking state, conversations, and agents
import type {
  ThinkingState, Agent,
  MessageOut,
  ConversationDetail,
  ConversationSummary,
  ConversationShareListItem,
  ConversationShareMode,
  SharedConversationDetail,
  Skill,
  UserSkill,
  UserProfile,
  ToolMetadata,
  UserPreferences } from "@/lib/types";
import { usePreferencesHandlers } from "@/handlers/preferences";
import { useProfilePanel } from "@/hooks/useProfilePanel";
import {
  useEnsureDefaultAgentEffect,
  useHeaderDividerEffect,
  useCenteredComposerLayout,
  useStickyUserBarEffect,
  useSidebarInteractionEffect,
} from "@/hooks/useChatEffects";
import { useChatVoiceMode } from "@/hooks/useChatVoiceMode";
import {
  useAuthRehydrateEffect,
  useSessionAutoRefreshEffect,
  useSessionStateSyncEffect,
  useInitialSessionState,
  useUISnapshotPersistence,
} from "@/hooks/useSessionEffects";
import { useActiveRunBranchSnap } from "@/hooks/useActiveRunBranchSnap";

// Handlers (modularized)
import {
  createAttachmentHandlers,
  createConversationHandlers,
  createAgentHandlers,
  createAuthHandlers,
  createUIHandlers,
  createAiTransitionHandlers,
  createConversationMessageSetter,
  createFeedbackHandlers,
  createVoiceDictationHandlers,
  createReadAloudHandlers,
  createMessageEditUiHandlers,
  createReportHandlers,
  createShareConversationHandlers,
  createSharedConversationHandlers,
  defaultShareExpiresAt,
  useBranchingHandlers,
  createSearchResultHandlers,
  useWorkspaceSearch,
  buildDefaultConversationSearchResults,
  runActiveUiDismissal,
} from "@/handlers";
import {
  createInferenceHandlers,
  createMessageEditHandlers,
  createRetryHandlers,
  useInferenceRuns,
  HitlProvider,
  pendingTimelineInterrupts,
} from "@/runtime";
import { loadSession } from "@/lib/authStorage";
import { getConversationDetail, getSkills, getSuggestions } from "@/lib/api";

// Chat Interface component
import ChatHeader from "@/components/chat/ChatHeader";
import ChatSidebar from "@/components/chat/ChatSidebar";
import AttachmentPreviewPanel, { type AttachmentPreviewTarget } from "@/components/chat/AttachmentPreviewPanel";
import { PlanCard } from "@/components/chat/message_parts/PlanningContainer";
import { OVERLAY_HOST_ID } from "@/lib/overlay-host";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import ProfilePanel from "@/components/chat/ProfilePanel";
import ReportConversationDialog from "@/components/chat/ReportPanel";
import ShareConversationDialog from "@/components/chat/SharePanel";
import ChatBody from "@/components/chat/ChatBody";
import VoiceModeBody from "@/components/chat/VoiceModeBody";
import { ChatInputBar, type DictationStatus } from "@/components/chat/ChatInputBar";
import { HitlInputTakeover } from "@/components/chat/HitlInputTakeover";
import SearchPanel from "@/components/chat/SearchPanel";
import { Loader } from "@/components/ui/shadcn-io/loader";
import { clearUISnapshot } from "@/lib/uiStateStorage";
import type { AttachmentLike } from "@/components/chat/message_parts/MessageAttachments";

const ROOT_BRANCH_KEY = "__root__";
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

type ChatInterfaceProps = {
  sharedConversationToken?: string;
  initialSharedConversation?: SharedConversationDetail | null;
};

type ConversationBodyMode = "chat" | "voice";

export function ChatInterface({
  sharedConversationToken,
  initialSharedConversation,
}: ChatInterfaceProps = {}) {
  // Initial session check
  const { initialUserId, initialUserProfile, initialLoggedIn } = useInitialSessionState();

  // Main state variables
  const [currentConversation, setCurrentConversation] = useState<ConversationDetail | null>(null);
  const [currentMessage, setCurrentMessage] = useState('');
  const [attachments, setAttachments] = useState<File[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string>('');
  const [isPrivateMode, setIsPrivateMode] = useState(false);

  // Main variables use for storing info from the db and present it constantly
  const [agents, setAgents] = useState<Agent[]>([]);
  const [availableTools, setAvailableTools] = useState<ToolMetadata[]>([]);
  const [availableSkills, setAvailableSkills] = useState<Skill[]>([]);
  const [myRegistrySkills, setMyRegistrySkills] = useState<UserSkill[]>([]);
  const [userPreferences, setUserPreferences] = useState<UserPreferences | null>(null);
  const [isSavingPreferences, setIsSavingPreferences] = useState(false);
  const [inactiveAgentFallback, setInactiveAgentFallback] = useState<Agent | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState<boolean>(false);
  const [starterSuggestions, setStarterSuggestions] = useState<string[]>([]);

  // Conversation list pagination state (persist across sidebar open/close)
  const [convPage, setConvPage] = useState<number>(1);
  const [convHasMore, setConvHasMore] = useState<boolean>(true);
  const [convIsLoadingMore, setConvIsLoadingMore] = useState<boolean>(false);
  const CONV_PAGE_SIZE = 10;
  const [archivedConversations, setArchivedConversations] = useState<ConversationSummary[]>([]);
  const [archivedConvPage, setArchivedConvPage] = useState<number>(1);
  const [archivedConvHasMore, setArchivedConvHasMore] = useState<boolean>(true);
  const [archivedConvIsLoading, setArchivedConvIsLoading] = useState<boolean>(false);
  const ARCHIVED_CONV_PAGE_SIZE = 10;
  const [sharedConversations, setSharedConversations] = useState<ConversationShareListItem[]>([]);
  const [sharedConvPage, setSharedConvPage] = useState<number>(1);
  const [sharedConvHasMore, setSharedConvHasMore] = useState<boolean>(true);
  const [sharedConvIsLoading, setSharedConvIsLoading] = useState<boolean>(false);
  const SHARED_CONV_PAGE_SIZE = 10;

  // Thinking variables (will be changed)
  const [expandedThinking, setExpandedThinking] = useState<{[key: string]: boolean}>({});
  const [thinkingState, setThinkingState] = useState<ThinkingState | null>(null);
  const [showAiTransition, setShowAiTransition] = useState(false);

  const [userProfile, setUserProfile] = useState<UserProfile | null>(initialUserProfile);
  // Login and authentication variables
  const [isLoggedIn, setIsLoggedIn] = useState<boolean>(initialLoggedIn);
  const [userId, setUserId] = useState<string | null>(initialUserId);
  const [authResolved, setAuthResolved] = useState(false);

  // Boolean variables for navigation
  const [isClearing, setIsClearing] = useState(false);
  const [isSendingMessage, setIsSendingMessage] = useState(false);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [showUserProfile, setShowUserProfile] = useState(false);
  const { headerHasDivider, handleHeaderScrollState } = useHeaderDividerEffect();

  // UI components
  const [activeProfileTab, setActiveProfileTab] = useState('profile');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const agentTriggerRef = useRef<HTMLButtonElement>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  const { toast } = useToast();

  // Copy to clipboard state
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(null);

  // Image preview
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [selectedFilePreview, setSelectedFilePreview] = useState<AttachmentPreviewTarget | null>(null);
  const [isAgentPickerOpen, setIsAgentPickerOpen] = useState(false);
  const [isHeaderActionMenuOpen, setIsHeaderActionMenuOpen] = useState(false);
  const [isSidebarFloatingUiOpen, setIsSidebarFloatingUiOpen] = useState(false);
  const [sidebarDismissFloatingUiSignal, setSidebarDismissFloatingUiSignal] = useState(0);
  const [isReportDialogOpen, setIsReportDialogOpen] = useState(false);
  const [shareDialogUrl, setShareDialogUrl] = useState<string | null>(null);
  const [shareTargetMessage, setShareTargetMessage] = useState<MessageOut | null>(null);
  const [shareMode, setShareMode] = useState<ConversationShareMode>("full");
  const [shareForceFullConversation, setShareForceFullConversation] = useState(false);
  const [shareExpiresAt, setShareExpiresAt] = useState<Date | null>(() => defaultShareExpiresAt());
  const [isCreatingShareLink, setIsCreatingShareLink] = useState(false);
  const [isExportingSharePdf, setIsExportingSharePdf] = useState(false);
  const [isShareCopyPulse, setIsShareCopyPulse] = useState(false);
  const [reportTargetConversationId, setReportTargetConversationId] = useState<string | null>(null);
  const [reportTargetMessageId, setReportTargetMessageId] = useState<string | null>(null);
  const [reportTargetMessagePreview, setReportTargetMessagePreview] = useState<string | null>(null);
  const [reportConversationTitle, setReportConversationTitle] = useState<string | null>(null);
  const [isSubmittingReport, setIsSubmittingReport] = useState(false);

  // Sticky user action bar
  const [stickyUserBarId, setStickyUserBarId] = useState<string | null>(null);
  const { flashUserActionBar } = useStickyUserBarEffect({ setStickyUserBarId });

  // Branch selections (parentId -> child index)
  const [branchSelections, setBranchSelections] = useState<Record<string, number>>({});

  // Message editing state
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState("");
  const [editingBusy, setEditingBusy] = useState(false);
  const navigate = useNavigate();

  // Create toast wrapper for handlers
  const toastWrapper = useCallback((opts: { title: string; description?: string; variant?: string; duration?: number }) => {
    toast({
      title: opts.title,
      description: opts.description,
      variant: (opts.variant === 'error' ? 'destructive' : opts.variant) as 'default' | 'destructive' | undefined,
      duration: opts.duration,
    });
  }, [toast]);

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
  const isCurrentConversationStreaming = isConversationStreaming(currentConversation?.id ?? null) || Boolean(currentConversation?.activeRunId);
  const isCurrentConversationBusy = isSendingMessage || isCurrentConversationStreaming;
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

  // Manual refresh from the Skills tab — hits the bridge with bypass_redis=true,
  // which refetches from the agents service and upserts the bridge's Redis
  // cache. State updates immediately so the UI reflects the new list, and the
  // snapshot is overwritten next time requestPersist fires.
  const handleRefreshSkills = useCallback(async () => {
    try {
      const fresh = await getSkills({ bypassRedis: true });
      setAvailableSkills(fresh);
      requestPersist();
    } catch (error) {
      console.error("Failed to refresh skills:", error);
      toastWrapper({
        title: "Couldn't refresh skills",
        description: error instanceof Error ? error.message : "Try again in a moment.",
        variant: "destructive",
      });
    }
  }, [requestPersist]);

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
    onOpen: () => setSidebarDismissFloatingUiSignal((value) => value + 1),
  });

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
    toolsWithStatus,
    enabledToolsForRequest,
    resolvedPreferences,
    handleToggleToolPreference,
    handleToggleSuggestionsEnabled,
    handleSelectVoiceModeVoice,
    handleSelectVoiceModeLanguage,
  } = usePreferencesHandlers({
    userId,
    availableTools,
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
  } = useProfilePanel({ userId, toast: toastWrapper, initialPool: myRegistrySkills, requestPersist });

  // Keep ChatPage's myRegistrySkills mirrored from the hook so the snapshot
  // persistence path sees the live pool. The hook is the source of truth;
  // this useEffect is a one-way sync.
  useEffect(() => {
    setMyRegistrySkills(mySkills);
  }, [mySkills]);

  const hydratedSharedTokenRef = useRef<string | null>(null);
  useEffect(() => {
    if (!sharedConversationToken || !initialSharedConversation || !authResolved || !isLoggedIn || !userId) return;
    if (hydratedSharedTokenRef.current === sharedConversationToken) return;

    hydratedSharedTokenRef.current = sharedConversationToken;
    setSelectedAgent(initialSharedConversation.agent.id);
    setIsPrivateMode(false);
    setCurrentConversation({
      id: `shared:${sharedConversationToken}`,
      agent: initialSharedConversation.agent,
      title: initialSharedConversation.title || "Shared conversation",
      isPrivate: false,
      created_at: initialSharedConversation.createdAt,
      updated_at: initialSharedConversation.createdAt,
      messages: initialSharedConversation.messages,
    });
  }, [authResolved, initialSharedConversation, isLoggedIn, sharedConversationToken, userId]);

  // Branching handlers
  const {
    activeMessages,
    branchChildrenMap,
    handleBranchSelectionChange,
    activeBranchPath,
  } = useBranchingHandlers({
    messages: currentConversation?.messages,
    branchSelections,
    setBranchSelections,
    rootKey: ROOT_BRANCH_KEY,
  });

  // Reset message editing state on conversation change
  useEffect(() => {
    setEditingMessageId(null);
    setEditingDraft("");
    setEditingBusy(false);
  }, [currentConversation?.id]);

  useEffect(() => {
    setIsPlanExpanded(true);
  }, [currentConversation?.id]);

  // Dictation state machine
  const [dictationStatus, setDictationStatus] = useState<DictationStatus>("idle");
  const [dictationRequestSignal, setDictationRequestSignal] = useState(0);
  const [dictationCancelSignal, setDictationCancelSignal] = useState(0);
  const [isPlanExpanded, setIsPlanExpanded] = useState(true);

  const setConversationMessages = createConversationMessageSetter({
    agents,
    selectedAgent,
    isPrivateMode,
    setCurrentConversation,
  });

  const openProfilePanel = useCallback(
    (tab: string = "profile") => {
      setActiveProfileTab(tab);
      setShowUserProfile(true);
      requestPersist();
    },
    [requestPersist],
  );

  const closeProfilePanel = useCallback(() => {
    setShowUserProfile(false);
  }, []);

  const focusComposer = useCallback(() => {
    textareaRef.current?.focus();
  }, []);

  const openAttachments = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const startDictation = useCallback(() => {
    if (isCurrentConversationBusy || dictationStatus !== "idle") {
      return;
    }
    setDictationRequestSignal((prev) => prev + 1);
  }, [dictationStatus, isCurrentConversationBusy]);

  const { handleDictationSubmit, handleDictationStatusChange } = createVoiceDictationHandlers({
    userId,
    setCurrentMessage,
    setDictationStatus,
    textareaRef,
    toast: toastWrapper,
  });

  const { voiceSession, handleVoiceMode } = useChatVoiceMode({
    toast: toastWrapper,
    userId,
    selectedAgent,
    voiceModeVoice: resolvedPreferences.voiceModeVoice,
    voiceModeLanguage: resolvedPreferences.voiceModeLanguage,
  });
  const isEmptyConversation = (currentConversation?.messages?.length ?? 0) === 0;

  // Staged voice-mode transition (empty conversation only):
  //   forward (chat -> voice): chat-bar erases at center -> persona orb enters
  //     -> voice-bar appears at sticky-bottom.
  //   reverse (voice -> chat): voice-bar exits at sticky-bottom -> persona
  //     exits -> chat-bar appears at center.
  // In non-empty conversations everything switches in parallel (no staging)
  // since chat-bar and voice-bar share the sticky-bottom slot there.
  const [bodyShowsVoice, setBodyShowsVoice] = useState(voiceSession.isActive);
  const [voiceBarReady, setVoiceBarReady] = useState(voiceSession.isActive);
  const [chatBarReady, setChatBarReady] = useState(!voiceSession.isActive);
  // Drives positionClass. Lags voiceBarReady going *false* by the voice-bar exit
  // duration (~200 ms) so the voice-bar finishes its exit at sticky-bottom
  // instead of teleporting to the centered slot. Matches voiceBarReady going
  // true immediately so voice-bar mounts at the right place.
  const [positionAtBottom, setPositionAtBottom] = useState(voiceSession.isActive);
  useEffect(() => {
    if (voiceBarReady) {
      setPositionAtBottom(true);
      return;
    }
    const t = window.setTimeout(() => setPositionAtBottom(false), 200);
    return () => window.clearTimeout(t);
  }, [voiceBarReady]);
  // Track the previous voice-active value so we only run the staged transition
  // when voice mode is actually being entered or left. Without this guard,
  // navigating between conversations (e.g. clicking "new chat" while voice is
  // already off) would falsely trigger the reverse stage, causing the chat-bar
  // to unmount and re-mount with a visible flicker.
  const wasVoiceActiveRef = useRef(voiceSession.isActive);
  useEffect(() => {
    const prev = wasVoiceActiveRef.current;
    const next = voiceSession.isActive;
    wasVoiceActiveRef.current = next;

    if (next && !prev && isEmptyConversation) {
      setBodyShowsVoice(false);
      setVoiceBarReady(false);
      setChatBarReady(true);
      const personaIn = window.setTimeout(() => setBodyShowsVoice(true), 180);
      const barIn = window.setTimeout(() => setVoiceBarReady(true), 180 + 560);
      return () => {
        window.clearTimeout(personaIn);
        window.clearTimeout(barIn);
      };
    }

    if (!next && prev && isEmptyConversation) {
      setVoiceBarReady(false);
      setChatBarReady(false);
      const personaOut = window.setTimeout(() => setBodyShowsVoice(false), 180);
      const chatBarIn = window.setTimeout(() => setChatBarReady(true), 180 + 560);
      return () => {
        window.clearTimeout(personaOut);
        window.clearTimeout(chatBarIn);
      };
    }

    setBodyShowsVoice(next);
    setVoiceBarReady(next);
    setChatBarReady(true);
  }, [voiceSession.isActive, isEmptyConversation]);

  const activeBodyMode: ConversationBodyMode = bodyShowsVoice ? "voice" : "chat";
  const settledVoiceActive = positionAtBottom;
  const [bodyTransition, setBodyTransition] = useState<{
    current: ConversationBodyMode;
    exiting: ConversationBodyMode | null;
  }>(() => ({
    current: activeBodyMode,
    exiting: null,
  }));

  useEffect(() => {
    setBodyTransition((previous) => {
      if (previous.current === activeBodyMode) {
        return previous;
      }

      return {
        current: activeBodyMode,
        exiting: previous.current,
      };
    });
  }, [activeBodyMode]);

  useEffect(() => {
    if (!bodyTransition.exiting) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setBodyTransition((previous) => ({
        ...previous,
        exiting: null,
      }));
    }, 560);

    return () => window.clearTimeout(timeout);
  }, [bodyTransition.current, bodyTransition.exiting]);

  const cancelDictation = useCallback(() => {
    if (dictationStatus === "idle" || dictationStatus === "submitting") {
      return;
    }
    setDictationCancelSignal((prev) => prev + 1);
  }, [dictationStatus]);

  const openAgentPicker = useCallback(() => {
    setIsAgentPickerOpen((prevOpen) => {
      const nextOpen = !prevOpen;
      if (nextOpen) {
        requestAnimationFrame(() => {
          agentTriggerRef.current?.focus();
        });
      }
      return nextOpen;
    });
  }, []);

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
    enabledTools: enabledToolsForRequest,
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
  useSessionAutoRefreshEffect({ isLoggedIn, setIsLoggedIn, setUserId, setUserProfile, toast: toastWrapper });

  // Session state sync effect
  useSessionStateSyncEffect({ userId, selectedAgent, currentConversationId: currentConversation?.id || null, isPrivateMode });

  // Hydrate last conversation effect
  const hydratedConversationRef = useRef(false);
  useEffect(() => {
    if (!authResolved || !isLoggedIn || !userId || sharedConversationToken) {
      hydratedConversationRef.current = false;
      return;
    }
    if (hydratedConversationRef.current || currentConversation) return;
    const sessionData = loadSession();
    const lastConversationId = sessionData?.lastConversationId;
    if (!lastConversationId) {
      hydratedConversationRef.current = true;
      return;
    }
    let cancelled = false;
    hydratedConversationRef.current = true;
    setLoadingConversation(true);
    (async () => {
      try {
        const hydratedDetail = await getConversationDetail(userId, lastConversationId);
        if (cancelled) return;
        // Pin branch selections to the running message's path so a non-
        // default branch (e.g. retried message) doesn't hide the modal.
        const activeRunBranchSelections = deriveBranchSelectionsForActiveRun(hydratedDetail);
        setSelectedAgent(hydratedDetail.agent?.id || "");
        if (activeRunBranchSelections) {
          setBranchSelections(activeRunBranchSelections);
        }
        setCurrentConversation(hydratedDetail);
        setIsPrivateMode(hydratedDetail.isPrivate || false);
        requestPersist();
      } catch (error) {
        console.error('Failed to hydrate conversation', error);
      } finally {
        if (!cancelled) setLoadingConversation(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isLoggedIn, userId, currentConversation, setSelectedAgent, setCurrentConversation, setIsPrivateMode, requestPersist]);

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

  // Create attachment handlers
  const { handleFileUpload, handlePaste, removeAttachment, isImageFile, getImageUrl, handleFileDownload } = createAttachmentHandlers({
    attachments,
    setAttachments,
    toast: toastWrapper,
    userId,
    currentConversation,
  });

  // Create UI handlers
  const { handleCopy, handleImageClick, handleCloseImagePreview } = createUIHandlers({ toast: toastWrapper, setCopiedId, setSelectedImage });
  const { handleReadAloud, stopReadAloud } = createReadAloudHandlers({
    userId,
    conversationId: currentConversation?.id ?? null,
    setSpeakingMessageId,
    toast: toastWrapper,
  });

  useEffect(() => () => stopReadAloud(), []);

  const handleOpenFilePreview = useCallback((attachment: AttachmentLike, message: MessageOut) => {
    setSelectedFilePreview({ attachment, message });
  }, []);

  const handleCloseFilePreview = useCallback(() => {
    setSelectedFilePreview(null);
  }, []);

  const dismissActiveUi = useCallback(() => {
    return runActiveUiDismissal({
      isSearchOpen,
      selectedFilePreview,
      selectedImage,
      dictationStatus,
      isReportDialogOpen,
      shareTargetMessage,
      showUserProfile,
      isAgentPickerOpen,
      isHeaderActionMenuOpen,
      isSidebarFloatingUiOpen,
      editingMessageId,
      closeSearchPanel,
      handleCloseFilePreview,
      handleCloseImagePreview,
      cancelDictation,
      closeReportDialog,
      closeShareDialog,
      closeProfilePanel,
      handleCancelEditMessage,
      setIsAgentPickerOpen,
      setIsHeaderActionMenuOpen,
      setSidebarDismissFloatingUiSignal,
    });
  }, [
    cancelDictation,
    closeSearchPanel,
    closeReportDialog,
    closeShareDialog,
    closeProfilePanel,
    dictationStatus,
    editingMessageId,
    handleCancelEditMessage,
    handleCloseFilePreview,
    handleCloseImagePreview,
    isAgentPickerOpen,
    isHeaderActionMenuOpen,
    isReportDialogOpen,
    isSearchOpen,
    isSidebarFloatingUiOpen,
    selectedFilePreview,
    selectedImage,
    shareTargetMessage,
    showUserProfile,
  ]);

  // AI transition dot (between DB persistence and thinking start)
  useEffect(() => {
    if (thinkingState?.isActive) setShowAiTransition(false);
  }, [thinkingState?.isActive]);

  // Create AI transition handlers
  const { AiTransitionIndicator } = createAiTransitionHandlers({
    showAiTransition,
    thinkingState,
    activeBranchPath,
  });

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
    enabledTools: enabledToolsForRequest,
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
    isImageFile,
    getImageUrl,
    setThinkingState,
    setShowAiTransition,
    streamAbortRef,
    enabledTools: enabledToolsForRequest,
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
    handleStopStreaming: undefined,
    closeVoiceMode: voiceSession.close,
    agents,
    setInactiveAgentFallback,
    setLoadingConversation,
    setIsClearing,
    setSelectedAgent,
    setCurrentConversation,
    setBranchSelections,
    setIsPrivateMode,
    setExpandedThinking,
    setAttachments,
    setCurrentMessage,
    setThinkingState,
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
    deriveBranchSelectionsForActiveRun,
  });

  useEffect(() => {
    if (!isShareCopyPulse) return;
    const timeout = window.setTimeout(() => setIsShareCopyPulse(false), 1100);
    return () => window.clearTimeout(timeout);
  }, [isShareCopyPulse]);

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
    if (!showUserProfile || activeProfileTab !== "archived") {
      return;
    }

    void refreshArchivedConversations();
    void refreshSharedConversations();
  }, [activeProfileTab, showUserProfile, userId]);

  const handleOpenArchivedConversation = useCallback(async (conversation: ConversationSummary) => {
    closeProfilePanel();
    await handleConversationSelect(conversation);
  }, [closeProfilePanel, handleConversationSelect]);

  // Agent change handler
  const { handleAgentChange } = createAgentHandlers({
    setSelectedAgent,
    persistUIState: requestPersist,
  });

  const { handleSearchResultSelect } = createSearchResultHandlers({
    agents,
    onAgentSelect: handleAgentChange,
    onConversationSelect: (conversation) => void handleConversationSelect(conversation),
    onCloseSearch: closeSearchPanel,
  });
  const defaultSearchResults = buildDefaultConversationSearchResults(conversations);

  // Handle thinking toggle. `next` carries the explicit target state when the
  // block's default (absent from the record) is open — a bare flip of an
  // unset key would no-op visually on the first click.
  const toggleThinking = (messageId: string, next?: boolean) => {
    setExpandedThinking(prev => ({
      ...prev,
      [messageId]: next ?? !prev[messageId]
    }));
  };

  // Auth handler
  const { handleLogout } = createAuthHandlers({
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
  });

  // Unauthorized event listener
  useEffect(() => {
    const handleUnauthorized = () => {
      handleLogout();
      toast({
        title: 'Session expired',
        description: 'Please sign in again to continue.',
        variant: 'destructive',
        duration: 3000,
      });
    };
    window.addEventListener('mx:unauthorized', handleUnauthorized);
    return () => {
      window.removeEventListener('mx:unauthorized', handleUnauthorized);
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

  // Centered composer layout for input area
  const isMessagesEmpty = (currentConversation?.messages?.length ?? 0) === 0;
  const {
    containerRef: composerContainerRef,
    emptyWrapperStyle,
    textareaMaxHeight,
  } = useCenteredComposerLayout({
    isMessagesEmpty,
    textareaRef,
    currentMessage,
    attachmentsCount: attachments.length,
  });

  // Determine current agent and its icon
  const conversationAgent = currentConversation?.agent ?? null;
  const selectedAgentFromList = agents.find(a => a.id === selectedAgent) ?? null;
  const fallbackSelectedAgent = inactiveAgentFallback && inactiveAgentFallback.id === selectedAgent ? inactiveAgentFallback : null;
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
  const resolveMessageAgent = useCallback((message: MessageOut) => {
    if (message.agentId) {
      const found = agents.find(a => a.id === message.agentId);
      if (found) return { name: found.name, Icon: found.icon };
      if (message.agentName) return { name: message.agentName, Icon: Building2 };
    }
    return { name: currentAgent?.name ?? "Unknown agent", Icon: AgentIcon };
  }, [agents, currentAgent, AgentIcon]);
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
  const canShareCurrentConversation = Boolean(currentConversation?.id && !currentConversation.id.startsWith("shared:"));
  const canShareFullConversation = canShareCurrentConversation && activeMessages.some((message) => (
    message.sender === "ai" &&
    !String(message.id).startsWith("temp-") &&
    (Boolean(message.content?.trim()) || (message.attachments?.length ?? 0) > 0)
  ));
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

  const handleStarterSuggestionSelect = useCallback((suggestion: string) => {
    setCurrentMessage(suggestion);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

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
        loadingConversation={loadingConversation}
        isClearing={isClearing}
        expandedThinking={expandedThinking}
        isImageFile={isImageFile}
        onDownloadAttachment={handleFileDownload}
        onPreviewAttachment={handleOpenFilePreview}
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
        branchChildrenMap={branchChildrenMap}
        branchSelections={branchSelections}
        onSelectBranch={handleBranchSelectionChange}
        branchRootKey={ROOT_BRANCH_KEY}
        activeBranchPath={activeBranchPath}
        editingMessageId={editingMessageId}
        editingDraft={editingDraft}
        editingBusy={editingBusy}
        onRequestEdit={handleRequestEditMessage}
        onChangeEditDraft={handleEditDraftChange}
        onCancelEdit={handleCancelEditMessage}
        onSubmitEdit={submitEditFromState}
        toast={toastWrapper}
        onRetryMessage={handleRetryAiMessage}
        onForkMessage={handleForkConversation}
        onShareMessage={openShareDialog}
        onReadAloud={handleReadAloud}
        speakingMessageId={speakingMessageId}
        isStreaming={isCurrentConversationBusy}
        liveTimeline={activeConversationRun?.timeline ?? null}
        scrollResetKey={currentConversation?.id ?? null}
      />
    );
  };

  // Main Chat Interface
  if (!authResolved) {
    return (
      <div className="flex min-h-svh items-center justify-center bg-background">
        <Loader />
      </div>
    );
  }
  if (!isLoggedIn || !userId) {
    return null;
  }
  return (
    // Main chat interface with sidebar, header, conversation container, and input area
    <div className="min-h-svh max-h-svh bg-background dark:bg-gradient-to-br dark:from-slate-950/20 dark:via-slate-700/30 dark:to-slate-950/20">
      <SidebarProvider
        className="min-h-svh"
        open={sidebarOpen}
        onOpenChange={handleSidebarOpenChange}
        enableKeyboardShortcut={false}
        chatKeyboardShortcuts={{
          canTogglePrivateMode,
          openSearch: handleOpenSearch,
          focusComposer,
          openAttachments,
          startDictation,
          triggerVoiceMode: handleVoiceMode,
          openAgentPicker,
          togglePrivateMode: handleTogglePrivateMode,
          openProfilePanel,
          startNewChat: handleNewChat,
          dismissActiveUi,
        }}
      >
        <ChatSidebar
          conversations={conversations}
          currentConversationId={currentConversation?.id || null}
          onSelectConversation={handleConversationSelect}
          onDeleteConversation={handleDeleteConversation}
          onRenameConversation={handleRenameConversation}
          onArchiveConversation={handleArchiveConversation}
          onReportConversation={handleReportConversationFromSidebar}
          onLoadMore={handleLoadMoreConversations}
          onTitleClick={handleTitleClick}
          onNewChat={handleNewChat}
          onOpenSearch={handleOpenSearch}
          onVoiceMode={handleVoiceMode}
          onOpenUserProfile={() => openProfilePanel()}
          agents={agents}
          userProfile={userProfile}
          dismissFloatingUiSignal={sidebarDismissFloatingUiSignal}
          onFloatingUiStateChange={setIsSidebarFloatingUiOpen}
          isLoadingMore={convIsLoadingMore}
          isInitialLoading={conversationsLoading}
          hasMore={convHasMore}
          sidebarInteractionHook={useSidebarInteractionEffect}
        />
        <SearchPanel
          open={isSearchOpen}
          query={searchQuery}
          results={searchResults}
          defaultResults={defaultSearchResults}
          loading={searchLoading}
          error={searchError}
          onQueryChange={setSearchQuery}
          onClose={closeSearchPanel}
          onSelectResult={handleSearchResultSelect}
        />
        <SidebarInset className="bg-transparent">
          <TooltipProvider>
          <HitlProvider value={{ resumeRun: resumeInferenceRunHandler, isInterruptResolved }}>
            <div id={OVERLAY_HOST_ID} className="animate-fade-in flex min-h-svh max-h-svh flex-col relative overflow-hidden transition-slow">
              {/* Header */}
              <ChatHeader
                agents={agents}
                inactiveAgent={inactiveAgentFallback}
                selectedAgent={selectedAgent}
                onAgentChange={handleAgentChange}
                agentTriggerRef={agentTriggerRef}
                agentPickerOpen={isAgentPickerOpen}
                onAgentPickerOpenChange={setIsAgentPickerOpen}
                showPrivateToggle={(currentConversation?.messages?.length ?? 0) === 0 || isPrivateMode}
                isPrivateMode={isPrivateMode}
                onTogglePrivate={handleTogglePrivateMode}
                showBottomBorder={headerHasDivider}
                showConversationActions={Boolean(currentConversation?.id)}
                isConversationArchived={Boolean(currentConversation?.isArchived)}
                isConversationReported={Boolean(currentConversation?.isReported)}
                conversationActionsOpen={isHeaderActionMenuOpen}
                onConversationActionsOpenChange={setIsHeaderActionMenuOpen}
                onArchiveConversation={handleArchiveCurrentConversation}
                onUnarchiveConversation={handleUnarchiveCurrentConversation}
                onReportConversation={handleReportCurrentConversation}
                onDeleteConversation={handleDeleteCurrentConversation}
                onShareConversation={openFullConversationShareDialog}
                canShareConversation={canShareFullConversation}
                onNewChat={handleNewChat}
                isStreaming={isCurrentConversationBusy}
              />

              {/* Chat Messages Container*/}
              <div className="voice-chat-transition-shell relative flex flex-1 min-h-0 overflow-hidden">
                {bodyTransition.exiting ? (
                  <div
                    className={`voice-chat-panel voice-chat-panel-${bodyTransition.exiting} voice-chat-panel-exit`}
                    aria-hidden="true"
                  >
                    {renderConversationBody(bodyTransition.exiting)}
                  </div>
                ) : null}
                <div className={`voice-chat-panel voice-chat-panel-${bodyTransition.current} voice-chat-panel-enter`}>
                  {renderConversationBody(bodyTransition.current)}
                </div>
              </div>

              {/* Input Area */}
              <ChatInputBar
                mode={voiceSession.isActive ? "voice" : "chat"}
                voiceBarVisible={voiceBarReady}
                chatBarVisible={chatBarReady}
                // Centered empty state
                isMessagesEmpty={isMessagesEmpty}
                positionClass={
                  settledVoiceActive
                    ? "sticky bottom-0 left-0 right-0 z-30 p-6"
                    : isMessagesEmpty
                    ? "absolute left-1/2 top-[35%] z-40 w-full p-6"
                    : "sticky bottom-0 left-0 right-0 z-30 p-6"
                }

                // pass through your existing state/handlers/refs
                attachments={attachments}
                isPrivateMode={isPrivateMode}
                thinkingActive={isCurrentConversationBusy && thinkingState?.isActive}
                isStreaming={isCurrentConversationBusy}
                currentMessage={currentMessage}
                setCurrentMessage={setCurrentMessage}
                handlePaste={handlePaste}
                handleSendMessage={handleSendMessage}
                handleStopStreaming={handleStopStreaming}
                isImageFile={isImageFile}
                getImageUrl={getImageUrl}
                handleImageClick={handleImageClick}
                removeAttachment={removeAttachment}
                handleFileUpload={handleFileUpload}
                fileInputRef={fileInputRef}
                textareaRef={textareaRef}
                containerRef={composerContainerRef}
                emptyWrapperStyle={settledVoiceActive ? undefined : emptyWrapperStyle}
                textareaMaxHeight={textareaMaxHeight}
                onDictationSubmit={handleDictationSubmit}
                onDictationStatusChange={handleDictationStatusChange}
                dictationStatus={dictationStatus}
                dictationRequestSignal={dictationRequestSignal}
                dictationCancelSignal={dictationCancelSignal}
                onVoiceMode={handleVoiceMode}
                voiceStatus={voiceSession.status}
                voiceMuted={voiceSession.muted}
                onCloseVoiceMode={voiceSession.close}
                onToggleVoiceMute={voiceSession.toggleMute}
                onVoiceTextSubmit={voiceSession.sendText}

                // UI deps
                AgentIcon={AgentIcon}
                Tooltip={Tooltip}
                TooltipTrigger={TooltipTrigger}
                TooltipContent={TooltipContent}
                toast={toast}
                currentAgent={inputBarAgent ?? undefined}
                Textarea={Textarea}
                topAccessory={
                  showPlanningCard && activePlan ? (
                    <PlanCard
                      plan={activePlan}
                      expanded={isPlanExpanded}
                      onToggle={() => setIsPlanExpanded((prev) => !prev)}
                      title="Deep agent execution plan"
                      className="absolute bottom-[calc(100%-1px)] left-1/2 z-10 w-[min(100%,39rem)] -translate-x-1/2"
                    />
                  ) : null
                }
                hitlTakeover={
                  activeHitlInterrupt && activeConversationRun ? (
                    <HitlInputTakeover
                      interrupt={{
                        interruptId: activeHitlInterrupt.id,
                        threadId: activeHitlInterrupt.threadId,
                        content: activeHitlInterrupt.content,
                      }}
                      pendingCount={pendingRunInterrupts.length}
                      onResolve={(decisions) =>
                        resumeInferenceRunHandler(activeConversationRun.id, {
                          interruptId: activeHitlInterrupt.id,
                          threadId: activeHitlInterrupt.threadId,
                          // Overall decision (legacy/back-compat field): approve
                          // unless every action was rejected. Per-action outcomes
                          // ride in `decisions`.
                          decision: decisions.some((d) => d.decision === "approve") ? "approve" : "reject",
                          reason: decisions.find((d) => d.decision === "reject" && d.reason)?.reason,
                          decisions,
                        })
                      }
                    />
                  ) : null
                }
                starterSuggestions={canShowStarterSuggestions ? starterSuggestions : []}
                onStarterSuggestionSelect={handleStarterSuggestionSelect}
              />

            {loadingConversation && (
              <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-slate-950/35 backdrop-blur-md transition-opacity duration-200 animate-fade-in">
                <Loader size={36} className="text-white/90" />
              </div>
            )}

              {/* User Profile Modal */}
              <ProfilePanel
              open={showUserProfile}
                onClose={closeProfilePanel}
                activeTab={activeProfileTab}
                setActiveTab={handleSetActiveProfileTab}
                onLogout={handleLogout}
                user={userProfile}
                availableTools={toolsWithStatus}
                availableSkills={availableSkills}
                onRefreshSkills={handleRefreshSkills}
                mySkills={mySkills}
                loadingMySkills={loadingMySkills}
                mySkillDetails={mySkillDetails}
                isMySkillDetailLoading={loadingSkillDetail}
                onLoadMySkillDetail={ensureSkillDetail}
                onRefreshMySkills={handleRefreshMySkills}
                onAddGlobalSkillToPool={handleAddGlobalSkill}
                onCreateCustomSkill={handleCreateCustomSkill}
                onRemoveSkillFromPool={handleRemoveSkillFromPool}
                agents={agents}
                skillSelections={skillSelections}
                onLoadAgentSkills={loadAgentSkills}
                onToggleUserAgentSkill={toggleUserAgentSkill}
                isAgentSkillLoading={isAgentSkillLoading}
                isSkillToggling={isSkillToggling}
                userPreferences={resolvedPreferences}
                archivedConversations={archivedConversations}
                archivedConversationsLoading={archivedConvIsLoading}
                archivedConversationsHasMore={archivedConvHasMore}
                onLoadMoreArchivedConversations={handleLoadMoreArchivedConversations}
                onSelectArchivedConversation={handleOpenArchivedConversation}
                onUnarchiveConversation={(conversation) => void handleUnarchiveConversation(conversation.id)}
                sharedConversations={sharedConversations}
                sharedConversationsLoading={sharedConvIsLoading}
                sharedConversationsHasMore={sharedConvHasMore}
                onLoadMoreSharedConversations={handleLoadMoreSharedConversations}
                onSelectSharedConversation={handleOpenSharedConversation}
                onRevokeSharedConversation={handleRevokeSharedConversation}
                onToggleToolPreference={handleToggleToolPreference}
                onToggleSuggestionsEnabled={handleToggleSuggestionsEnabled}
                onSelectVoiceModeVoice={handleSelectVoiceModeVoice}
                onSelectVoiceModeLanguage={handleSelectVoiceModeLanguage}
                preferencesSaving={isSavingPreferences}
              />

              <ReportConversationDialog
                open={isReportDialogOpen}
                onClose={closeReportDialog}
                onSubmit={handleSubmitConversationReport}
                submitting={isSubmittingReport}
                messageId={reportTargetMessageId}
                messagePreview={reportTargetMessagePreview}
                conversationTitle={reportConversationTitle}
              />

              <ShareConversationDialog
                open={Boolean(shareTargetMessage)}
                title={currentConversation?.title}
                message={shareTargetMessage}
                creating={isCreatingShareLink}
                exportingPdf={isExportingSharePdf}
                linkCreated={Boolean(shareDialogUrl)}
                copied={isShareCopyPulse}
                shareMode={shareMode}
                forceFullConversation={shareForceFullConversation}
                expiresAt={shareExpiresAt}
                onShareModeChange={handleShareModeChange}
                onExpiresAtChange={handleShareExpiresAtChange}
                onClose={closeShareDialog}
                onCreateLink={shareDialogUrl ? copyShareDialogUrl : handleCreateShareLink}
                onDownloadPdf={handleDownloadSharePdf}
              />

              <AttachmentPreviewPanel
                preview={selectedFilePreview}
                userId={userId}
                conversationId={currentConversation?.id ?? null}
                onClose={handleCloseFilePreview}
                onDownload={handleFileDownload}
              />

              {/* Image Preview Modal */}
              {selectedImage && (
                <div
                  className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4"
                  onClick={handleCloseImagePreview}
                >
                  <div className="relative w-full h-full flex items-center justify-center">
                    <button
                      onClick={handleCloseImagePreview}
                      className="absolute top-4 right-4 z-10 text-white hover:text-gray-300 transition-colors bg-black/50 rounded-full p-2"
                    >
                      <X size={24} />
                    </button>
                    <img
                      src={selectedImage}
                      alt="Full preview"
                      className="max-w-[95vw] max-h-[95vh] w-auto h-auto object-contain rounded-lg shadow-2xl"
                      onClick={(e) => e.stopPropagation()}
                    />
                  </div>
                </div>
              )}
            </div>
          </HitlProvider>
          </TooltipProvider>
        </SidebarInset>
      </SidebarProvider>
    </div>
  );
}
