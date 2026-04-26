import { useMemo } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { Agent, MessageOut, ThinkingState } from "@/lib/types";
import type { LucideIcon } from "lucide-react";
import { Check, X as CloseIcon } from "lucide-react";
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
} from "@/components/ui/ai-elements/chain-of-thought";
import { AIActionBar, UserActionBar } from "./message_parts/ActionBars";
import { MessageAttachments } from "./message_parts/MessageAttachments";
import { CoT, buildCoTSteps } from "./message_parts/ChainOfThought";
import { MessageContent } from "./message_parts/MessageContent";
import { ShimmeringText } from "@/components/ui/shadcn-io/shimmering-text";

type ChatMessageProps = {
  message: MessageOut;
  isEditing: boolean;
  editingDraft?: string;
  editingBusy?: boolean;
  onChangeEditDraft?: (value: string) => void;
  onCancelEdit?: () => void;
  onSubmitEdit?: () => void;
  AgentIcon: LucideIcon;
  currentAgent?: Agent;
  copiedId: string | null;
  onCopy: (content: string, messageId: string) => void;
  onLike: (message: MessageOut) => void;
  onDislike: (message: MessageOut) => void;
  onReportMessage?: (message: MessageOut) => void;
  conversationIsReported?: boolean;
  toast?: (opts: { title: string; description?: string; variant?: string; duration?: number }) => void;
  onRetryMessage?: (message: MessageOut) => void;
  onForkMessage?: (message: MessageOut) => void;
  isStreaming?: boolean;
  onFlashUserActionBar: (messageId: string) => void;
  onRequestEdit?: (message: MessageOut) => void;
  userActionVisibilityClass: string;
  thinkingState?: ThinkingState | null;
  expandedThinking: Record<string, boolean>;
  onToggleThinking: (messageId: string) => void;
  activeBranchPath?: string[];
  streamingMessageId?: string | null;
  isImageFile: (attachment: any) => boolean;
  onDownloadAttachment: (attachment: any, message: MessageOut) => void;
  onPreviewAttachment: (attachment: any, message: MessageOut) => void;
  onImageClick: (url: string) => void;
  branchData: {
    parentId: string | null;
    options?: MessageOut[];
    selectionIndex: number;
    onSelectBranch?: (parentId: string | null, branchIndex: number) => void;
  };
};

export function ChatMessage({
  message,
  isEditing,
  editingDraft,
  editingBusy,
  onChangeEditDraft,
  onCancelEdit,
  onSubmitEdit,
  AgentIcon,
  currentAgent,
  copiedId,
  onCopy,
  onLike,
  onDislike,
  onReportMessage,
  conversationIsReported = false,
  toast,
  onRetryMessage,
  onForkMessage,
  isStreaming,
  onFlashUserActionBar,
  onRequestEdit,
  userActionVisibilityClass,
  thinkingState = null,
  expandedThinking,
  onToggleThinking,
  activeBranchPath,
  streamingMessageId,
  isImageFile,
  onDownloadAttachment,
  onPreviewAttachment,
  onImageClick,
  branchData,
}: ChatMessageProps) {
  const isUser = message.sender === "user";
  const isAi = message.sender === "ai";
  const isTempUserMessage = isUser && String(message.id ?? "").startsWith("temp-");
  const bubbleClass = isUser
    ? `p-5 bg-chat-user text-chat-user-foreground ml-auto shadow-card border-border ${
        isEditing ? "w-full max-w-full" : "max-w-[85%] md:max-w-[75%]"
      }`
    : "bg-gradient-card text-card-foreground bg-transparent shadow-none border-transparent w-full max-w-full";

  const branchPathActive = useMemo(() => {
    if (!thinkingState?.branchPath || !activeBranchPath) return false;
    const branch = thinkingState.branchPath;
    if (activeBranchPath.length < branch.length) return false;
    for (let i = 0; i < branch.length; i += 1) {
      if (branch[i] !== activeBranchPath[i]) return false;
    }
    return true;
  }, [thinkingState?.branchPath, activeBranchPath]);

  const isStreamingTarget = Boolean(
    isAi &&
      isStreaming &&
      thinkingState?.isActive &&
      branchPathActive &&
      streamingMessageId &&
      streamingMessageId === message.id
  );

  const liveThoughts = thinkingState && isStreamingTarget ? thinkingState.thoughts : [];
  const liveActiveIndex = thinkingState
    ? Math.min(Math.max(thinkingState.currentThoughtIndex ?? -1, -1), (thinkingState.thoughts?.length ?? 0) - 1)
    : -1;
  const showLiveCoT = isStreamingTarget && Boolean(liveThoughts?.length);
  const showStoredCoT = isAi && Array.isArray(message.thinking) && message.thinking.length > 0;
  const showAttachments = Array.isArray(message.attachments) && message.attachments.length > 0;
  const isStreamingThisMessage = Boolean(
    isAi && isStreaming && streamingMessageId && streamingMessageId === message.id
  );
  const showActionBar = isAi ? !(isStreamingTarget || isStreamingThisMessage) : !isTempUserMessage && !isEditing;
  const showUserSending = isTempUserMessage && !isEditing;

  const timestampLabel = useMemo(
    () =>
      message.created_at.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
    [message.created_at]
  );

  return (
    <div className={`space-y-2 md:space-y-2 ${isUser ? "flex flex-col items-end" : ""} group/message`}>
      {showAttachments && (
        <MessageAttachments
          message={message}
          isImageFile={isImageFile}
          onDownloadAttachment={onDownloadAttachment}
          onPreviewAttachment={onPreviewAttachment}
          onImageClick={onImageClick}
        />
      )}

      {showStoredCoT && (
        <CoT
          message={message}
          isOpen={Boolean(expandedThinking[message.id])}
          onToggle={() => onToggleThinking(message.id)}
        />
      )}

      {showLiveCoT && thinkingState && (
        <ChainOfThought
          key={`live-${message.id}-${thinkingState.startTime ?? "active"}`}
          className="max-w-[85%] md:max-w-[85%] w-full space-y-2"
          open={expandedThinking[message.id] ?? true}
          onOpenChange={() => onToggleThinking(message.id)}
        >
          <ChainOfThoughtHeader className="text-sm md:text-[0.95rem] font-medium text-muted-foreground">
            <ShimmeringText
              text="Reasoning..."
              duration={1.1}
              pause={1.4}
              color="hsl(var(--muted-foreground))"
              shimmeringColor="#2b2d36"
              className="text-sm md:text-[0.95rem] font-medium"
            />
          </ChainOfThoughtHeader>
          <ChainOfThoughtContent className="[&>div:last-child>div:first-child>div:last-child]:hidden">
            {buildCoTSteps(liveThoughts, {
              activeIndex: liveActiveIndex,
              isComplete: thinkingState.isDone && !thinkingState.isActive,
            })}
          </ChainOfThoughtContent>
        </ChainOfThought>
      )}

      <Card className={bubbleClass}>
        <div className="space-y-3 min-w-0">
          <MessageContent
            message={message}
            isEditing={isEditing}
            editingDraft={editingDraft}
            editingBusy={editingBusy}
            onChangeEditDraft={onChangeEditDraft}
            onCancelEdit={onCancelEdit}
            onSubmitEdit={onSubmitEdit}
          />

          <div className="text-sm">
            {isUser ? (
              <div className="flex items-center justify-between">
                <span className="opacity-70">
                  {message.created_at.toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
                {isEditing && (
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      className="gap-1 bg-[#262730] text-foreground hover:bg-[#2f3038]"
                      disabled={editingBusy}
                      onClick={() => onCancelEdit?.()}
                    >
                      <CloseIcon className="h-4 w-4" />
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      className="gap-1 bg-primary text-primary-foreground hover:bg-primary/90"
                      disabled={editingBusy || isStreaming}
                      onClick={() => onSubmitEdit?.()}
                    >
                      <Check className="h-4 w-4" />
                      Submit
                    </Button>
                  </div>
                )}
              </div>
            ) : (
              !isStreamingThisMessage &&
              showActionBar && (
                <div className="flex w-full flex-wrap items-center gap-2">
                  <AIActionBar
                    message={message}
                    copiedId={copiedId}
                    onCopy={onCopy}
                    onLike={onLike}
                    onDislike={onDislike}
                    onReportMessage={onReportMessage}
                    conversationIsReported={conversationIsReported}
                    toast={toast}
                    onRetryMessage={onRetryMessage}
                    onForkMessage={onForkMessage}
                    isStreaming={isStreaming}
                    branchControls={branchData}
                    agentName={currentAgent?.name ?? "Unknown agent"}
                    AgentIcon={AgentIcon}
                    timestampLabel={timestampLabel}
                  />
                </div>
              )
            )}
          </div>
        </div>
      </Card>

      {showUserSending ? (
        <div className="mt-2 text-right">
          <ShimmeringText
            text="sending"
            className="text-xs font-medium uppercase tracking-wide"
            color="hsl(var(--muted-foreground))"
            shimmeringColor="#2b2d36"
            duration={1.1}
            pause={1.4}
          />
        </div>
      ) : (
        isUser &&
        !isEditing && (
          <UserActionBar
            message={message}
            copiedId={copiedId}
            onCopy={onCopy}
            onFlashUserActionBar={onFlashUserActionBar}
            toast={toast}
            onRequestEdit={onRequestEdit}
            branchControls={branchData}
            className={`mt-2 ${userActionVisibilityClass}`}
          />
        )
      )}
    </div>
  );
}
