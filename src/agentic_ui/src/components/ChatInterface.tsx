import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Send, Paperclip, Building2, X } from "lucide-react";
import { VscMicFilled } from "react-icons/vsc";
import { FaStop } from "react-icons/fa6";
import { useToast } from "@/hooks/use-toast";

// Import types for messages, thinking state, conversations, and agents
import type { ThinkingState, Agent, MessageOut, ConversationDetail, ConversationSummary, UserProfile } from "@/lib/types";

// Handlers (modularized)
import { 
  createAttachmentHandlers,
  createDownloadHandlers,
  createInferenceHandlers,
  createConversationHandlers,
  createAgentHandlers,
  createAuthHandlers,
  useThinkingProgressEffect,
  useAutoScrollEffect,
  useEnsureDefaultAgentEffect,
  useAuthRehydrateEffect,
  useSessionStateSyncEffect,
  useUIPersistEffect,
  createUIHandlers,
  createAiTransitionHandlers,
  createStickyUserBarHandlers,
  createFeedbackHandlers
} from "@/components/handlers";
import { loadSession, isSessionValid } from "@/lib/authStorage";

// Chat Interface component
import LoginPanel from "@/components/layouts/LoginPanel";
import Header from "@/components/layouts/Header";
import AppSidebar from "@/components/layouts/Sidebar";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import UserProfilePanel from "@/components/layouts/UserProfilePanel";
import ConversationContainer from "@/components/layouts/ConversationContainer";
import { InputContainer } from "@/components/layouts/InputContainer";


export function ChatInterface() {
  // Initial session check
  const initialSession = typeof window !== 'undefined' ? loadSession() : null;
  const hasValidSession = isSessionValid(initialSession);
  const initialUserId = hasValidSession ? initialSession!.userId : null;
  const initialUserProfile = hasValidSession ? initialSession!.user ?? null : null;
  const initialLoggedIn = Boolean(initialUserId);
  
  // Main state variables
  const [currentConversation, setCurrentConversation] = useState<ConversationDetail | null>(null);
  const [currentMessage, setCurrentMessage] = useState('');
  const [attachments, setAttachments] = useState<File[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string>('');
  const [isPrivateMode, setIsPrivateMode] = useState(false);
  
  // Main variables use for storing info from the db and present it constantly
  const [agents, setAgents] = useState<Agent[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  
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
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  
  // Boolean variables for navigation
  const [isClearing, setIsClearing] = useState(false);
  const [isAgentSwitching, setIsAgentSwitching] = useState(false);
  const [isSendingMessage, setIsSendingMessage] = useState(false);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [showUserProfile, setShowUserProfile] = useState(false);
  
  // UI components
  const [activeProfileTab, setActiveProfileTab] = useState('profile');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { toast } = useToast();
  
  // Copy to clipboard state
  const [copiedId, setCopiedId] = useState<string | null>(null);
  
  // Image preview
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  
  // Sticky user bar
  const [stickyUserBarId, setStickyUserBarId] = useState<string | null>(null);
  const { flashUserActionBar } = createStickyUserBarHandlers({ setStickyUserBarId });

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
        agentId: selectedAgent,
        agentName: agentMeta?.name || '',
        title: '',
        isPrivate: isPrivateMode,
        created_at: now,
        updated_at: now,
        messages: nextMessages,
      } as ConversationDetail;
    });
  };

  // Create toast wrapper for handlers
  const toastWrapper = (opts: { title: string; description?: string; variant?: string; duration?: number }) => {
    toast({
      title: opts.title,
      description: opts.description,
      variant: (opts.variant === 'error' ? 'destructive' : opts.variant) as 'default' | 'destructive' | undefined,
      duration: opts.duration,
    });
  };
  
  // Effects moved to handlers
  useEnsureDefaultAgentEffect({ isLoggedIn, userId, agents, selectedAgent, setSelectedAgent });
  useAutoScrollEffect(currentConversation?.messages ?? [], thinkingState, messagesEndRef, isSendingMessage);
  useThinkingProgressEffect({ thinkingState, setThinkingState, agents, selectedAgent, setMessages: setConversationMessages });
  useAuthRehydrateEffect({ setIsLoggedIn, setUserId, setUserProfile, setAgents, setConversations, setSelectedAgent, setCurrentConversation, setMessages: setConversationMessages, setIsPrivateMode, toast: toastWrapper });
  useSessionStateSyncEffect({ userId, selectedAgent, currentConversationId: currentConversation?.id || null, isPrivateMode });
  useUIPersistEffect({
    userId,
    snapshot: {
      version: 1,
      selectedAgent,
      isPrivateMode,
      sidebarOpen: false,
      currentMessage,
      expandedThinking,
      thinkingState,
      activeProfileTab,
      selectedImage,
      currentConversation: currentConversation
        ? {
            ...currentConversation,
            created_at: currentConversation.created_at ? currentConversation.created_at.toISOString() : null,
            updated_at: currentConversation.updated_at ? currentConversation.updated_at.toISOString() : null,
          }
        : null,
      messages: (currentConversation?.messages ?? []).map(m => ({
        ...m,
        created_at: m.created_at.toISOString(),
        updated_at: m.updated_at.toISOString(),
      })),
      attachmentsRefs: [], // will be filled by storage layer
    },
    attachments,
  });
  
  // Handlers from modules
  const { handleFileUpload, handlePaste, removeAttachment, isImageFile, getImageUrl } = createAttachmentHandlers({ attachments, setAttachments, toast: toastWrapper });
  const { handleFileDownload } = createDownloadHandlers({ userId, currentConversation, toast: toastWrapper });
  
  
  // UI Handlers (clipboard, etc.)
  const { handleCopy, handleImageClick, handleCloseImagePreview } = createUIHandlers({ toast: toastWrapper, setCopiedId, setSelectedImage });
  
  // AI transition dot (between DB persistence and thinking start)
  const [showAiTransition, setShowAiTransition] = useState(false);
  useEffect(() => {
    if (thinkingState?.isActive) setShowAiTransition(false);
  }, [thinkingState?.isActive]);
  
  const { AiTransitionIndicator } = createAiTransitionHandlers({ showAiTransition, thinkingState });
  
  // Conversations and agent handlers
  const streamAbortRef = useRef<AbortController | null>(null);

  const {
    handleConversationSelect,
    handleDeleteConversation,
    handleNewChat,
    handleTitleClick,
    handleLoadMoreConversations,
    clearChatAndStopThinking,
  } = createConversationHandlers({
    userId,
    conversations,
    setConversations,
    currentConversation,
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
  });
  
  const { handleAgentChange } = createAgentHandlers({
    isAgentSwitching,
    setIsAgentSwitching,
    setSelectedAgent,
    clearChatAndStopThinking,
  });
  
  // Handle thinking toggle
  const toggleThinking = (messageId: string) => {
    setExpandedThinking(prev => ({
      ...prev,
      [messageId]: !prev[messageId]
    }));
  };
  
  // Auth handler
  const { handleLogin, handleLogout } = createAuthHandlers({
    setIsLoggedIn,
    setUserId,
    setUserProfile,
    setAgents,
    setConversations,
    setLoginUsername,
    setLoginPassword,
    setShowUserProfile,
    clearChatAndStopThinking,
    toast: toastWrapper,
    loginUsername,
    loginPassword,
  });

  // Feedback handlers
  const { handleLike, handleDislike } = createFeedbackHandlers({
    userId,
    currentConversation,
    setConversationMessages,
  });

  // Inference handler (send message)
  const { handleSendMessage, handleStopStreaming } = createInferenceHandlers({
    userId,
    selectedAgent,
    isPrivateMode,
    messages: currentConversation?.messages ?? [],
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
    streamAbortRef,
  });
  
  const currentAgent = agents.find(a => a.id === selectedAgent);
  const AgentIcon = currentAgent?.icon || Building2;
  
  // Show login panel if not logged in
  if (!isLoggedIn || !userId) {
    return (
      <LoginPanel
        username={loginUsername}
        password={loginPassword}
        onUsernameChange={setLoginUsername}
        onPasswordChange={setLoginPassword}
        onSubmit={handleLogin}
      />
    );
  }
  return (
    <SidebarProvider>
      <AppSidebar
        conversations={conversations}
        currentConversationId={currentConversation?.id || null}
        onSelectConversation={handleConversationSelect}
        onDeleteConversation={handleDeleteConversation}
        onLoadMore={handleLoadMoreConversations}
        onTitleClick={handleTitleClick}
        onNewChat={handleNewChat}
        onOpenUserProfile={() => setShowUserProfile(true)}
        agents={agents}
        userProfile={userProfile}
        isLoadingMore={convIsLoadingMore}
        hasMore={convHasMore}
      />
      <SidebarInset>
        <TooltipProvider>
          <div className={`animate-fade-in flex min-h-svh max-h-svh flex-col bg-gradient-to-br from-slate-950/20 via-slate-700/30 to-slate-950/20 relative overflow-hidden transition-slow ${isClearing || isAgentSwitching ? 'opacity-60' : 'opacity-100'}`}>
            {/* Header */}
            <Header
              agents={agents}
              selectedAgent={selectedAgent}
              onAgentChange={handleAgentChange}
              showPrivateToggle={(currentConversation?.messages?.length ?? 0) === 0 || isPrivateMode}
              isPrivateMode={isPrivateMode}
              onTogglePrivate={() => {
                if ((currentConversation?.messages?.length ?? 0) === 0 || !isPrivateMode) {
                  setIsPrivateMode(!isPrivateMode);
                }
              }}
            />

            {/* Chat Messages Container*/}
            <div className="flex flex-1 min-h-0 overflow-hidden">
              <ConversationContainer
              messages={currentConversation?.messages ?? []}
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
              currentAgent={currentAgent}
            />
            </div>

            {/* Input Area */}
            <InputContainer
              // Centered empty state
              isMessagesEmpty={(currentConversation?.messages?.length ?? 0) === 0}
              positionClass={
                (currentConversation?.messages?.length ?? 0) === 0
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

              // UI deps
              AgentIcon={AgentIcon}
              Tooltip={Tooltip}
              TooltipTrigger={TooltipTrigger}
              TooltipContent={TooltipContent}
              Paperclip={Paperclip}
              Mic={VscMicFilled}
              Button={Button}
              Send={Send}
              Stop={FaStop}
              X={X}
              toast={toast}
              currentAgent={currentAgent}
              Textarea={Textarea}
            />

            {/* User Profile Modal */}
            <UserProfilePanel
              open={showUserProfile}
              onClose={() => setShowUserProfile(false)}
              activeTab={activeProfileTab}
              setActiveTab={setActiveProfileTab}
              onLogout={handleLogout}
              user={userProfile}
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
  );
}

