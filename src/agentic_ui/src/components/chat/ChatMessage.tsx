import { useMemo, useState } from "react";
import { Card } from "@/shared/ui/card";
import { Button } from "@/shared/ui/button";
import type { Agent, MessageOut, RunTimeline, ThinkingState } from "@/shared/lib/types";
import type { LucideIcon } from "lucide-react";
import { Check, X as CloseIcon } from "lucide-react";
import { AIActionBar, UserActionBar } from "./message_parts/ActionBars";
import { MessageAttachments } from "./message_parts/MessageAttachments";
import { MessageContent } from "./message_parts/Content";
import { PlanSidePanel, SubagentsSidePanel } from "./message_parts/RunSidePanels";
import { AgentRunTimeline } from "./AgentRunTimeline";
import { useRunTimeline } from "@/runtime";
import { ShimmeringText } from "@/shared/ui/shadcn-io/shimmering-text";

type ChatMessageProps = {
  message: MessageOut;
  showMessageTokenUsage?: boolean;
  isEditing: boolean;
  editingDraft?: string;
  editingBusy?: boolean;
  onChangeEditDraft?: (value: string) => void;
  onCancelEdit?: () => void;
  onSubmitEdit?: () => void;
  AgentIcon: LucideIcon;
  currentAgent?: Agent;
  resolveMessageAgent?: (message: MessageOut) => { name: string; Icon: LucideIcon };
  copiedId: string | null;
  onCopy: (content: string, messageId: string) => void;
  onLike: (message: MessageOut) => void;
  onDislike: (message: MessageOut) => void;
  onReportMessage?: (message: MessageOut) => void;
  conversationIsReported?: boolean;
  toast?: (opts: { title: string; description?: string; variant?: string; duration?: number }) => void;
  onRetryMessage?: (message: MessageOut) => void;
  onForkMessage?: (message: MessageOut) => void;
  onShareMessage?: (message: MessageOut) => void;
  onReadAloud?: (message: MessageOut) => void;
  speakingMessageId?: string | null;
  readOnly?: boolean;
  isStreaming?: boolean;
  onFlashUserActionBar: (messageId: string) => void;
  onRequestEdit?: (message: MessageOut) => void;
  userActionVisibilityClass: string;
  thinkingState?: ThinkingState | null;
  expandedThinking: Record<string, boolean>;
  onToggleThinking: (key: string, next?: boolean) => void;
  activeBranchPath?: string[];
  streamingMessageId?: string | null;
  // The in-flight run's incrementally-folded timeline; only the streaming
  // target message renders from it, every other message replays its own
  // persisted event log via useRunTimeline.
  liveTimeline?: RunTimeline | null;
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
  showMessageTokenUsage = false,
  isEditing,
  editingDraft,
  editingBusy,
  onChangeEditDraft,
  onCancelEdit,
  onSubmitEdit,
  AgentIcon,
  currentAgent,
  resolveMessageAgent,
  copiedId,
  onCopy,
  onLike,
  onDislike,
  onReportMessage,
  conversationIsReported = false,
  toast,
  onRetryMessage,
  onForkMessage,
  onShareMessage,
  onReadAloud,
  speakingMessageId,
  readOnly = false,
  isStreaming,
  onFlashUserActionBar,
  onRequestEdit,
  userActionVisibilityClass,
  thinkingState = null,
  expandedThinking,
  onToggleThinking,
  activeBranchPath,
  streamingMessageId,
  liveTimeline = null,
  isImageFile,
  onDownloadAttachment,
  onPreviewAttachment,
  onImageClick,
  branchData,
}: ChatMessageProps) {
  const isUser = message.sender === "user";
  const isAi = message.sender === "ai";
  const isTempUserMessage = isUser && String(message.id ?? "").startsWith("temp-");
  const [openRunPanel, setOpenRunPanel] = useState<"plan" | "subagents" | null>(null);
  // Per-message agent for the AI action bar. With a resolver (main chat) we get
  // catalog name + icon; without one (e.g. shared view) we fall back to the
  // denormalized per-message agentName and the conversation's icon.
  const aiAgent = resolveMessageAgent
    ? resolveMessageAgent(message)
    : { name: message.agentName ?? currentAgent?.name ?? "Unknown agent", Icon: AgentIcon };
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

  const isStreamingThisMessage = Boolean(
    isAi && isStreaming && streamingMessageId && streamingMessageId === message.id
  );
  const isStreamingTarget = Boolean(
    isStreamingThisMessage && thinkingState?.isActive && branchPathActive
  );

  const settledTimeline = useRunTimeline(isAi ? message : null);
  const timeline = isStreamingThisMessage && liveTimeline ? liveTimeline : settledTimeline;

  const showAttachments = Array.isArray(message.attachments) && message.attachments.length > 0;
  const showActionBar = isAi ? !(isStreamingTarget || isStreamingThisMessage) : !isTempUserMessage && !isEditing;
  const showUserSending = isTempUserMessage && !isEditing;

  const planForPanel = !isStreamingThisMessage && timeline?.terminal ? timeline.plan : null;
  const subagentCount = !isStreamingThisMessage && timeline?.terminal ? timeline.subagentCount : 0;

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

      <Card className={bubbleClass}>
        <div className="space-y-3 min-w-0">
          {isUser ? (
            <MessageContent
              message={message}
              isEditing={isEditing}
              editingDraft={editingDraft}
              editingBusy={editingBusy}
              onChangeEditDraft={onChangeEditDraft}
              onCancelEdit={onCancelEdit}
              onSubmitEdit={onSubmitEdit}
            />
          ) : timeline ? (
            <AgentRunTimeline
              timeline={timeline}
              runId={message.id}
              isStreaming={isStreamingThisMessage}
              fallbackThinkingSeconds={message.thinkingTime ?? null}
              expandedThinking={expandedThinking}
              onToggleThinking={onToggleThinking}
            />
          ) : null}

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
                    showMessageTokenUsage={showMessageTokenUsage}
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
                    branchControls={branchData}
                    agentName={aiAgent.name}
                    AgentIcon={aiAgent.Icon}
                    timestampLabel={timestampLabel}
                    onOpenPlan={planForPanel ? () => setOpenRunPanel("plan") : undefined}
                    onOpenSubagents={subagentCount > 0 ? () => setOpenRunPanel("subagents") : undefined}
                    subagentCount={subagentCount}
                  />
                </div>
              )
            )}
          </div>
        </div>
      </Card>

      {planForPanel ? (
        <PlanSidePanel
          plan={planForPanel}
          open={openRunPanel === "plan"}
          onOpenChange={(open) => setOpenRunPanel(open ? "plan" : null)}
        />
      ) : null}
      {timeline && subagentCount > 0 ? (
        <SubagentsSidePanel
          timeline={timeline}
          open={openRunPanel === "subagents"}
          onOpenChange={(open) => setOpenRunPanel(open ? "subagents" : null)}
        />
      ) : null}

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
            onRequestEdit={readOnly ? undefined : onRequestEdit}
            branchControls={branchData}
            className={`mt-2 ${userActionVisibilityClass}`}
          />
        )
      )}
    </div>
  );
}
