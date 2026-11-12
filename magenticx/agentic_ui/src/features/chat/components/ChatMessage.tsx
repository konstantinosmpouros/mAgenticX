import { useMemo, useState } from "react";
import { Card } from "@/shared/ui/card";
import { Button } from "@/shared/ui/button";
import type { Agent, MessageOut, RunTimeline, ThinkingState } from "@/shared/lib/types";
import type { LucideIcon } from "lucide-react";
import { Check, X as CloseIcon } from "lucide-react";
import { AIActionBar, UserActionBar } from "./message_parts/ActionBars";
import { answerGroupText, type AnswerGroupPlace } from "@/features/chat/lib/answerGroups";
import { MessageAttachments } from "./message_parts/MessageAttachments";
import { MessageContent } from "./message_parts/Content";
import { PlanSidePanel, SubagentsSidePanel } from "./message_parts/RunSidePanels";
import { MessageTaskTree } from "./message_parts/MessageTaskTree";
import { AgentRunTimeline } from "./AgentRunTimeline";
import { useRunTimeline } from "@/features/inference";
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
  /** Fetches an attachment's bytes (a generated image shown inline). */
  onLoadAttachment?: (attachment: any, message: MessageOut) => Promise<Blob>;
  onPreviewAttachment: (attachment: any, message: MessageOut) => void;
  onImageClick: (url: string) => void;
  branchData: BranchData;
  /** The answer group this assistant message belongs to (lib/answerGroups). */
  answerGroup?: AnswerGroupPlace;
  /** The branch switcher the group's bar shows: the alternatives of the whole
   *  answer, which a "Try again" creates at the group's first message. */
  groupBranchData?: BranchData;
};

type BranchData = {
  parentId: string | null;
  options?: MessageOut[];
  selectionIndex: number;
  onSelectBranch?: (parentId: string | null, branchIndex: number) => void;
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
  onLoadAttachment,
  onPreviewAttachment,
  onImageClick,
  branchData,
  answerGroup,
  groupBranchData,
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
    ? `chat-user-bubble p-5 bg-chat-user text-chat-user-foreground ml-auto shadow-card border-border ${
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
    isAi && isStreaming && streamingMessageId && streamingMessageId === message.id,
  );
  const isStreamingTarget = Boolean(
    isStreamingThisMessage && thinkingState?.isActive && branchPathActive,
  );

  const settledTimeline = useRunTimeline(isAi ? message : null);
  const timeline = isStreamingThisMessage && liveTimeline ? liveTimeline : settledTimeline;

  const showAttachments = Array.isArray(message.attachments) && message.attachments.length > 0;
  const showActionBar = isAi
    ? !(isStreamingTarget || isStreamingThisMessage)
    : !isTempUserMessage && !isEditing;
  const showUserSending = isTempUserMessage && !isEditing;

  const planForPanel = !isStreamingThisMessage && timeline?.terminal ? timeline.plan : null;
  const subagentCount = !isStreamingThisMessage && timeline?.terminal ? timeline.subagentCount : 0;

  // One bar per answer group, on its last message (lib/answerGroups): Try again
  // regenerates the whole answer from its first message, Copy takes every part,
  // Fork and the rest act on this (last) message so nothing is left out.
  const group = isAi && answerGroup && answerGroup.group.members.length > 1 ? answerGroup : null;
  const carriesActionBar = !group || group.isTail;
  const groupHead = group?.group.head;
  const handleGroupRetry =
    onRetryMessage && groupHead ? () => onRetryMessage(groupHead) : onRetryMessage;
  const handleGroupCopy = group
    ? (_content: string, messageId: string) => onCopy(answerGroupText(group.group), messageId)
    : onCopy;

  const timestampLabel = useMemo(
    () =>
      message.created_at.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
    [message.created_at],
  );

  // The live reply before the agent's first block: nothing to show yet. The
  // thinking orb under the conversation (AiTransitionIndicator) stands in for
  // it, and the empty row collapses (ChatBody) so the answer, when it comes,
  // starts where the orb is.
  if (isStreamingThisMessage && (timeline?.blocks.length ?? 0) === 0 && !showAttachments) {
    return null;
  }

  return (
    <div
      className={`space-y-2 md:space-y-2 ${isUser ? "flex flex-col items-end" : ""} group/message`}
    >
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
          ) : timeline && !(isStreamingThisMessage && timeline.blocks.length === 0) ? (
            // While the run's reply is live but the agent hasn't emitted its
            // first block yet (transition phase), render nothing — the thinking
            // orb below is the only "something is happening" signal. Rendering
            // here too would double up ("Reasoning…" + orb).
            <AgentRunTimeline
              timeline={timeline}
              runId={message.id}
              isStreaming={isStreamingThisMessage}
              fallbackThinkingSeconds={message.thinkingTime ?? null}
              expandedThinking={expandedThinking}
              onToggleThinking={onToggleThinking}
              message={message}
              onDownloadAttachment={onDownloadAttachment}
              onLoadAttachment={onLoadAttachment}
              onPreviewAttachment={onPreviewAttachment}
            />
          ) : null}

          {/* The background tasks this answer started (plan 41), live for as
              long as they run — whatever the chat has done since. */}
          {isAi ? <MessageTaskTree message={message} timeline={timeline ?? null} /> : null}

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
                    {/* `secondary`, not a hardcoded surface: this sat on a raw
                        #262730, which reads as a dark chip in BOTH themes — so in
                        light mode it was dark `text-foreground` on dark grey. */}
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      className="gap-1"
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
              showActionBar &&
              // An earlier part of a grouped answer has no bar of its own.
              carriesActionBar && (
                <div className="flex w-full flex-wrap items-center gap-2">
                  <AIActionBar
                    message={message}
                    showMessageTokenUsage={showMessageTokenUsage}
                    copiedId={copiedId}
                    onCopy={handleGroupCopy}
                    onLike={onLike}
                    onDislike={onDislike}
                    onReportMessage={onReportMessage}
                    conversationIsReported={conversationIsReported}
                    onRetryMessage={handleGroupRetry}
                    onForkMessage={onForkMessage}
                    onShareMessage={onShareMessage}
                    onReadAloud={onReadAloud}
                    speakingMessageId={speakingMessageId}
                    readOnly={readOnly}
                    isStreaming={isStreaming}
                    branchControls={group ? (groupBranchData ?? branchData) : branchData}
                    agentName={aiAgent.name}
                    AgentIcon={aiAgent.Icon}
                    timestampLabel={timestampLabel}
                    onOpenPlan={planForPanel ? () => setOpenRunPanel("plan") : undefined}
                    onOpenSubagents={
                      subagentCount > 0 ? () => setOpenRunPanel("subagents") : undefined
                    }
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
          timings={timeline?.planTimings}
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
            onRequestEdit={readOnly ? undefined : onRequestEdit}
            branchControls={branchData}
            className={`mt-2 ${userActionVisibilityClass}`}
          />
        )
      )}
    </div>
  );
}
