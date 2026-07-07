import { useState, useRef, useEffect, useCallback, useMemo, type ReactNode } from "react";
import { useNavigate, useParams, useLocation, Outlet } from "react-router-dom";
import { useReducedMotion } from "framer-motion";
import { TooltipProvider } from "@/shared/ui/tooltip";
import { Building2, X } from "lucide-react";
import { useToast } from "@/shared/hooks/use-toast";

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
  UserPreferences } from "@/shared/lib/types";
import { usePreferencesHandlers } from "@/handlers/preferences";
import { computeConversationUsage } from "@/shared/lib/utils";
import { useProfilePanel } from "@/hooks/useProfilePanel";
import { useMemories } from "@/hooks/useMemories";
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
  useUISnapshotPersistence,
} from "@/hooks/useSessionEffects";
import { useActiveRunBranchSnap } from "@/hooks/useActiveRunBranchSnap";
import { useWorkspaceStore } from "@/shared/stores/workspaceStore";
import ChatView from "./ChatView";

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
import { getConversationDetail, getSkills, getSuggestions } from "@/shared/lib/api";

// Chat Interface component
import ChatSidebar from "@/components/chat/ChatSidebar";
import AttachmentPreviewPanel, { type AttachmentPreviewTarget } from "@/components/chat/AttachmentPreviewPanel";
import { OVERLAY_HOST_ID } from "@/shared/lib/overlay-host";
import { SidebarProvider, SidebarInset } from "@/shared/ui/sidebar";
import ProfilePanel from "@/components/chat/ProfilePanel";
import ReportConversationDialog from "@/components/chat/ReportPanel";
import ShareConversationDialog from "@/components/chat/SharePanel";
import ChatBody from "@/components/chat/ChatBody";
import VoiceModeBody from "@/components/chat/VoiceModeBody";
import { type DictationStatus } from "@/components/chat/ChatInputBar";
import SearchPanel from "@/components/chat/SearchPanel";
import { useScheduledTasks } from "@/hooks/useScheduledTasks";
import { Loader } from "@/shared/ui/shadcn-io/loader";
import { clearUISnapshot } from "@/shared/lib/uiStateStorage";
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

// The entire chat-workspace body, extracted into a hook so the persistent
// shell (ChatShell) and the route views (ChatView/TasksView) can share one
// instance of all state/effects/handlers. It calls all hooks unconditionally
// and returns the full bundle; the shell does the auth gate + chrome render.
export function useChatWorkspace({
  sharedConversationToken,
  initialSharedConversation,
}: ChatInterfaceProps = {}) {
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
    setCurrentConversation, setSelectedAgent, setIsPrivateMode, setAgents,
    setAvailableTools, setAvailableSkills, setMyRegistrySkills, setUserPreferences,
    setIsSavingPreferences, setInactiveAgentFallback, setConversations,
    setConversationsLoading, setStarterSuggestions, setConvPage, setConvHasMore,
    setConvIsLoadingMore, setArchivedConversations, setArchivedConvPage,
    setArchivedConvHasMore, setArchivedConvIsLoading, setSharedConversations,
    setSharedConvPage, setSharedConvHasMore, setSharedConvIsLoading,
    setUserProfile, setIsLoggedIn, setUserId, setAuthResolved,
    setLoadingConversation, setActiveProfileTab, setSidebarOpen,
  } = useWorkspaceStore.getState();

  // ── View-local state ────────────────────────────────────────────────────
  const [currentMessage, setCurrentMessage] = useState('');
  const [attachments, setAttachments] = useState<File[]>([]);

  const CONV_PAGE_SIZE = 10;
  const ARCHIVED_CONV_PAGE_SIZE = 10;
  const SHARED_CONV_PAGE_SIZE = 10;

  // Thinking variables (will be changed)
  const [expandedThinking, setExpandedThinking] = useState<{[key: string]: boolean}>({});
  const [thinkingState, setThinkingState] = useState<ThinkingState | null>(null);
  const [showAiTransition, setShowAiTransition] = useState(false);

  // Boolean variables for navigation
  const [isSendingMessage, setIsSendingMessage] = useState(false);
  const [showUserProfile, setShowUserProfile] = useState(false);
  const { headerHasDivider, handleHeaderScrollState } = useHeaderDividerEffect();

  // UI components
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
  // The URL is the single source of truth for which view is shown:
  //   "/"               → empty new-chat state
  //   "/c/:id"          → that conversation
  //   "/tasks"          → the scheduled-tasks page
  // conversationId is undefined on "/" and "/tasks".
  const { conversationId } = useParams();
  const location = useLocation();
  const isTasksRoute = location.pathname === "/tasks";
  // Generation guard for the URL-driven conversation loader: every navigation
  // bumps it so a slower, superseded fetch drops its own result. This is what
  // makes switching conversations safe mid-animation (never blocked).
  const loadGenRef = useRef(0);

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
    toolsWithStatus,
    enabledToolsForRequest,
    resolvedPreferences,
    handleToggleToolPreference,
    handleToggleSuggestionsEnabled,
    handleToggleShowMessageTokenUsage,
    handleToggleSearchPastConvs,
    handleToggleUseMemory,
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

  // Per-conversation token usage for the input-bar usage panel (AI messages only).
  const conversationUsage = useMemo(() => computeConversationUsage(activeMessages), [activeMessages]);

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

  const reduceMotion = useReducedMotion();
  const { voiceSession, handleVoiceMode } = useChatVoiceMode({
    toast: toastWrapper,
    userId,
    selectedAgent,
    voiceModeVoice: resolvedPreferences.voiceModeVoice,
    voiceModeLanguage: resolvedPreferences.voiceModeLanguage,
  });
  const isEmptyConversation = (currentConversation?.messages?.length ?? 0) === 0;

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

  // ── URL-driven conversation loading ────────────────────────────────────
  // The route's :conversationId is the single source of truth. This one effect
  // replaces all previous load paths (the click-handler setTimeout
  // choreography AND the old "hydrate last conversation" effect). The
  // generation guard makes the latest navigation always win, so switching is
  // never blocked by an in-flight load or animation — the exact bug that
  // caused the earlier revert. There is intentionally NO "if (loading) return"
  // guard. currentConversation is read but deliberately omitted from deps so
  // navigating doesn't retrigger on every streamed message.
  useEffect(() => {
    if (!authResolved || !isLoggedIn || !userId || sharedConversationToken) return;
    const gen = ++loadGenRef.current;
    // Voice never survives a navigation between conversations/pages.
    voiceSession.close();

    if (!conversationId) {
      // "/" or "/tasks" → erase conversation-scoped state synchronously.
      setThinkingState(null);
      setExpandedThinking({});
      setAttachments([]);
      setCurrentMessage("");
      setInactiveAgentFallback(null);
      setCurrentConversation(null);
      setIsPrivateMode(false);
      setLoadingConversation(false);
      return;
    }

    // Already showing this conversation (e.g. just created / forked) → no refetch.
    if (currentConversation?.id === conversationId) return;

    setLoadingConversation(true);
    getConversationDetail(userId, conversationId)
      .then((detail) => {
        if (gen !== loadGenRef.current) return; // superseded by a newer navigation
        // Pin branch selections to the active run's path so a streaming /
        // HITL-paused message isn't hidden on a sibling branch.
        const activeRunBranchSelections = deriveBranchSelectionsForActiveRun(detail);
        setSelectedAgent(detail.agent?.id || "");
        if (activeRunBranchSelections) setBranchSelections(activeRunBranchSelections);
        setCurrentConversation(detail);
        setIsPrivateMode(detail.isPrivate || false);
        setInactiveAgentFallback(null);
        requestPersist();
      })
      .catch((error) => {
        if (gen !== loadGenRef.current) return;
        console.error("Failed to load conversation", error);
        toastWrapper({
          title: "Failed to load conversation",
          description: "There was an error loading the conversation. Please try again.",
          variant: "destructive",
          duration: 3000,
        });
      })
      .finally(() => {
        if (gen === loadGenRef.current) setLoadingConversation(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, authResolved, isLoggedIn, userId, sharedConversationToken]);

  // Promote a conversation created from the empty "/" state (first message
  // sent) into the URL so it is linkable and survives refresh. It must fire
  // ONLY when a conversation *newly appears* (null -> id) — i.e. a real
  // creation. Guarding on the previous id is what prevents the New-chat bounce:
  // clicking New chat on "/c/:id" navigates to "/", but on that render
  // currentConversation is still the old conversation (the reset commits next
  // render); without the null->id check this effect would see that stale id with
  // no :conversationId and immediately navigate back to "/c/:id".
  const lastConversationIdRef = useRef<string | null>(null);
  useEffect(() => {
    const id = currentConversation?.id ?? null;
    const wasEmpty = lastConversationIdRef.current === null;
    lastConversationIdRef.current = id;
    if (id && wasEmpty && !id.startsWith("shared:") && !conversationId && !isTasksRoute) {
      navigate("/c/" + id, { replace: true });
    }
  }, [currentConversation?.id, conversationId, isTasksRoute, navigate]);

  // Entering the tasks page tears down any live voice session. The load effect
  // only fires on :conversationId changes, and "/" ↔ "/tasks" keeps it null,
  // so voice is closed here for that transition.
  useEffect(() => {
    if (isTasksRoute) voiceSession.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTasksRoute]);

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
        showMessageTokenUsage={resolvedPreferences.showMessageTokenUsage === true}
        loadingConversation={loadingConversation}
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

  // The hook returns the full workspace bundle. The shell (below) does the auth
  // gate and renders the chrome; the route views consume slices of this.
  return {
    // auth / gate
    authResolved, isLoggedIn, userId,
    // store data
    currentConversation, selectedAgent, isPrivateMode, agents, availableTools,
    availableSkills, myRegistrySkills, userPreferences, isSavingPreferences,
    inactiveAgentFallback, conversations, conversationsLoading, starterSuggestions,
    convHasMore, convIsLoadingMore, archivedConversations, archivedConvIsLoading,
    archivedConvHasMore, sharedConversations, sharedConvIsLoading, sharedConvHasMore,
    userProfile, loadingConversation, activeProfileTab, sidebarOpen,
    // view-local state
    currentMessage, setCurrentMessage, attachments, thinkingState, showUserProfile,
    selectedImage, selectedFilePreview, isAgentPickerOpen, setIsAgentPickerOpen,
    isHeaderActionMenuOpen, setIsHeaderActionMenuOpen, setIsSidebarFloatingUiOpen,
    sidebarDismissFloatingUiSignal, isReportDialogOpen, shareDialogUrl,
    shareTargetMessage, shareMode, shareForceFullConversation, shareExpiresAt,
    isCreatingShareLink, isExportingSharePdf, isShareCopyPulse, reportTargetMessageId,
    reportTargetMessagePreview, reportConversationTitle, isSubmittingReport,
    isPlanExpanded, setIsPlanExpanded, bodyTransition, voiceBarReady, chatBarReady,
    dictationStatus, dictationRequestSignal, dictationCancelSignal,
    // refs
    agentTriggerRef, fileInputRef, textareaRef, composerContainerRef,
    // hook outputs / context
    headerHasDivider, navigate, isTasksRoute, reduceMotion, voiceSession, scheduledTasks,
    resumeInferenceRunHandler, isInterruptResolved, resolvedPreferences,
    enabledToolsForRequest, toolsWithStatus, toast, isSearchOpen, searchQuery,
    searchResults, searchLoading, searchError, setSearchQuery, closeSearchPanel,
    conversationUsage, activeConversationRun, pendingRunInterrupts, activeHitlInterrupt,
    // profile/skills
    skillSelections, loadAgentSkills, toggleUserAgentSkill, isAgentSkillLoading,
    isSkillToggling, mySkills, loadingMySkills, mySkillDetails, loadingSkillDetail,
    ensureSkillDetail, handleRefreshMySkills, handleAddGlobalSkill, handleCreateCustomSkill,
    handleRemoveSkillFromPool,
    memoryInspector,
    // derived
    AgentIcon, inputBarAgent, isMessagesEmpty, settledVoiceActive, isCurrentConversationBusy,
    activePlan, showPlanningCard, canShareFullConversation, canTogglePrivateMode,
    canShowStarterSuggestions, defaultSearchResults, emptyWrapperStyle, textareaMaxHeight,
    renderConversationBody,
    // handlers
    handleSidebarOpenChange, handleOpenSearch, focusComposer, openAttachments, startDictation,
    triggerVoiceMode, openAgentPicker, handleTogglePrivateMode, openProfilePanel,
    closeProfilePanel, handleNewChat, dismissActiveUi, handleConversationSelect,
    handleDeleteConversation, handleRenameConversation, handleArchiveConversation,
    handleReportConversationFromSidebar, handleLoadMoreConversations, handleTitleClick,
    handleSearchResultSelect, handleAgentChange, handleArchiveCurrentConversation,
    handleUnarchiveCurrentConversation, handleReportCurrentConversation,
    handleDeleteCurrentConversation, openFullConversationShareDialog,
    handleToggleShowMessageTokenUsage, handlePaste, handleSendMessage, handleStopStreaming,
    isImageFile, getImageUrl, handleImageClick, removeAttachment, handleFileUpload,
    handleDictationSubmit, handleDictationStatusChange, handleStarterSuggestionSelect,
    handleSetActiveProfileTab, handleLogout, handleRefreshSkills,
    handleLoadMoreArchivedConversations, handleOpenArchivedConversation,
    handleUnarchiveConversation, handleLoadMoreSharedConversations, handleOpenSharedConversation,
    handleRevokeSharedConversation, handleToggleToolPreference, handleToggleSuggestionsEnabled,
    handleToggleSearchPastConvs, handleToggleUseMemory, handleSelectVoiceModeVoice, handleSelectVoiceModeLanguage, closeReportDialog,
    handleSubmitConversationReport, handleShareModeChange, handleShareExpiresAtChange,
    closeShareDialog, copyShareDialogUrl, handleCreateShareLink, handleDownloadSharePdf,
    handleCloseFilePreview, handleFileDownload, handleCloseImagePreview,
  };
}

// The full workspace bundle type, inferred from the hook. Consumed by the route
// views via the store's useChatWorkspaceContext accessor.
export type ChatWorkspace = ReturnType<typeof useChatWorkspace>;

type ChatShellProps = ChatInterfaceProps & { children?: ReactNode };

/**
 * The persistent workspace shell — sidebar, search, profile/dialog modals, and
 * the chrome around the routed views. Builds the workspace once via
 * useChatWorkspace and provides it; renders `children` (the direct
 * shared-conversation path) or `<Outlet/>` (the layout-route children
 * ChatView/TasksView) in the content slot.
 */
export function ChatShell({ children, ...props }: ChatShellProps = {}) {
  const ws = useChatWorkspace(props);
  // Publish the per-render workspace bundle to the store so the route views can
  // read it via useChatWorkspaceContext. Set during render (before children
  // render) so views see the current-render value with no staleness; it is an
  // external-store write (useSyncExternalStore-safe), not a React setState.
  useWorkspaceStore.setState({ workspace: ws });
  const {
    authResolved, isLoggedIn, userId, sidebarOpen, handleSidebarOpenChange,
    canTogglePrivateMode, handleOpenSearch, focusComposer, openAttachments, startDictation,
    triggerVoiceMode, openAgentPicker, handleTogglePrivateMode, openProfilePanel, handleNewChat,
    dismissActiveUi, conversations, currentConversation, handleConversationSelect,
    handleDeleteConversation, handleRenameConversation, handleArchiveConversation,
    handleReportConversationFromSidebar, handleLoadMoreConversations, handleTitleClick,
    navigate, scheduledTasks, agents, userProfile, sidebarDismissFloatingUiSignal,
    setIsSidebarFloatingUiOpen, convIsLoadingMore, conversationsLoading, convHasMore,
    isSearchOpen, searchQuery, searchResults, defaultSearchResults, searchLoading, searchError,
    setSearchQuery, closeSearchPanel, handleSearchResultSelect, resumeInferenceRunHandler,
    isInterruptResolved, showUserProfile, closeProfilePanel, activeProfileTab,
    handleSetActiveProfileTab, handleLogout, toolsWithStatus, availableSkills, handleRefreshSkills,
    mySkills, loadingMySkills, mySkillDetails, loadingSkillDetail, ensureSkillDetail,
    handleRefreshMySkills, handleAddGlobalSkill, handleCreateCustomSkill, handleRemoveSkillFromPool,
    skillSelections, loadAgentSkills, toggleUserAgentSkill, isAgentSkillLoading, isSkillToggling,
    memoryInspector,
    resolvedPreferences, archivedConversations, archivedConvIsLoading, archivedConvHasMore,
    handleLoadMoreArchivedConversations, handleOpenArchivedConversation, handleUnarchiveConversation,
    sharedConversations, sharedConvIsLoading, sharedConvHasMore, handleLoadMoreSharedConversations,
    handleOpenSharedConversation, handleRevokeSharedConversation, handleToggleToolPreference,
    handleToggleSuggestionsEnabled, handleToggleShowMessageTokenUsage, handleToggleSearchPastConvs,
    handleToggleUseMemory, handleSelectVoiceModeVoice,
    handleSelectVoiceModeLanguage, isSavingPreferences, isReportDialogOpen, closeReportDialog,
    handleSubmitConversationReport, isSubmittingReport, reportTargetMessageId,
    reportTargetMessagePreview, reportConversationTitle, shareTargetMessage, isCreatingShareLink,
    isExportingSharePdf, shareDialogUrl, isShareCopyPulse, shareMode, shareForceFullConversation,
    shareExpiresAt, handleShareModeChange, handleShareExpiresAtChange, closeShareDialog,
    copyShareDialogUrl, handleCreateShareLink, handleDownloadSharePdf, selectedFilePreview,
    handleCloseFilePreview, handleFileDownload, selectedImage, handleCloseImagePreview,
  } = ws;
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
          triggerVoiceMode,
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
          onVoiceMode={triggerVoiceMode}
          onOpenScheduledTasks={() => navigate("/tasks")}
          scheduledTasksRunningCount={scheduledTasks.runningCount}
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
              {/* The routed view: ChatView ("/", "/c/:id") or TasksView ("/tasks"),
                  or `children` when ChatShell is used directly (shared conversation).
                  The chat surface + tasks page now live in pages/ChatView and
                  pages/TasksView. */}
              {children ?? <Outlet />}

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
                memoryInspector={memoryInspector}
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
                onToggleMessageTokenUsage={handleToggleShowMessageTokenUsage}
                onToggleSearchPastConvs={handleToggleSearchPastConvs}
                onToggleUseMemory={handleToggleUseMemory}
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

/**
 * Full standalone workspace = the shell wrapping ChatView directly (no router
 * Outlet). Used by SharedConvPage to render a full shared conversation as a
 * single component with props. The routed app uses ChatShell + <Outlet/> instead.
 */
export function ChatInterface(props: ChatInterfaceProps = {}) {
  return (
    <ChatShell {...props}>
      <ChatView />
    </ChatShell>
  );
}
