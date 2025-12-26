import { useState, useRef, useEffect, useCallback } from "react";
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
  UserProfile,
  ToolMetadata,
  UserPreferences } from "@/lib/types";
import { createPreferencesHandlers } from "@/components/handlers/preferences";

// Handlers (modularized)
import { 
  createAttachmentHandlers,
  createInferenceHandlers,
  createConversationHandlers,
  createAgentHandlers,
  createAuthHandlers,
  useThinkingProgressEffect,
  useAutoScrollEffect,
  useEnsureDefaultAgentEffect,
  useAuthRehydrateEffect,
  useSessionAutoRefreshEffect,
  useSessionStateSyncEffect,
  useInitialSessionState,
  useUISnapshotPersistence,
  createUIHandlers,
  createAiTransitionHandlers,
  createStickyUserBarHandlers,
  createFeedbackHandlers,
  createMessageEditHandlers,
  createRetryHandlers,
  useBranchingHandlers,
  useHeaderDividerEffect,
  useCenteredComposerLayout,
  useSidebarInteractionEffect
} from "@/components/handlers";
import { loadSession } from "@/lib/authStorage";
import { getConversationDetail } from "@/lib/api";

// Chat Interface component
import ChatHeader from "@/components/chat/ChatHeader";
import ChatSidebar from "@/components/chat/ChatSidebar";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import ProfilePanel from "@/components/chat/ProfilePanel";
import ChatBody from "@/components/chat/ChatBody";
import { ChatInputBar, type DictationStatus } from "@/components/chat/ChatInputBar";
import { Loader } from "@/components/ui/shadcn-io/loader";
import { clearUISnapshot } from "@/lib/uiStateStorage";

const ROOT_BRANCH_KEY = "__root__";


export function ChatInterface() {
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
  const [userPreferences, setUserPreferences] = useState<UserPreferences | null>(null);
  const [isSavingPreferences, setIsSavingPreferences] = useState(false);
  const [inactiveAgentFallback, setInactiveAgentFallback] = useState<Agent | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState<boolean>(false);
  
  // Conversation list pagination state (persist across sidebar open/close)
  const [convPage, setConvPage] = useState<number>(1);
  const [convHasMore, setConvHasMore] = useState<boolean>(true);
  const [convIsLoadingMore, setConvIsLoadingMore] = useState<boolean>(false);
  const CONV_PAGE_SIZE = 10;
  
  // Thinking variables (will be changed)
  const [expandedThinking, setExpandedThinking] = useState<{[key: string]: boolean}>({});
  const [thinkingState, setThinkingState] = useState<ThinkingState | null>(null);
  
  const [userProfile, setUserProfile] = useState<UserProfile | null>(initialUserProfile);
  // Login and authentication variables
  const [isLoggedIn, setIsLoggedIn] = useState<boolean>(initialLoggedIn);
  const [userId, setUserId] = useState<string | null>(initialUserId);
  
  // Boolean variables for navigation
  const [isClearing, setIsClearing] = useState(false);
  const [isAgentSwitching, setIsAgentSwitching] = useState(false);
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
  const { toast } = useToast();
  
  // Copy to clipboard state
  const [copiedId, setCopiedId] = useState<string | null>(null);
  
  // Image preview
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  
  // Sticky user action bar
  const [stickyUserBarId, setStickyUserBarId] = useState<string | null>(null);
  const { flashUserActionBar } = createStickyUserBarHandlers({ setStickyUserBarId });

  // Branch selections (parentId -> child index)
  const [branchSelections, setBranchSelections] = useState<Record<string, number>>({});

  // Message editing state
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState("");
  const [editingBusy, setEditingBusy] = useState(false);
  const navigate = useNavigate();

  // Create toast wrapper for handlers
  const toastWrapper = (opts: { title: string; description?: string; variant?: string; duration?: number }) => {
    toast({
      title: opts.title,
      description: opts.description,
      variant: (opts.variant === 'error' ? 'destructive' : opts.variant) as 'default' | 'destructive' | undefined,
      duration: opts.duration,
    });
  };

  const { requestPersist } = useUISnapshotPersistence({
    userId,
    selectedAgent,
    isPrivateMode,
    sidebarOpen,
    activeProfileTab,
    currentConversationId: currentConversation?.id ?? null,
    availableTools,
    agents,
    conversations,
    userPreferences,
  });

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
  } = createPreferencesHandlers({
    userId,
    availableTools,
    userPreferences,
    setUserPreferences,
    isSavingPreferences,
    setIsSavingPreferences,
    toast: toastWrapper,
    persistUIState: requestPersist,
  });

  // Reset branch selections on conversation change
  useEffect(() => {
    setBranchSelections({});
  }, [currentConversation?.id]);

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

  // Dictation state machine
  const [dictationStatus, setDictationStatus] = useState<DictationStatus>("idle");

  // Function to set conversation messages
  const setConversationMessages = (updater: MessageOut[] | ((prev: MessageOut[]) => MessageOut[])) => {
    setCurrentConversation(prev => {
      const prevMessages = prev?.messages ?? [];
      const nextMessages = typeof updater === 'function'
        ? (updater as (prev: MessageOut[]) => MessageOut[])(prevMessages)
        : updater;
      if (prev) {
        return { ...prev, messages: nextMessages };
      }
      if (nextMessages.length === 0) return prev;
      const agentMeta = agents.find(a => a.id === selectedAgent);
      const now = new Date();
      return {
        id: '',
        agent: agentMeta ?? {
          id: selectedAgent,
          name: agentMeta?.name || 'Unknown agent',
          description: agentMeta?.description ?? '',
          icon: agentMeta?.icon ?? Building2,
          version: agentMeta?.version,
          isActive: agentMeta?.isActive ?? true,
        },
        title: '',
        isPrivate: isPrivateMode,
        created_at: now,
        updated_at: now,
        messages: nextMessages,
      } as ConversationDetail;
    });
  };

  // Message editing handlers
  const handleEditDraftChange = (value: string) => {
    setEditingDraft(value);
  };

  // Request to edit a message
  const handleRequestEditMessage = (message: MessageOut) => {
    if (message.sender !== "user") return;
    setEditingMessageId(message.id);
    setEditingDraft(message.content ?? "");
    setEditingBusy(false);
    setStickyUserBarId(message.id);
  };

  // Cancel editing a message
  const handleCancelEditMessage = () => {
    setEditingMessageId(null);
    setEditingDraft("");
    setEditingBusy(false);
    setStickyUserBarId(null);
  };

  // Effects
  useEnsureDefaultAgentEffect({
    isLoggedIn,
    userId,
    agents,
    selectedAgent,
    setSelectedAgent,
    allowMissingAgentId: inactiveAgentFallback?.id ?? currentConversation?.agent?.id ?? null,
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

  // Auto-scroll effect
  useAutoScrollEffect(currentConversation?.messages ?? [], thinkingState, messagesEndRef, isSendingMessage);

  // Thinking progress effect
  useThinkingProgressEffect({ thinkingState, setThinkingState, agents, selectedAgent, setMessages: setConversationMessages });

  // Session auto-refresh effect
  useSessionAutoRefreshEffect({ isLoggedIn, setIsLoggedIn, setUserId, setUserProfile, toast: toastWrapper });

  // Session state sync effect
  useSessionStateSyncEffect({ userId, selectedAgent, currentConversationId: currentConversation?.id || null, isPrivateMode });

  // Hydrate last conversation effect
  const hydratedConversationRef = useRef(false);
  useEffect(() => {
    if (!isLoggedIn || !userId) {
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
        const detail = await getConversationDetail(userId, lastConversationId);
        if (cancelled) return;
        setSelectedAgent(detail.agent?.id || "");
        setCurrentConversation(detail);
        setIsPrivateMode(detail.isPrivate || false);
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
    setAgents,
    setAvailableTools,
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
  
  // AI transition dot (between DB persistence and thinking start)
  const [showAiTransition, setShowAiTransition] = useState(false);
  useEffect(() => {
    if (thinkingState?.isActive) setShowAiTransition(false);
  }, [thinkingState?.isActive]);
  
  // Create AI transition handlers
  const { AiTransitionIndicator } = createAiTransitionHandlers({
    showAiTransition,
    thinkingState,
    activeBranchPath,
  });

  // Abort controller for streaming
  const streamAbortRef = useRef<AbortController | null>(null);

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
    persistUIState: requestPersist,
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
    persistUIState: requestPersist,
  });

  // Submit edit from state
  const submitEditFromState = () =>
    handleConfirmEditMessage({
      editingMessageId,
      editingDraft,
      setEditingMessageId,
      setEditingDraft,
      setEditingBusy,
    });

  // Inference handler
  const { handleSendMessage, handleStopStreaming, handleDictationSubmit, handleDictationStatusChange } = createInferenceHandlers({
    userId,
    selectedAgent,
    isPrivateMode,
    messages: activeMessages,
    attachments,
    agents,
    currentConversation,
    currentMessage,
    isSendingMessage,
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
    setDictationStatus,
    textareaRef,
    streamAbortRef,
    enabledTools: enabledToolsForRequest,
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
    handleReportConversation,
    handleRenameCurrentConversation,
    handleArchiveCurrentConversation,
    handleReportCurrentConversation,
    handleOpenSearch,
  } = createConversationHandlers({
    userId,
    conversations,
    setConversations,
    currentConversation,
    handleStopStreaming,
    agents,
    setInactiveAgentFallback,
    setLoadingConversation,
    setIsClearing,
    setSelectedAgent,
    setCurrentConversation,
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
    persistUIState: requestPersist,
  });
  
  // Agent change handler
  const { handleAgentChange } = createAgentHandlers({
    isAgentSwitching,
    setIsAgentSwitching,
    setSelectedAgent,
    clearChatAndStopThinking,
    persistUIState: requestPersist,
  });
  
  // Handle thinking toggle
  const toggleThinking = (messageId: string) => {
    setExpandedThinking(prev => ({
      ...prev,
      [messageId]: !prev[messageId]
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
    if (!isLoggedIn || !userId) {
      navigate("/login", { replace: true });
    }
  }, [isLoggedIn, userId, navigate]);
  
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
  const fallbackSelectedAgent =
    inactiveAgentFallback && inactiveAgentFallback.id === selectedAgent ? inactiveAgentFallback : null;
  const effectiveSelectedAgent = selectedAgentFromList ?? fallbackSelectedAgent ?? null;
  const currentAgent = conversationAgent ?? effectiveSelectedAgent ?? null;
  const AgentIcon = currentAgent?.icon || Building2;
  
  // Main Chat Interface
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
      >
        <ChatSidebar
          conversations={conversations}
          currentConversationId={currentConversation?.id || null}
          onSelectConversation={handleConversationSelect}
          onDeleteConversation={handleDeleteConversation}
          onRenameConversation={handleRenameConversation}
          onArchiveConversation={handleArchiveConversation}
          onReportConversation={handleReportConversation}
          onLoadMore={handleLoadMoreConversations}
          onTitleClick={handleTitleClick}
          onNewChat={handleNewChat}
          onOpenSearch={handleOpenSearch}
          onOpenUserProfile={() => setShowUserProfile(true)}
          agents={agents}
          userProfile={userProfile}
          isLoadingMore={convIsLoadingMore}
          isInitialLoading={conversationsLoading}
          hasMore={convHasMore}
          sidebarInteractionHook={useSidebarInteractionEffect}
        />
        <SidebarInset className="bg-transparent">
          <TooltipProvider>
            <div className="animate-fade-in flex min-h-svh max-h-svh flex-col relative overflow-hidden transition-slow">
              {/* Header */}
              <ChatHeader
                agents={agents}
                inactiveAgent={inactiveAgentFallback}
                selectedAgent={selectedAgent}
                onAgentChange={handleAgentChange}
                showPrivateToggle={(currentConversation?.messages?.length ?? 0) === 0 || isPrivateMode}
                isPrivateMode={isPrivateMode}
                onTogglePrivate={handleTogglePrivateMode}
                showBottomBorder={headerHasDivider}
                showConversationActions={Boolean(currentConversation?.id)}
                onArchiveConversation={handleArchiveCurrentConversation}
                onReportConversation={handleReportCurrentConversation}
                onDeleteConversation={handleDeleteCurrentConversation}
              />
            
              {/* Chat Messages Container*/}
              <div className="flex flex-1 min-h-0 overflow-hidden">
                <ChatBody
                  messages={activeMessages}
                  loadingConversation={loadingConversation}
                  isClearing={isClearing}
                  expandedThinking={expandedThinking}
                  isImageFile={isImageFile}
                  onDownloadAttachment={handleFileDownload}
                  onImageClick={handleImageClick}
                  onToggleThinking={toggleThinking}
                  copiedId={copiedId}
                  onCopy={handleCopy}
                  onLike={handleLike}
                  onDislike={handleDislike}
                  stickyUserBarId={stickyUserBarId}
                  onFlashUserActionBar={flashUserActionBar}
                  AiTransitionIndicator={AiTransitionIndicator}
                  thinkingState={thinkingState}
                  messagesEndRef={messagesEndRef}
                  AgentIcon={AgentIcon}
                  currentAgent={currentAgent ?? undefined}
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
                  isStreaming={isSendingMessage}
                />
              </div>
            
              {/* Input Area */}
              <ChatInputBar
                // Centered empty state
                isMessagesEmpty={isMessagesEmpty}
                positionClass={
                  isMessagesEmpty
                    ? "absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 transform z-40 w-full p-6"
                    : "sticky bottom-0 left-0 right-0 z-30 p-6"
                }
                
                // pass through your existing state/handlers/refs
                attachments={attachments}
                isPrivateMode={isPrivateMode}
                thinkingActive={thinkingState?.isActive}
                isStreaming={isSendingMessage}
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
                emptyWrapperStyle={emptyWrapperStyle}
                textareaMaxHeight={textareaMaxHeight}
                onDictationSubmit={handleDictationSubmit}
                onDictationStatusChange={handleDictationStatusChange}
                dictationStatus={dictationStatus}
                
                // UI deps
                AgentIcon={AgentIcon}
                Tooltip={Tooltip}
                TooltipTrigger={TooltipTrigger}
                TooltipContent={TooltipContent}
                toast={toast}
                currentAgent={currentAgent ?? undefined}
                Textarea={Textarea}
              />

            {loadingConversation && (
              <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-slate-950/35 backdrop-blur-md transition-opacity duration-200 animate-fade-in">
                <Loader size={36} className="text-white/90" />
              </div>
            )}

              {/* User Profile Modal */}
              <ProfilePanel
              open={showUserProfile}
                onClose={() => setShowUserProfile(false)}
                activeTab={activeProfileTab}
                setActiveTab={handleSetActiveProfileTab}
                onLogout={handleLogout}
                user={userProfile}
                availableTools={toolsWithStatus}
                userPreferences={resolvedPreferences}
                onToggleToolPreference={handleToggleToolPreference}
                preferencesSaving={isSavingPreferences}
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
          </TooltipProvider>
        </SidebarInset>
      </SidebarProvider>
    </div>
  );
}
