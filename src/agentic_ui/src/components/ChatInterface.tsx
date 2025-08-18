import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/utils/button";
import { Textarea } from "@/components/utils/textarea";
import { Card } from "@/components/utils/card";
import { ScrollArea } from "@/components/utils/scroll-area";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/utils/tooltip";
import { Send, Paperclip, Mic, Building2, ChevronDown, ChevronRight, X, Eye } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
// import StarBorder from "@/components/utils/react_bits/star_border"

// Import types for messages, thinking state, conversations, and agents
import type { Message, ThinkingState, Conversation, Agent, } from "@/lib/types";
import { getAgents, getConversations, deleteConversation, getConversationDetail, authenticate } from "@/lib/api";

// Chat Interface component
import LoginPanel from "@/components/layouts/LoginPanel";
import Header from "@/components/layouts/Header";
import Sidebar from "@/components/layouts/Sidebar";
import UserProfilePanel from "@/components/layouts/UserProfilePanel";
import { InputContainer } from "@/components/layouts/InputContainer";


export function ChatInterface() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [currentMessage, setCurrentMessage] = useState('');
  const [selectedAgent, setSelectedAgent] = useState<string>('');
  const [attachments, setAttachments] = useState<File[]>([]);
  const [expandedThinking, setExpandedThinking] = useState<{[key: string]: boolean}>({});
  const [thinkingState, setThinkingState] = useState<ThinkingState | null>(null);
  const [currentConversation, setCurrentConversation] = useState<Conversation | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isPrivateMode, setIsPrivateMode] = useState(false);
  const [showUserProfile, setShowUserProfile] = useState(false);
  const [activeProfileTab, setActiveProfileTab] = useState('profile');
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [isAgentSwitching, setIsAgentSwitching] = useState(false);
  const [isSendingMessage, setIsSendingMessage] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { toast } = useToast();
  
  // Ensure a default selected agent after agents are loaded
  useEffect(() => {
    if (isLoggedIn && userId && agents.length > 0) {
      const exists = agents.some(a => a.id === selectedAgent);
      if (!exists) {
        setSelectedAgent(agents[0].id);
      }
    }
  }, [isLoggedIn, userId, agents]);
  
  // Scroll to bottom function
  const scrollToBottom = () => {
    setTimeout(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, 100);
  };
  
  // Scroll to bottom when messages or thinking state changes
  useEffect(() => {
    scrollToBottom();
  }, [messages, thinkingState]);
  
  // Enhanced thinking animation
  useEffect(() => {
    if (!thinkingState?.isActive) return;

    const interval = setInterval(() => {
      setThinkingState(prev => {
        if (!prev) return null;
        
        if (prev.currentThoughtIndex < prev.thoughts.length - 1) {
          return {
            ...prev,
            currentThoughtIndex: prev.currentThoughtIndex + 1
          };
        } else if (!prev.isDone) {
          const endTime = Date.now();
          setTimeout(() => {
            // Add "Done!" to thoughts and collapse
            const totalTime = Math.round((endTime - prev.startTime) / 1000);
            const agentResponse: Message = {
              id: prev.messageId,
              content: `Hello! I'm your ${agents.find(a => a.id === selectedAgent)?.name}. I'm here to assist you with specialized knowledge and support. How can I help you today?`,
              sender: 'agent',
              timestamp: new Date(),
              type: 'text',
              thinking: prev.thoughts.concat('Done!'),
              thinkingTime: totalTime
            };
            setMessages(prevMessages => [...prevMessages, agentResponse]);
            setThinkingState(null);
          }, 1000);
          
          return {
            ...prev,
            isDone: true,
            endTime
          };
        }
        return prev;
      });
    }, 2000);

    return () => clearInterval(interval);
  }, [thinkingState, selectedAgent]);
  
  // Handle sending message
  const handleSendMessage = async () => {
    if (!currentMessage.trim() && attachments.length === 0) return;
    if (isSendingMessage) return; // Prevent double-sending

    setIsSendingMessage(true);
    const currentAgent = agents.find(a => a.id === selectedAgent);

    // Only create conversation on first message
    if (messages.length === 0) {
      const conversationId = Date.now().toString();
      const conversation: Conversation = {
        id: conversationId,
        agentId: selectedAgent,
        agentName: currentAgent?.name || '',
        lastMessage: currentMessage,
        timestamp: new Date(),
        messages: [],
        isPrivate: isPrivateMode
      };
      setCurrentConversation(conversation);
    }

    // Create attachments array with File objects for proper handling
    const messageAttachments = attachments.map(file => ({
      file: file,
      url: isImageFile(file) ? getImageUrl(file) : null,
      name: file.name,
      type: file.type
    }));

    const newMessage: Message = {
      id: Date.now().toString(),
      content: currentMessage,
      sender: 'user',
      timestamp: new Date(),
      type: attachments.length > 0 ? 'file' : 'text',
      attachments: messageAttachments
    };

    // Add message with smooth animation
    setTimeout(() => {
      setMessages(prev => [...prev, newMessage]);
      setCurrentMessage('');
      setAttachments([]);
      setIsSendingMessage(false);
    }, 100);

    // Start enhanced thinking animation
    const thinking = [
      "Analyzing the user's query and determining the best approach...",
      "Considering relevant context and domain-specific knowledge...",
      "Cross-referencing with specialized databases and policies...",
      // "Formulating a comprehensive and helpful response...",
      // "Preparing the final response based on analysis..."
    ];

    setThinkingState({
      messageId: (Date.now() + 1).toString(),
      thoughts: thinking,
      currentThoughtIndex: 0,
      isActive: true,
      isDone: false,
      startTime: Date.now()
    });
  };
  
  // Handle file upload
  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    if (files.length > 0) {
      const totalFilesAfterAdd = attachments.length + files.length;
      if (totalFilesAfterAdd > 5) {
        const remainingSlots = 5 - attachments.length;
        if (remainingSlots <= 0) {
          toast({
            title: "Maximum attachments reached",
            description: "You can only attach up to 5 files per message",
            variant: "destructive",
            duration: 3000,
          });
          return;
        }
        
        const filesToAdd = files.slice(0, remainingSlots);
        const extraFiles = files.length - filesToAdd.length;
        
        setAttachments(prev => [...prev, ...filesToAdd]);
        
        toast({
          title: "Some files not added",
          description: `Only ${filesToAdd.length} files added. Maximum 5 files allowed per message (${extraFiles} files excluded).`,
          variant: "destructive",
          duration: 3000,
        });
      } else {
        setAttachments(prev => [...prev, ...files]);
        toast({
          title: "Files attached",
          description: `${files.length} file(s) attached to your message`,
          duration: 2000,
        });
      }
    }
    // Reset the input value to allow selecting the same file again
    if (event.target) {
      event.target.value = '';
    }
  };
  
  // Handle paste event for images
  const handlePaste = (event: React.ClipboardEvent) => {
    const items = event.clipboardData?.items;
    if (!items) return;

    const remainingSlots = 5 - attachments.length;
    if (remainingSlots <= 0) {
      toast({
        title: "Maximum files reached",
        description: "You can only attach up to 5 files per message",
        variant: "destructive",
        duration: 3000,
      });
      return;
    }

    const filesToAdd: File[] = [];
    for (let i = 0; i < items.length && filesToAdd.length < remainingSlots; i++) {
      const item = items[i];
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          filesToAdd.push(file);
        }
      }
    }
    
    if (filesToAdd.length > 0) {
      setAttachments(prev => [...prev, ...filesToAdd]);
    }
  };
  
  // Check if file is image
  const isImageFile = (file: File | any): boolean => {
    if (file?.type) {
      return file.type.startsWith('image/');
    }
    if (file?.url) {
      return /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(file.url);
    }
    if (typeof file === 'string') {
      return /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(file);
    }
    return false;
  };
  
  // Get image URL from file
  const getImageUrl = (file: File): string => {
    return URL.createObjectURL(file);
  };
  
  // Handle image click for full preview
  const handleImageClick = (imageUrl: string) => {
    setSelectedImage(imageUrl);
  };
  
  // Clear chat and stop thinking state with smooth transition
  const clearChatAndStopThinking = () => {
    setIsClearing(true);
    
    // First phase: fade out existing content
    setTimeout(() => {
      setThinkingState(null);
      setMessages([]);
      setExpandedThinking({});
      setAttachments([]);
      setCurrentMessage('');
      setCurrentConversation(null);
      setIsPrivateMode(false);
      
      // Second phase: fade back in
      setTimeout(() => {
        setIsClearing(false);
      }, 150);
    }, 200);
  };
  
  // Handle title click to clear chat
  const handleTitleClick = () => {
    clearChatAndStopThinking();
    setSidebarOpen(false);
  };
  
  // Handle agent change from dropdown with smooth transition
  const handleAgentChange = (value: string) => {
    if (isAgentSwitching) return; // Prevent rapid switching
    
    setIsAgentSwitching(true);
    
    // Clear chat with smooth transition
    clearChatAndStopThinking();
    
    // Switch agent after clearing animation
    setTimeout(() => {
      setSelectedAgent(value);
      setTimeout(() => {
        setIsAgentSwitching(false);
      }, 200);
    }, 300);
  };
  
  // Handle new chat button click
  const handleNewChat = () => {
    clearChatAndStopThinking();
  };
  
  // Handle conversation selection from sidebar with smooth loading
  const handleConversationSelect = async (conversation: Conversation) => {
    if (!userId || loadingConversation) return;
    
    setLoadingConversation(true);
    
    // Start sidebar close transition first
    setSidebarOpen(false);
    
    // Clear current content with transition
    setIsClearing(true);
    
    setTimeout(async () => {
      try {
        // Fetch full conversation details from API
        const conversationDetail = await getConversationDetail(userId, conversation.id);
        
        // Update state with the loaded conversation data with staggered animation
        setTimeout(() => {
          setMessages(conversationDetail.messages);
          setSelectedAgent(conversationDetail.agentId);
          setCurrentConversation(conversationDetail);
          setIsPrivateMode(conversationDetail.isPrivate || false);
          setIsClearing(false);
        }, 100);
      
      } catch (error) {
        console.error('Failed to load conversation:', error);
        toast({
          title: "Failed to load conversation",
          description: "There was an error loading the conversation. Please try again.",
          variant: "destructive",
          duration: 3000,
        });
        
        // Fallback to basic conversation data on error
        setMessages([]);
        setSelectedAgent(conversation.agentId);
        setCurrentConversation(conversation);
        setIsPrivateMode(conversation.isPrivate || false);
        setIsClearing(false);
      } finally {
        setLoadingConversation(false);
      }
    }, 300);
  };
  
  // Handle conversation deletion
  const handleDeleteConversation = async (conversationId: string, event: React.MouseEvent) => {
    event.stopPropagation(); // Prevent conversation selection when clicking delete
    if (!userId) return;
    
    try {
      await deleteConversation(userId, conversationId);
      setConversations(conversations.filter(conv => conv.id !== conversationId));
      
      // If deleting the currently active conversation, clear the chat
      if (conversationId === currentConversation?.id) {
        clearChatAndStopThinking();
      }
      
      toast({
        title: "Conversation deleted",
        description: "The conversation has been removed from your history",
        duration: 2000,
      });
    } catch (error) {
      console.error('Failed to delete conversation:', error);
      toast({
        title: "Failed to delete conversation",
        description: "There was an error deleting the conversation. Please try again.",
        variant: "destructive",
        duration: 3000,
      });
    }
  };
  
  // Handle thinking toggle
  const toggleThinking = (messageId: string) => {
    setExpandedThinking(prev => ({
      ...prev,
      [messageId]: !prev[messageId]
    }));
  };
  
  // Handle attachment removal
  const removeAttachment = (index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index));
  };
  
  // Handle login functionality
  const handleLogin = async () => {
    try {
      const response = await authenticate({
        username: loginUsername.trim(),
        password: loginPassword.trim()
      });
      
      if (response.authenticated && response.user_id) {
        // Smooth login transition with data loading
        setTimeout(async () => {
          setIsLoggedIn(true);
          setUserId(response.user_id!);
          
          // Fetch available agents and conversations after successful login
          try {
            const [agentsList, conversationsList] = await Promise.all([
              getAgents(),
              getConversations(response.user_id!)
            ]);
            setAgents(agentsList);
            setConversations(conversationsList);
          } catch (e) {
            // Keep UI functional even if data can't be loaded
            setAgents([]);
            setConversations([]);
          }
        }, 600);
      } else {
        toast({
          title: "Authentication failed",
          description: "Please check your credentials and try again.",
          variant: "destructive",
          duration: 2000,
        });
      }
    } catch (error) {
      console.error('Authentication error:', error);
      toast({
        title: "Login Failed",
        description: "Unable to connect to authentication service",
        variant: "destructive",
      });
    }
  };
  
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
              // preserve your original guard
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
                {!loadingConversation && messages.map((message) => (
                  <div key={message.id} className="animate-fade-in space-y-2">
                    {/* Show attachments message (if any) */}
                    {message.attachments && message.attachments.length > 0 && (
                      <div className={`${message.sender === 'user' ? 'flex justify-end' : ''}`}>
                        <div className="max-w-[85%] md:max-w-[85%]">
                          <div className="flex flex-wrap gap-2">
                            {message.attachments.map((attachment, index) => {
                              const isImage = isImageFile(attachment);
                              // For string attachments (legacy), use the string directly
                              // For object attachments, use the URL or fallback to creating a new blob URL from the file
                              let imageUrl: string;
                              let fileName: string;
                              
                              if (typeof attachment === 'string') {
                                imageUrl = attachment;
                                fileName = attachment;
                              } else {
                                // Always use the stored URL or create a fresh one
                                imageUrl = attachment.url || URL.createObjectURL(attachment.file);
                                fileName = attachment.name;
                              }
                              
                              return (
                                <div key={index} className={`text-xs ${isImage ? '' : 'bg-black/20 px-3 py-1 rounded-md flex items-center gap-1'}`}>
                                    {isImage ? (
                                      <div 
                                        className="relative group cursor-pointer"
                                        onClick={() => handleImageClick(imageUrl)}
                                      >
                                        <img 
                                          src={imageUrl} 
                                          alt="Image" 
                                          className="w-12 h-12 object-cover rounded-md border border-white/20 transition-all hover:scale-105 hover:shadow-lg"
                                        />
                                        <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity rounded-md flex items-center justify-center">
                                          <Eye size={12} className="text-white" />
                                        </div>
                                      </div>
                                    ) : (
                                      <>
                                        <Paperclip size={12} />
                                        {fileName}
                                      </>
                                    )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    )}
                    
                    {/* Show text message (if any) */}
                    {message.content && (
                      <div className={`space-y-2 md:space-y-3 ${message.sender === 'user' ? 'flex justify-end' : ''}`}>
                        {/* Show thinking process container */}
                        {message.thinking && message.sender === 'agent' && (
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
                        {message.thinking && message.sender === 'agent' && expandedThinking[message.id] && (
                          <div className="border border-border/50 rounded-lg p-2 md:p-3 bg-muted/20 space-y-2 max-w-[85%] md:max-w-[85%] w-full">
                            {message.thinking.map((thought, thinkIndex) => (
                              <div key={thinkIndex} className="text-xs text-muted-foreground/80">
                                {thought}
                              </div>
                            ))}
                          </div>
                        )}
                        
                        {/* Main message content */}
                        <Card className={`p-5 ${
                          message.sender === 'user'
                            ? 'bg-neutral-800 text-foreground ml-auto shadow-card border-border max-w-[85%] md:max-w-[75%]'
                            : 'bg-gradient-card text-card-foreground bg-transparent shadow-none border-transparent max-w-[85%] md:max-w-[85%]'
                        }`}>
                          <div className="space-y-3">
                            <p className="whitespace-pre-wrap leading-relaxed">{message.content}</p>
                            <div className="text-xs opacity-70 flex items-center gap-2">
                              <span>{message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                              {message.sender === 'agent' && (
                                <span className="flex items-center gap-1">
                                  • <AgentIcon size={10} /> {currentAgent?.name}
                                </span>
                              )}
                            </div>
                          </div>
                        </Card>
                      </div>
                    )}
                  </div>
                ))}
                
                {/* Enhanced Thinking Animation */}
                {thinkingState?.isActive && (
                  <div className="animate-fade-in">
                    <div className="border border-border/50 rounded-lg p-4 bg-muted/20 max-w-[85%] md:max-w-[85%]">
                      <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground mb-2">
                        <span>Thinking...</span>
                      </div>
                      <div className="space-y-2">
                        {thinkingState.thoughts.slice(0, thinkingState.currentThoughtIndex + 1).map((thought, index) => (
                          <div key={index} className="text-xs text-muted-foreground/80 animate-fade-in">
                            {thought}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
                
                <div ref={messagesEndRef} />
              </div>
            </ScrollArea>
          </div>
          
          {/* Input Area */}
          {messages.length === 0 ? (
            <InputContainer
              // Centered empty state
              isMessagesEmpty={true}
              positionClass="fixed inset-x-0 top-1/3 -translate-y-[120px] z-40 p-6"
              
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
              toast={toast}
              currentAgent={currentAgent}
              Textarea={Textarea}
            />
          ) : (
            <InputContainer
              // Centered empty state
              isMessagesEmpty={false}
              positionClass="bottom-0 left-0 right-0 z-0 p-6"
              
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
              toast={toast}
              currentAgent={currentAgent}
              Textarea={Textarea}
            />
          )}
          
          
          {/* User Profile Modal */}
          <UserProfilePanel
            open={showUserProfile}
            onClose={() => setShowUserProfile(false)}
            activeTab={activeProfileTab}
            setActiveTab={setActiveProfileTab}
            onLogout={() => {
              // exactly the same logic you already had
              setShowUserProfile(false);
              setTimeout(() => {
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