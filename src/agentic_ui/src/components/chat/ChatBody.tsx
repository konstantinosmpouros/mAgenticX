import React from "react";
import type { ComponentType } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ArrowDown } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type {
  Agent,
  MessageOut,
  RunTimeline,
  ThinkingState,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import type { AttachmentLike } from "./message_parts/MessageAttachments";
import { ChatMessage } from "./ChatMessage";
import { ConversationRail } from "./message_parts/ConversationRail";

const AUTO_FOLLOW_DISTANCE = 96;
const JUMP_BUTTON_DISTANCE = 160;
const USER_SCROLL_UP_DELTA = 14;

type ChatBody = {
  messages: MessageOut[];
  showMessageTokenUsage?: boolean;
  loadingConversation: boolean;
  expandedThinking: Record<string, boolean>;
  isImageFile: (attachment: AttachmentLike) => boolean;
  onDownloadAttachment: (attachment: AttachmentLike, message: MessageOut) => void;
  onPreviewAttachment: (attachment: AttachmentLike, message: MessageOut) => void;
  onImageClick: (imageUrl: string) => void;
  onToggleThinking: (messageId: string, next?: boolean) => void;
  copiedId: string | null;
  onCopy: (content: string, messageId: string) => void;
  onLike: (message: MessageOut) => void;
  onDislike: (message: MessageOut) => void;
  onReportMessage?: (message: MessageOut) => void;
  conversationIsReported?: boolean;
  stickyUserBarId: string | null;
  onFlashUserActionBar: (messageId: string) => void;
  AiTransitionIndicator?: ComponentType;
  thinkingState: ThinkingState | null;
  messagesEndRef: React.RefObject<HTMLDivElement>;
  AgentIcon: LucideIcon;
  currentAgent?: Agent;
  resolveMessageAgent?: (message: MessageOut) => { name: string; Icon: LucideIcon };
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
  onForkMessage?: (message: MessageOut) => void;
  onShareMessage?: (message: MessageOut) => void;
  onReadAloud?: (message: MessageOut) => void;
  speakingMessageId?: string | null;
  readOnly?: boolean;
  isStreaming?: boolean;
  // Incrementally-folded timeline of the conversation's active run; handed
  // only to the streaming target message.
  liveTimeline?: RunTimeline | null;
  scrollResetKey?: string | null;
};

export default function ChatBody({
  messages,
  showMessageTokenUsage = false,
  loadingConversation,
  expandedThinking,
  isImageFile,
  onDownloadAttachment,
  onPreviewAttachment,
  onImageClick,
  onToggleThinking,
  copiedId,
  onCopy,
  onLike,
  onDislike,
  onReportMessage,
  conversationIsReported = false,
  stickyUserBarId,
  onFlashUserActionBar,
  AiTransitionIndicator,
  thinkingState,
  messagesEndRef,
  AgentIcon,
  currentAgent,
  resolveMessageAgent,
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
  onForkMessage,
  onShareMessage,
  onReadAloud,
  speakingMessageId,
  readOnly = false,
  isStreaming,
  liveTimeline = null,
  scrollResetKey,
}: ChatBody) {
  const viewportRef = React.useRef<HTMLDivElement | null>(null);
  const columnRef = React.useRef<HTMLDivElement | null>(null);
  const previousScrollTopRef = React.useRef(0);
  const programmaticScrollUntilRef = React.useRef(0);
  const scrollFrameRef = React.useRef<number | null>(null);
  const suppressFollowRef = React.useRef(false);
  const [isPinnedToBottom, setIsPinnedToBottom] = React.useState(true);
  const [showJumpToBottom, setShowJumpToBottom] = React.useState(false);
  const streamingMessageId = React.useMemo(() => {
    if (thinkingState?.branchPath && thinkingState.branchPath.length > 0) {
      return thinkingState.branchPath[thinkingState.branchPath.length - 1];
    }
    return null;
  }, [thinkingState?.branchPath]);

  const getDistanceFromBottom = React.useCallback((viewport: HTMLDivElement) => {
    return Math.max(0, viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight);
  }, []);

  const scrollToBottom = React.useCallback((behavior: ScrollBehavior = "auto") => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    programmaticScrollUntilRef.current = window.performance.now() + 350;
    viewport.scrollTo({
      top: viewport.scrollHeight,
      behavior,
    });
    previousScrollTopRef.current = viewport.scrollTop;
    setShowJumpToBottom(false);
  }, []);

  const scheduleScrollToBottom = React.useCallback(
    (behavior: ScrollBehavior = "auto") => {
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
      }
      scrollFrameRef.current = window.requestAnimationFrame(() => {
        scrollFrameRef.current = null;
        scrollToBottom(behavior);
      });
    },
    [scrollToBottom]
  );

  React.useEffect(() => {
    return () => {
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
      }
    };
  }, []);

  React.useEffect(() => {
    setIsPinnedToBottom(true);
    setShowJumpToBottom(false);
    scheduleScrollToBottom("auto");
  }, [scrollResetKey, scheduleScrollToBottom]);

  React.useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    // Skip the auto-follow for the render caused by a manual branch switch — the
    // message list changed because the user navigated siblings, not because the
    // stream appended, so keep their scroll position instead of jumping.
    if (suppressFollowRef.current) {
      suppressFollowRef.current = false;
      setShowJumpToBottom(getDistanceFromBottom(viewport) > JUMP_BUTTON_DISTANCE);
      return;
    }

    const distance = getDistanceFromBottom(viewport);
    const shouldFollow = isStreaming && (isPinnedToBottom || distance <= AUTO_FOLLOW_DISTANCE);
    if (!shouldFollow) {
      setShowJumpToBottom(distance > JUMP_BUTTON_DISTANCE);
      return;
    }

    setIsPinnedToBottom(true);
    scheduleScrollToBottom("auto");
  }, [messages, thinkingState, isStreaming, isPinnedToBottom, getDistanceFromBottom, scheduleScrollToBottom]);

  const handleJumpToBottom = React.useCallback(() => {
    setIsPinnedToBottom(true);
    scrollToBottom("smooth");
  }, [scrollToBottom]);

  const handleSelectBranch = React.useCallback(
    (parentId: string | null, branchIndex: number) => {
      // Flag the imminent message-list change as a manual branch switch so the
      // follow effect skips its auto-scroll (preserves the user's position).
      suppressFollowRef.current = true;
      onSelectBranch?.(parentId, branchIndex);
    },
    [onSelectBranch]
  );

  const handleWheel = React.useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      if (isStreaming && event.deltaY < -USER_SCROLL_UP_DELTA) {
        setIsPinnedToBottom(false);
      }
    },
    [isStreaming]
  );

  const handleScroll = React.useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      const viewport = event.currentTarget;
      const scrolled = viewport.scrollTop > 4;
      const distance = getDistanceFromBottom(viewport);
      const isNearBottom = distance <= AUTO_FOLLOW_DISTANCE;
      const isProgrammaticScroll = window.performance.now() < programmaticScrollUntilRef.current;
      const movedUp = previousScrollTopRef.current - viewport.scrollTop > USER_SCROLL_UP_DELTA;

      onScrolledPastTop?.(scrolled);
      setShowJumpToBottom(distance > JUMP_BUTTON_DISTANCE);

      if (isNearBottom) {
        setIsPinnedToBottom(true);
      } else if (isStreaming && movedUp && !isProgrammaticScroll) {
        setIsPinnedToBottom(false);
      }

      previousScrollTopRef.current = viewport.scrollTop;
    },
    [getDistanceFromBottom, isStreaming, onScrolledPastTop]
  );

  React.useEffect(() => {
    if (!onScrolledPastTop) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    onScrolledPastTop(viewport.scrollTop > 4);
  }, [messages.length, onScrolledPastTop]);

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden">
      <ScrollArea className="h-full" onScroll={handleScroll} onWheel={handleWheel} viewportRef={viewportRef}>
        <div
          ref={columnRef}
          className="w-full max-w-3xl mx-auto p-3 md:p-6 space-y-4 md:space-y-6 messages-container transition-smooth"
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
                <div key={message.id} data-message-id={message.id} className="animate-fade-in-fast space-y-2">
                  <ChatMessage
                    message={message}
                    showMessageTokenUsage={showMessageTokenUsage}
                    isEditing={isEditingMessage}
                    editingDraft={editingDraft}
                    editingBusy={editingBusy}
                    onChangeEditDraft={onChangeEditDraft}
                    onCancelEdit={onCancelEdit}
                    onSubmitEdit={onSubmitEdit}
                    AgentIcon={AgentIcon}
                    currentAgent={currentAgent}
                    resolveMessageAgent={resolveMessageAgent}
                    copiedId={copiedId}
                    onCopy={onCopy}
                    onLike={onLike}
                    onDislike={onDislike}
                    onReportMessage={onReportMessage}
                    conversationIsReported={conversationIsReported}
                    toast={toast}
                    onRetryMessage={onRetryMessage}
                    onForkMessage={onForkMessage}
                    onShareMessage={onShareMessage}
                    onReadAloud={onReadAloud}
                    speakingMessageId={speakingMessageId}
                    readOnly={readOnly}
                    isStreaming={isStreaming}
                    onFlashUserActionBar={onFlashUserActionBar}
                    onRequestEdit={onRequestEdit}
                    userActionVisibilityClass={userActionVisibilityClass}
                    thinkingState={thinkingState}
                    expandedThinking={expandedThinking}
                    onToggleThinking={onToggleThinking}
                    activeBranchPath={activeBranchPath}
                    streamingMessageId={streamingMessageId}
                    liveTimeline={streamingMessageId === message.id ? liveTimeline : null}
                    isImageFile={isImageFile}
                    onDownloadAttachment={onDownloadAttachment}
                    onPreviewAttachment={onPreviewAttachment}
                    onImageClick={onImageClick}
                    branchData={{
                      parentId,
                      options: branchOptions,
                      selectionIndex: branchSelection,
                      onSelectBranch: handleSelectBranch,
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
      {!loadingConversation && (
        <ConversationRail messages={messages} viewportRef={viewportRef} columnRef={columnRef} />
      )}
      <button
        type="button"
        aria-label="Jump to latest message"
        title="Jump to latest message"
        onClick={handleJumpToBottom}
        className={cn(
          "absolute bottom-4 left-1/2 z-20 flex h-10 w-10 -translate-x-1/2 items-center justify-center rounded-full",
          "border border-border/70 bg-background/85 text-foreground shadow-lg shadow-black/20 backdrop-blur-md",
          "transition-[opacity,transform,background-color,color] duration-500 ease-out hover:bg-background/92 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          showJumpToBottom
            ? "translate-y-0 scale-100 opacity-100"
            : "pointer-events-none translate-y-4 scale-90 opacity-0"
        )}
      >
        <ArrowDown className="h-5 w-5" aria-hidden="true" />
      </button>
    </div>
  );
}


