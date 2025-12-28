import React from "react";
import type { ComponentType } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { LucideIcon } from "lucide-react";
import type {
  Agent,
  MessageOut,
  ThinkingState,
} from "@/lib/types";
import type { AttachmentLike } from "./message_parts/MessageAttachments";
import { ChatMessage } from "./ChatMessage";

type ChatBody = {
  messages: MessageOut[];
  loadingConversation: boolean;
  isClearing: boolean;
  expandedThinking: Record<string, boolean>;
  isImageFile: (attachment: AttachmentLike) => boolean;
  onDownloadAttachment: (attachment: AttachmentLike, message: MessageOut) => void;
  onImageClick: (imageUrl: string) => void;
  onToggleThinking: (messageId: string) => void;
  copiedId: string | null;
  onCopy: (content: string, messageId: string) => void;
  onLike: (message: MessageOut) => void;
  onDislike: (message: MessageOut) => void;
  stickyUserBarId: string | null;
  onFlashUserActionBar: (messageId: string) => void;
  AiTransitionIndicator?: ComponentType;
  thinkingState: ThinkingState | null;
  messagesEndRef: React.RefObject<HTMLDivElement>;
  AgentIcon: LucideIcon;
  currentAgent?: Agent;
  onScrolledPastTop?: (isScrolled: boolean) => void;
  branchChildrenMap?: Record<string, MessageOut[]>;
  branchSelections?: Record<string, number>;
  onSelectBranch?: (parentId: string | null, branchIndex: number) => void;
  branchRootKey?: string;
  activeBranchPath?: string[];
  editingMessageId?: string | null;
  editingDraft?: string;
  editingBusy?: boolean;
  onRequestEdit?: (message: MessageOut) => void;
  onChangeEditDraft?: (value: string) => void;
  onCancelEdit?: () => void;
  onSubmitEdit?: () => void;
  toast?: (opts: { title: string; description?: string; variant?: string; duration?: number }) => void;
  onRetryMessage?: (message: MessageOut) => void;
  isStreaming?: boolean;
};

export default function ChatBody({
  messages,
  loadingConversation,
  isClearing,
  expandedThinking,
  isImageFile,
  onDownloadAttachment,
  onImageClick,
  onToggleThinking,
  copiedId,
  onCopy,
  onLike,
  onDislike,
  stickyUserBarId,
  onFlashUserActionBar,
  AiTransitionIndicator,
  thinkingState,
  messagesEndRef,
  AgentIcon,
  currentAgent,
  onScrolledPastTop,
  branchChildrenMap = {},
  branchSelections = {},
  onSelectBranch,
  branchRootKey = "__root__",
  activeBranchPath,
  editingMessageId,
  editingDraft,
  editingBusy,
  onRequestEdit,
  onChangeEditDraft,
  onCancelEdit,
  onSubmitEdit,
  toast,
  onRetryMessage,
  isStreaming,
}: ChatBody) {
  const viewportRef = React.useRef<HTMLDivElement | null>(null);
  const streamingMessageId = React.useMemo(() => {
    if (thinkingState?.branchPath && thinkingState.branchPath.length > 0) {
      return thinkingState.branchPath[thinkingState.branchPath.length - 1];
    }
    return null;
  }, [thinkingState?.branchPath]);

  const handleScroll = React.useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      const scrolled = event.currentTarget.scrollTop > 4;
      onScrolledPastTop?.(scrolled);
    },
    [onScrolledPastTop]
  );

  React.useEffect(() => {
    if (!onScrolledPastTop) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    onScrolledPastTop(viewport.scrollTop > 4);
  }, [messages.length, onScrolledPastTop]);

  return (
    <div className="flex-1 overflow-hidden relative">
      <ScrollArea className="h-full" onScroll={handleScroll} viewportRef={viewportRef}>
        <div
          className={`w-full max-w-3xl mx-auto p-3 md:p-6 space-y-4 md:space-y-6 messages-container transition-smooth ${
            isClearing ? 'messages-clearing' : ''
          }`}
        >
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

          {!loadingConversation &&
            messages.map((message) => {
              const isEditingMessage = editingMessageId === message.id;
              
              const userActionVisibilityClass = `transition-opacity ${
                stickyUserBarId === message.id
                  ? "opacity-100 pointer-events-auto"
                  : "opacity-0 group-hover/message:opacity-100 hover:opacity-100 pointer-events-none group-hover/message:pointer-events-auto hover:pointer-events-auto"
              }`;
              
              const parentId = message.parentMessageId ?? null;
              
              const branchOptions = parentId
                ? branchChildrenMap[parentId]
                : branchChildrenMap[branchRootKey];
              
              const branchSelection =
                parentId
                  ? branchSelections[parentId] ?? 0
                  : branchSelections[branchRootKey] ?? 0;

              return (
                <div key={message.id} className="animate-fade-in-fast space-y-2">
                  <ChatMessage
                    message={message}
                    isEditing={isEditingMessage}
                    editingDraft={editingDraft}
                    editingBusy={editingBusy}
                    onChangeEditDraft={onChangeEditDraft}
                    onCancelEdit={onCancelEdit}
                    onSubmitEdit={onSubmitEdit}
                    AgentIcon={AgentIcon}
                    currentAgent={currentAgent}
                    copiedId={copiedId}
                    onCopy={onCopy}
                    onLike={onLike}
                    onDislike={onDislike}
                    toast={toast}
                    onRetryMessage={onRetryMessage}
                    isStreaming={isStreaming}
                    onFlashUserActionBar={onFlashUserActionBar}
                    onRequestEdit={onRequestEdit}
                    userActionVisibilityClass={userActionVisibilityClass}
                    thinkingState={thinkingState}
                    expandedThinking={expandedThinking}
                    onToggleThinking={onToggleThinking}
                    activeBranchPath={activeBranchPath}
                    streamingMessageId={streamingMessageId}
                    isImageFile={isImageFile}
                    onDownloadAttachment={onDownloadAttachment}
                    onImageClick={onImageClick}
                    branchData={{
                      parentId,
                      options: branchOptions,
                      selectionIndex: branchSelection,
                      onSelectBranch,
                    }}
                  />
                </div>
              );
            })
          }

          {AiTransitionIndicator ? <AiTransitionIndicator /> : null}

          <div ref={messagesEndRef} />
        </div>
      </ScrollArea>
    </div>
  );
}







