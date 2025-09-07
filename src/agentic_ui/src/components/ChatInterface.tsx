import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/utils/button";
import { Textarea } from "@/components/utils/textarea";
import { Card } from "@/components/utils/card";
import { ScrollArea } from "@/components/utils/scroll-area";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/utils/tooltip";
import { MarkdownRenderer } from "@/components/utils/MarkdownRenderer";
import ThinkingList from "@/components/utils/ThinkingList";
import { Send, Paperclip, Mic, Building2, ChevronDown, ChevronRight, X, Download, FileText, Check, Copy } from "lucide-react";
import { VscEye } from "react-icons/vsc";
import { useToast } from "@/hooks/use-toast";

// Import types for messages, thinking state, conversations, and agents
import type { ThinkingState, Agent, MessageOut, ConversationDetail, ConversationSummary, FileAttachment, ConversationIn, CreateConversationResponse, MessageIn, AttachmentIn } from "@/lib/types";

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
  createStickyUserBarHandlers
} from "@/components/handlers";
import { loadSession, isSessionValid } from "@/lib/authStorage";

// Chat Interface component
import LoginPanel from "@/components/layouts/LoginPanel";
import Header from "@/components/layouts/Header";
import Sidebar from "@/components/layouts/Sidebar";
import UserProfilePanel from "@/components/layouts/UserProfilePanel";
import { InputContainer } from "@/components/layouts/InputContainer";


export function ChatInterface() {
  // Initial session check
  const initialSession = typeof window !== 'undefined' ? loadSession() : null;
  const initialUserId = isSessionValid(initialSession) ? initialSession!.userId : null;
  const initialLoggedIn = Boolean(initialUserId);
  
  // Main state variables
  const [currentConversation, setCurrentConversation] = useState<ConversationDetail | null>(null);
  const [currentMessage, setCurrentMessage] = useState('');
  const [messages, setMessages] = useState<MessageOut[]>([]);
  const [attachments, setAttachments] = useState<File[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string>('');
  const [isPrivateMode, setIsPrivateMode] = useState(false);
  
  // Main variables use for storing info from the db and present it constantly
  const [agents, setAgents] = useState<Agent[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  
  // Thinking variables (will be changed)
  const [expandedThinking, setExpandedThinking] = useState<{[key: string]: boolean}>({});
  const [thinkingState, setThinkingState] = useState<ThinkingState | null>(null);
  
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
  const [sidebarOpen, setSidebarOpen] = useState(false);
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
  useAutoScrollEffect(messages, thinkingState, messagesEndRef);
  useThinkingProgressEffect({ thinkingState, setThinkingState, agents, selectedAgent, setMessages });
  useAuthRehydrateEffect({ setIsLoggedIn, setUserId, setAgents, setConversations, setSelectedAgent, setCurrentConversation, setMessages, setIsPrivateMode, toast: toastWrapper });
  useSessionStateSyncEffect({ userId, selectedAgent, currentConversationId: currentConversation?.id || null, isPrivateMode });
  useUIPersistEffect({
    userId,
    snapshot: {
      version: 1,
      selectedAgent,
      isPrivateMode,
      currentMessage,
      expandedThinking,
      thinkingState,
      sidebarOpen,
      activeProfileTab,
      selectedImage,
      currentConversation: currentConversation
        ? {
            ...currentConversation,
            created_at: currentConversation.created_at ? currentConversation.created_at.toISOString() : null,
            updated_at: currentConversation.updated_at ? currentConversation.updated_at.toISOString() : null,
          }
        : null,
      messages: messages.map(m => ({
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
  
  // Handle image click for full preview
  const handleImageClick = (imageUrl: string) => {
    setSelectedImage(imageUrl);
  };
  
  // UI Handlers (clipboard, etc.)
  const { handleCopy } = createUIHandlers({ toast: toastWrapper , setCopiedId });

  // AI transition dot (between DB persistence and thinking start)
  const [showAiTransition, setShowAiTransition] = useState(false);
  useEffect(() => {
    if (thinkingState?.isActive) setShowAiTransition(false);
  }, [thinkingState?.isActive]);
  
  // Conversations and agent handlers
  const {
    handleConversationSelect,
    handleDeleteConversation,
    handleNewChat,
    handleTitleClick,
    clearChatAndStopThinking,
  } = createConversationHandlers({
    userId,
    conversations,
    setConversations,
    currentConversation,
    setLoadingConversation,
    setSidebarOpen,
    setIsClearing,
    setMessages,
    setSelectedAgent,
    setCurrentConversation,
    setIsPrivateMode,
    setExpandedThinking,
    setAttachments,
    setCurrentMessage,
    setThinkingState,
    toast: toastWrapper,
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
  const { handleLogin, handleLogoutLocal } = createAuthHandlers({
    setIsLoggedIn,
    setUserId,
    setAgents,
    setConversations,
    setLoginUsername,
    setLoginPassword,
    toast: toastWrapper,
    loginUsername,
    loginPassword,
  });

  // Inference handler (send message)
  const { handleSendMessage } = createInferenceHandlers({
    userId,
    selectedAgent,
    isPrivateMode,
    messages,
    attachments,
    agents,
    currentConversation,
    currentMessage,
    isSendingMessage,
    setMessages,
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
    <div className="animate-fade-in">
      <TooltipProvider>
        <div className={`flex flex-col h-screen bg-gradient-to-br from-slate-950/20 via-slate-700/30 to-slate-950/20 relative overflow-hidden transition-slow ${isClearing || isAgentSwitching ? 'opacity-60' : 'opacity-100'}`}>
          {/* Header */}
          <Header
            agents={agents}
            selectedAgent={selectedAgent}
            onAgentChange={handleAgentChange}
            onNewChat={handleNewChat}
            showPrivateToggle={messages.length === 0 || isPrivateMode}
            isPrivateMode={isPrivateMode}
            onTogglePrivate={() => {
              if (messages.length === 0 || !isPrivateMode) {
                setIsPrivateMode(!isPrivateMode);
              }
            }}
            onOpenUserProfile={() => setShowUserProfile(true)}
          />

          {/* Floating Sidebar Button */}
          <Sidebar
            open={sidebarOpen}
            onOpenChange={setSidebarOpen}
            conversations={conversations}
            currentConversationId={currentConversation?.id || null}
            onSelectConversation={handleConversationSelect}
            onDeleteConversation={handleDeleteConversation}
            onTitleClick={handleTitleClick}
            agents={agents}
          />

          {/* Chat Messages Container*/}
          <div className="flex-1 overflow-hidden relative">
            <ScrollArea className="h-full">
              <div className={`max-w-6xl mx-auto p-3 md:p-6 space-y-4 md:space-y-6 messages-container transition-smooth ${isClearing ? 'messages-clearing' : ''}`}>
                
                {/* Loading skeleton during conversation loading */}
                {loadingConversation && (
                  <div className="space-y-4">
                    {[1, 2, 3].map((i) => (
                      <div key={i} className="animate-fade-in">
                        <div className="flex justify-end mb-4">
                          <div className="max-w-[85%] md:max-w-[70%]">
                            <div className="loading-skeleton h-20 rounded-2xl"></div>
                          </div>
                        </div>
                        <div className="flex justify-start">
                          <div className="max-w-[85%] md:max-w-[70%]">
                            <div className="loading-skeleton h-16 rounded-2xl"></div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {/* For every Message in Messages List */}
                {!loadingConversation && messages.map((message, idx) => (
                  <div key={idx} className="animate-fade-in space-y-2">
                    {/* Show attachments for message (if any) */}
                    {message.attachments && message.attachments.length > 0 && (
                      <div className={`${message.sender === 'user' ? 'flex justify-end' : ''}`}>
                        <div className="max-w-[85%] md:max-w-[85%]">
                          {(() => {
                            const items = message.attachments.map((attachment: any) => {
                              const isImage = isImageFile(attachment);
                              let imageUrl = '';
                              let fileName = '';
                              if (typeof attachment === 'string') {
                                imageUrl = attachment; fileName = attachment;
                              } else if ('data' in attachment && attachment.data) {
                                imageUrl = `data:${attachment.mime};base64,${attachment.data}`; fileName = attachment.name;
                              } else if ('url' in attachment && (attachment as any).url) {
                                imageUrl = (attachment as any).url; fileName = (attachment as any).name;
                              } else if ('file' in attachment && (attachment as any).file) {
                                imageUrl = URL.createObjectURL((attachment as any).file); fileName = (attachment as any).name;
                              } else {
                                imageUrl = ''; fileName = 'name' in attachment ? attachment.name : 'Unknown file';
                              }
                              const typeLabel = ('mime' in attachment && (attachment as any).mime) ? (attachment as any).mime : (isImage ? 'Image' : 'File');
                              return { attachment, isImage, imageUrl, fileName, typeLabel };
                            });
                            const images = items.filter(i => i.isImage);
                            const files = items.filter(i => !i.isImage);
                            return (
                              <div className="flex flex-col items-end space-y-3">
                                {files.length > 0 && (
                                  <div className="flex flex-col gap-2 w-fit self-end">
                                    {files.map((f, index) => (
                                      <div key={`file-${index}`} className="text-xs self-end">
                                        <div className="group relative cursor-pointer bg-muted/20 hover:bg-muted/30 border border-border/30 rounded-2xl px-3 py-3 transition-all duration-200 hover:shadow-md w-64 md:w-80"
                                          onClick={() => handleFileDownload(f.attachment as any, message)}
                                        >
                                          <div className="flex items-center gap-3">
                                            <div className="w-10 h-10 rounded-xl bg-primary/90 text-primary-foreground flex items-center justify-center">
                                              <FileText size={16} />
                                            </div>
                                            <div className="min-w-0 flex-1">
                                              <div className="font-medium text-foreground/90 truncate w-full">{f.fileName}</div>
                                              <div className="text-muted-foreground/70 truncate w-full">{f.typeLabel}</div>
                                            </div>
                                          </div>
                                          <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                                            <div className="bg-primary/90 text-primary-foreground rounded-full p-2 shadow-lg">
                                              <Download size={16} />
                                            </div>
                                          </div>
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                )}
                                {images.length > 0 && (
                                  <div className="grid grid-cols-2 gap-3 self-end">
                                    {images.map((img, idx) => (
                                      <div key={`img-${idx}`} className={`${(images.length % 2 === 1 && idx === images.length - 1) ? 'col-span-2' : ''}`}>
                                        <div className="relative group cursor-pointer" onClick={() => handleImageClick(img.imageUrl)}>
                                          <img src={img.imageUrl} alt="Image" className="w-full h-28 md:h-32 object-cover rounded-xl border border-0 transition-all hover:scale-[1.02] hover:shadow-lg" />
                                          <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity rounded-xl flex items-center justify-center">
                                            <VscEye size={16} className="text-white" />
                                          </div>
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            );
                          })()}
                        </div>
                      </div>
                    )}
                    
                    {/* Show text message (if any) */}
                    {message.content && (
                      <div className={`space-y-2 md:space-y-3 ${message.sender === 'user' ? 'flex flex-col items-end' : ''} group/message`}>
                        {/* Show thinking process container */}
                        {message.thinking && message.sender === 'ai' && (
                          <div className="
                            flex items-center gap-2 text-xs md:text-sm font-medium 
                            text-muted-foreground hover:text-foreground 
                            transition-colors cursor-pointer max-w-[85%] md:max-w-[85%] w-full"
                            onClick={() => toggleThinking(message.id)}
                          >
                            <span>
                              {message.thinkingTime ? `Thought for ${message.thinkingTime} secs` : 'Thinking...'}
                            </span>
                            {expandedThinking[message.id] ? (
                              <ChevronDown className="h-3 w-3 " />
                            ) : (
                              <ChevronRight className="h-3 w-3" />
                            )}
                          </div>
                        )}
                        
                        {/* If click, show expandable thinking content */}
                        {message.thinking && message.sender === 'ai' && (
                          <div
                            className={`overflow-hidden transition-all duration-300 ease-smooth ${
                              expandedThinking[message.id] ? 'max-h-[600px] opacity-100' : 'max-h-0 opacity-0'
                            }`}
                          >
                            <ThinkingList thoughts={message.thinking} className="max-w-[85%] md:max-w-[85%] w-full" />
                          </div>
                        )}
                        
                        {/* Main message content */}
                        <Card className={`${
                          message.sender === 'user'
                            ? 'p-5 bg-chat-user text-chat-user-foreground ml-auto shadow-card border-border max-w-[85%] md:max-w-[75%]'
                            : 'p-5 bg-gradient-card text-card-foreground bg-transparent shadow-none border-transparent max-w-[85%] md:max-w-[85%]'
                        }`}>
                          <div className="space-y-3 min-w-0">
                            <MarkdownRenderer content={message.content} className="leading-relaxed break-words" />
                            <div className="text-sm opacity-70 flex items-center gap-2">
                              {/* Timestamp */}
                              <span>
                                {message.created_at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                              </span>
                              
                              {/* Action bar (AI only) */}
                              {message.sender === 'ai' && (
                                <>
                                  {/* Agent name */}
                                  <span className="flex items-center gap-1">
                                    •   <AgentIcon size={14} /> {currentAgent?.name}
                                  </span>
                                  
                                  {/* Action buttons */}
                                  <div className="flex justify-start">
                                    <div className="mt-1">
                                      <Tooltip>
                                        <TooltipTrigger asChild>
                                          <Button
                                            variant="ghost"
                                            size="icon"
                                            className="
                                              h-8 w-8 text-muted-foreground hover:text-foreground
                                              hover:bg-muted/60 active:!bg-muted/70 active:!text-foreground
                                              focus:!bg-muted/60 focus:!text-foreground focus:outline-none 
                                              focus:ring-0 focus-visible:ring-0 transition-colors
                                            "
                                            onMouseDown={(e) => e.preventDefault()}
                                            onClick={() => handleCopy(message.content!, message.id)}
                                            aria-label={copiedId === message.id ? "Copied" : "Copy"}
                                          >
                                            <span className="relative inline-block h-4 w-4">
                                              {/* Copy icon */}
                                              <Copy
                                                className={`absolute inset-0 h-4 w-4 transition-all duration-200
                                                  ${copiedId === message.id ? 'opacity-0 scale-75' : 'opacity-100 scale-100'}`}
                                              />
                                              {/* Check icon */}
                                              <Check
                                                className={`absolute inset-0 h-4 w-4 transition-all duration-200
                                                  ${copiedId === message.id ? 'opacity-100 scale-100' : 'opacity-0 scale-75'}`}
                                              />
                                            </span>
                                          </Button>
                                        </TooltipTrigger>
                                        <TooltipContent
                                          side="bottom"
                                          align="center"
                                          className="!opacity-100 bg-background text-foreground border border-border shadow-card px-2 py-1 rounded-md"
                                        >
                                          <p>Copy</p>
                                        </TooltipContent>
                                      </Tooltip>
                                    </div>
                                  </div>
                                </>
                              )}
                            </div>
                          </div>
                        </Card>
                        
                        {/* Action bar (User only) */}
                        {message.sender === 'user' && (
                          <div className="flex justify-end">
                            <div
                              className={`
                                transition-opacity
                                ${
                                  stickyUserBarId === message.id
                                    ? 'opacity-100 pointer-events-auto'
                                    : 'opacity-0 group-hover/message:opacity-100 hover:opacity-100 pointer-events-none group-hover/message:pointer-events-auto hover:pointer-events-auto'
                                }
                              `}
                            >
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="
                                      h-8 w-8 text-muted-foreground hover:text-foreground
                                      hover:bg-muted/60 active:!bg-muted/70 active:!text-foreground
                                      focus:!bg-muted/60 focus:!text-foreground focus:outline-none 
                                      focus:ring-0 focus-visible:ring-0 transition-colors
                                    "
                                    onMouseDown={(e) => e.preventDefault()}
                                    onClick={() => {
                                      handleCopy(message.content!, message.id);
                                      flashUserActionBar(message.id); // keep visible for 3s
                                    }}
                                    aria-label={copiedId === message.id ? "Copied" : "Copy"}
                                  >
                                    <span className="relative inline-block h-4 w-4">
                                      {/* Copy icon */}
                                      <Copy
                                        className={`absolute inset-0 h-4 w-4 transition-all duration-200
                                          ${copiedId === message.id ? 'opacity-0 scale-75' : 'opacity-100 scale-100'}`}
                                      />
                                      {/* Check icon */}
                                      <Check
                                        className={`absolute inset-0 h-4 w-4 transition-all duration-200
                                          ${copiedId === message.id ? 'opacity-100 scale-100' : 'opacity-0 scale-75'}`}
                                      />
                                    </span>
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent
                                  side="bottom"
                                  align="center"
                                  className="!opacity-100 bg-background text-foreground border border-border shadow-card px-2 py-1 rounded-md"
                                >
                                  <p>Copy</p>
                                </TooltipContent>
                              </Tooltip>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
                
                {/* AI Transition Indicator (left-aligned) */}
                {showAiTransition && !thinkingState?.isActive && (
                  <div className="flex justify-start pl-2">
                    <div className="size-3 rounded-full bg-white/90 shadow-sm transform-gpu motion-safe:animate-pulse-scale" />
                  </div>
                )}
                
                {/* Enhanced Thinking Animation */}
                <div
                  className={`overflow-hidden transition-all duration-300 ease-smooth ${
                    thinkingState?.isActive ? 'max-h-[600px] opacity-100 mt-2' : 'max-h-0 opacity-0'
                  }`}
                >
                  <div className="text-sm text-muted-foreground mb-1">Thinking...</div>
                  {thinkingState && (
                    <ThinkingList
                      thoughts={thinkingState.thoughts.slice(0, thinkingState.currentThoughtIndex + 1)}
                      className="max-w-[85%] md:max-w-[85%]"
                    />
                  )}
                </div>
                
                <div ref={messagesEndRef} />
              </div>
            </ScrollArea>
          </div>
          
          {/* Input Area */}
          <InputContainer
            // Centered empty state
            isMessagesEmpty={messages.length === 0 ? true : false}
            positionClass={
              messages.length === 0
              ? "fixed inset-x-0 top-1/3 -translate-y-[120px] z-40 p-6"
              : "bottom-0 left-0 right-0 z-0 p-6"
            }
            
            // pass through your existing state/handlers/refs
            attachments={attachments}
            isPrivateMode={isPrivateMode}
            thinkingActive={thinkingState?.isActive}
            currentMessage={currentMessage}
            setCurrentMessage={setCurrentMessage}
            handlePaste={handlePaste}
            handleSendMessage={handleSendMessage}
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
            Mic={Mic}
            Button={Button}
            Send={Send}
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
            onLogout={() => {
              setShowUserProfile(false);
              setTimeout(() => {
                handleLogoutLocal();
                setIsLoggedIn(false);
                setUserId(null);
                setLoginUsername("");
                setLoginPassword("");
                setAgents([]);
                setConversations([]);
                clearChatAndStopThinking();
              }, 300);
            }}
          />
          
          {/* Image Preview Modal */}
          {selectedImage && (
            <div 
              className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4"
              onClick={() => setSelectedImage(null)}
            >
              <div className="relative w-full h-full flex items-center justify-center">
                <button
                  onClick={() => setSelectedImage(null)}
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
    </div>
  );
}
