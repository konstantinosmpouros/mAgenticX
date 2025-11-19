import React from "react";
import type { ComponentType } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Response } from "@/components/ui/ai-elements/response";
import { Textarea } from "@/components/ui/textarea";
import {
  Branch,
  BranchMessages,
  BranchNext,
  BranchPage,
  BranchPrevious,
  BranchSelector,
} from "@/components/ui/shadcn-io/branch";
import {
  ChainOfThought,
  ChainOfThoughtHeader,
  ChainOfThoughtContent,
  ChainOfThoughtStep,
} from "@/components/ui/ai-elements/chain-of-thought";
import { MarkdownRenderer } from "@/components/ui/markdownRenderer";
import { ShimmeringText } from "@/components/ui/shadcn-io/shimmering-text";
import {
  Download,
  FileText,
  Copy,
  Check,
  ThumbsDown,
  ThumbsUp,
  Wrench,
  CheckCircle2,
  Pencil,
  X as CloseIcon,
} from "lucide-react";
import { VscEye } from "react-icons/vsc";
import { BsArrowRepeat } from "react-icons/bs";
import { LuFlag } from "react-icons/lu";
import type { LucideIcon } from "lucide-react";
import type {
  Agent,
  AttachmentIn,
  FileAttachment,
  MessageOut,
  ThinkingState,
} from "@/lib/types";

type AttachmentLike =
  | AttachmentIn
  | FileAttachment
  | File
  | string
  | Record<string, unknown>;

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

const toolPrefix = /^\s*\[tool\]\s*/i;

const formatThinkingDuration = (thinkingTime?: number) => {
  if (typeof thinkingTime !== "number" || Number.isNaN(thinkingTime)) {
    return null;
  }
  const minutes = Math.floor(thinkingTime / 60);
  const seconds = thinkingTime % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
};

type ThoughtStepOptions = {
  activeIndex: number;
  isComplete: boolean;
};

const buildChainOfThoughtSteps = (
  thoughts: string[],
  { activeIndex, isComplete }: ThoughtStepOptions
): React.ReactNode => {
  const normalizedIndex = Math.min(
    Math.max(activeIndex ?? -1, -1),
    thoughts.length - 1
  );

  const steps: React.ReactNode[] = thoughts.map((raw, index) => {
    const text = String(raw ?? "");
    const isTool = toolPrefix.test(text);
    const cleanText = text.replace(toolPrefix, "").trim();
    const status: "complete" | "active" | "pending" = isComplete
      ? "complete"
      : normalizedIndex < 0
      ? "pending"
      : index < normalizedIndex
      ? "complete"
      : index === normalizedIndex
      ? "active"
      : "pending";

    const labelSegments = [`Step ${index + 1}`];
    if (isTool) {
      labelSegments.push("Tool");
    }

    return (
      <ChainOfThoughtStep
        key={`cot-step-${index}`}
        icon={isTool ? Wrench : undefined}
        label={labelSegments.join(" · ")}
        status={status}
        className="text-sm"
      >
        <MarkdownRenderer
          content={cleanText || "Working..."}
          className="text-muted-foreground text-sm leading-relaxed"
        />
      </ChainOfThoughtStep>
    );
  });

  if (isComplete) {
    steps.push(
      <ChainOfThoughtStep
        key="cot-step-complete"
        icon={CheckCircle2}
        label="Completed"
        status="complete"
        className="text-sm"
      />
    );
  }

  return steps.length ? steps : null;
};

const isBranchPathActive = (branchPath?: string[], activePath?: string[]) => {
  if (!branchPath || branchPath.length === 0) {
    return true;
  }
  if (!activePath || activePath.length < branchPath.length) {
    return false;
  }
  for (let i = 0; i < branchPath.length; i += 1) {
    if (branchPath[i] !== activePath[i]) {
      return false;
    }
  }
  return true;
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
  const lastRunStartRef = React.useRef<number | null>(null);
  const [liveThinkingOpen, setLiveThinkingOpen] = React.useState(false);

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

  React.useEffect(() => {
    if (!thinkingState) {
      lastRunStartRef.current = null;
      setLiveThinkingOpen(false);
      return;
    }

    const runKey = thinkingState.startTime ?? null;
    if (runKey !== null && runKey !== lastRunStartRef.current) {
      lastRunStartRef.current = runKey;
      if (thinkingState.isActive) {
        setLiveThinkingOpen(true);
      }
      return;
    }

    if (!thinkingState.isActive && thinkingState.isDone) {
      setLiveThinkingOpen(false);
    }
  }, [thinkingState]);

  const renderBranchControls = React.useCallback(
    (
      parentId: string | null,
      options: MessageOut[] | undefined,
      selectionIndex: number,
      role: "assistant" | "user"
    ) => {
      if (!options || options.length <= 1) return null;
      const clampedIndex = Math.min(Math.max(selectionIndex, 0), options.length - 1);
      const branchKey = `${parentId ?? "root"}-${options.length}-${options.map((option) => option.id).join("-")}${
        role
      }-${clampedIndex}`;

      return (
        <Branch
          key={branchKey}
          defaultBranch={clampedIndex}
          onBranchChange={(idx) => onSelectBranch?.(parentId, idx)}
          className="inline-flex items-center gap-1"
        >
          <BranchMessages className="hidden">
            {options.map((child) => (
              <div key={child.id} />
            ))}
          </BranchMessages>
          <BranchSelector
            from={role}
            className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground/80 px-0"
          >
            <BranchPrevious className="h-6 w-6 text-muted-foreground hover:text-foreground hover:bg-muted/60" />
            <BranchPage className="mx-0" />
            <BranchNext className="h-6 w-6 text-muted-foreground hover:text-foreground hover:bg-muted/60" />
          </BranchSelector>
        </Branch>
      );
    },
    [onSelectBranch]
  );

  const liveThoughts =
    thinkingState && thinkingState.thoughts.length
      ? thinkingState.thoughts.slice(
          0,
          Math.max(
            0,
            Math.min(
              (thinkingState.currentThoughtIndex ?? -1) + 1,
              thinkingState.thoughts.length
            )
          )
        )
      : [];

  const liveActiveIndex = thinkingState
    ? Math.min(
        Math.max(thinkingState.currentThoughtIndex ?? -1, -1),
        liveThoughts.length - 1
      )
    : -1;

  const isViewingThinkingBranch = isBranchPathActive(
    thinkingState?.branchPath,
    activeBranchPath
  );

  const shouldShowLiveChain =
    Boolean(thinkingState) &&
    isViewingThinkingBranch &&
    (thinkingState.isActive || liveThinkingOpen);

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

              return (
                <div key={message.id} className="animate-fade-in-fast space-y-2">
                {message.attachments && message.attachments.length > 0 && (
                  <div className={`${message.sender === 'user' ? 'flex justify-end' : ''}`}>
                    <div className="max-w-[85%] md:max-w-[85%]">
                      {(() => {
                        const items = message.attachments.map((attachment: any) => {
                          const isImage = isImageFile(attachment);
                          let imageUrl = '';
                          let fileName = '';
                          if (typeof attachment === 'string') {
                            imageUrl = attachment;
                            fileName = attachment;
                          } else if ('data' in attachment && attachment.data) {
                            imageUrl = `data:${attachment.mime};base64,${attachment.data}`;
                            fileName = attachment.name;
                          } else if ('url' in attachment && (attachment as any).url) {
                            imageUrl = (attachment as any).url;
                            fileName = (attachment as any).name;
                          } else if ('file' in attachment && (attachment as any).file) {
                            imageUrl = URL.createObjectURL((attachment as any).file);
                            fileName = (attachment as any).name;
                          } else {
                            imageUrl = '';
                            fileName = 'name' in attachment ? (attachment as any).name : 'Unknown file';
                          }
                          const typeLabel =
                            'mime' in attachment && (attachment as any).mime
                              ? (attachment as any).mime
                              : isImage
                                ? 'Image'
                                : 'File';
                          return { attachment, isImage, imageUrl, fileName, typeLabel };
                        });
                        const images = items.filter((item) => item.isImage);
                        const files = items.filter((item) => !item.isImage);
                        return (
                          <div className="flex flex-col items-end space-y-3">
                            {files.length > 0 && (
                              <div className="flex flex-col gap-2 w-fit self-end">
                                {files.map((fileItem, index) => (
                                  <div key={`file-${index}`} className="text-xs self-end">
                                    <div
                                      className="group relative cursor-pointer bg-muted/20 hover:bg-muted/30 border border-border/30 rounded-2xl px-3 py-3 transition-all duration-200 hover:shadow-md w-64 md:w-80"
                                      onClick={() => onDownloadAttachment(fileItem.attachment as any, message)}
                                    >
                                      <div className="flex items-center gap-3">
                                        <div className="w-10 h-10 rounded-xl bg-primary/90 text-primary-foreground flex items-center justify-center">
                                          <FileText size={16} />
                                        </div>
                                        <div className="min-w-0 flex-1">
                                          <div className="font-medium text-foreground/90 truncate w-full">
                                            {fileItem.fileName}
                                          </div>
                                          <div className="text-muted-foreground/70 truncate w-full">
                                            {fileItem.typeLabel}
                                          </div>
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
                                  <div
                                    key={`img-${idx}`}
                                    className={`${
                                      images.length % 2 === 1 && idx === images.length - 1 ? 'col-span-2' : ''
                                    }`}
                                  >
                                    <div
                                      className="relative group cursor-pointer"
                                      onClick={() => onImageClick(img.imageUrl)}
                                    >
                                      <img
                                        src={img.imageUrl}
                                        alt="Image"
                                        className="w-full h-28 md:h-32 object-cover rounded-xl border border-0 transition-all hover:scale-[1.02] hover:shadow-lg"
                                      />
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

                {(message.content || isEditingMessage) && (
                  <div
                    className={`space-y-2 md:space-y-2 ${
                      message.sender === 'user' ? 'flex flex-col items-end' : ''
                    } group/message`}
                  >
                    {message.thinking && message.sender === 'ai' && (
                      <ChainOfThought
                        className="max-w-[85%] md:max-w-[85%] w-full space-y-2"
                        open={Boolean(expandedThinking[message.id])}
                        onOpenChange={(open) => {
                          const isOpen = Boolean(expandedThinking[message.id]);
                          if (open !== isOpen) {
                            onToggleThinking(message.id);
                          }
                        }}
                      >
                        <ChainOfThoughtHeader className="text-sm md:text-[0.95rem] font-medium text-muted-foreground hover:text-foreground">
                          {(() => {
                            const durationLabel = formatThinkingDuration(message.thinkingTime);
                            return durationLabel ? (
                              `Thought for ${durationLabel}`
                            ) : (
                              <ShimmeringText
                                text="Reasoning..."
                                duration={1.1}
                                pause={1.4}
                                color="hsl(var(--muted-foreground))"
                                shimmeringColor="#2b2d36"
                                className="text-sm md:text-[0.95rem] font-medium"
                              />
                            );
                          })()}
                        </ChainOfThoughtHeader>
                        <ChainOfThoughtContent className="[&>div:last-child>div:first-child>div:last-child]:hidden">
                          {buildChainOfThoughtSteps(message.thinking!, {
                            activeIndex: message.thinking!.length - 1,
                            isComplete: true,
                          })}
                        </ChainOfThoughtContent>
                      </ChainOfThought>
                    )}

                    <Card
                      className={`${
                        message.sender === 'user'
                          ? `p-5 bg-chat-user text-chat-user-foreground ml-auto shadow-card border-border ${
                              isEditingMessage ? 'w-full max-w-full' : 'max-w-[85%] md:max-w-[75%]'
                            }`
                          : 'bg-gradient-card text-card-foreground bg-transparent shadow-none border-transparent max-w-[85%] md:max-w-[85%]'
                      }`}
                    >
                      <div className="space-y-3 min-w-0">
                        {isEditingMessage ? (
                          <Textarea
                            value={editingDraft ?? ""}
                            onChange={(event) => onChangeEditDraft?.(event.target.value)}
                            disabled={editingBusy}
                            autoFocus
                            className="w-full min-h-[6rem] resize-none bg-transparent text-inherit border-none p-0 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:border-none focus-visible:outline-none"
                          />
                        ) : (
                          <Response>{message.content ?? ""}</Response>
                        )}
                        <div
                          className={`text-sm opacity-70 flex items-center gap-2 ${
                            message.sender === 'ai' ? 'flex-wrap' : ''
                          }`}
                        >
                          <div className="flex items-center gap-2 flex-wrap">
                            <span>
                              {message.created_at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </span>
                            {message.sender === 'ai' && (
                              <>
                                <span className="flex items-center gap-1">
                                  <AgentIcon size={14} />
                                  {currentAgent?.name ?? "Unknown agent"}
                                </span>

                                <div className="flex items-center gap-0.5">
                                  <div className="mt-1">
                                    <Tooltip delayDuration={0}>
                                      <TooltipTrigger asChild>
                                        <Button
                                          variant="ghost"
                                          size="icon"
                                          className="
                                            h-8 w-8 text-muted-foreground
                                            hover:bg-muted/60 hover:!text-muted-foreground
                                            active:!bg-muted/70 active:!text-muted-foreground
                                            focus:!bg-muted/60 focus:!text-muted-foreground focus:outline-none 
                                            focus:ring-0 focus-visible:ring-0 transition-colors
                                          "
                                          onMouseDown={(e) => e.preventDefault()}
                                          onClick={() => onCopy(message.content!, message.id)}
                                          aria-label={copiedId === message.id ? 'Copied' : 'Copy'}
                                        >
                                          <span className="relative inline-block h-4 w-4">
                                            <Copy
                                              className={`absolute inset-0 h-4 w-4 transition-all duration-200
                                                ${copiedId === message.id ? 'opacity-0 scale-75' : 'opacity-100 scale-100'}`}
                                            />
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

                                  {message.liked !== false && (
                                    <div className="mt-1">
                                      <Tooltip delayDuration={0}>
                                        <TooltipTrigger asChild>
                                          <Button
                                            variant="ghost"
                                            size="icon"
                                            className={`h-8 w-8 hover:bg-muted/60 ${
                                              message.liked === true
                                                ? 'text-[#de8bff] hover:!text-[#de8bff]'
                                                : 'text-muted-foreground hover:!text-muted-foreground'
                                            }`}
                                            onMouseDown={(e) => e.preventDefault()}
                                            onClick={() => onLike(message)}
                                            aria-label={message.liked === true ? 'Unlike' : 'Like'}
                                          >
                                            <ThumbsUp className="h-4 w-4" />
                                          </Button>
                                        </TooltipTrigger>
                                        <TooltipContent
                                          side="bottom"
                                          align="center"
                                          className="!opacity-100 bg-background text-foreground border border-border shadow-card px-2 py-1 rounded-md"
                                        >
                                          <p>Like</p>
                                        </TooltipContent>
                                      </Tooltip>
                                    </div>
                                  )}

                                  {message.liked !== true && (
                                    <div className="mt-1">
                                      <Tooltip delayDuration={0}>
                                        <TooltipTrigger asChild>
                                          <Button
                                            variant="ghost"
                                            size="icon"
                                            className={`h-8 w-8 hover:bg-muted/60 ${
                                              message.liked === false
                                                ? 'text-[#de8bff] hover:!text-[#de8bff]'
                                                : 'text-muted-foreground hover:!text-muted-foreground'
                                            }`}
                                            onMouseDown={(e) => e.preventDefault()}
                                            onClick={() => onDislike(message)}
                                            aria-label={message.liked === false ? 'Clear dislike' : 'Dislike'}
                                          >
                                            <ThumbsDown className="h-4 w-4" />
                                          </Button>
                                        </TooltipTrigger>
                                        <TooltipContent
                                          side="bottom"
                                          align="center"
                                          className="!opacity-100 bg-background text-foreground border border-border shadow-card px-2 py-1 rounded-md"
                                        >
                                          <p>Dislike</p>
                                        </TooltipContent>
                                      </Tooltip>
                                    </div>
                                  )}

                                  <div className="mt-1">
                                    <Tooltip delayDuration={0}>
                                      <TooltipTrigger asChild>
                                        <Button
                                          variant="ghost"
                                          size="icon"
                                          className="
                                            h-8 w-8 text-muted-foreground
                                            hover:bg-muted/60 hover:!text-muted-foreground
                                            active:!bg-muted/70 active:!text-muted-foreground
                                            focus:!bg-muted/60 focus:!text-muted-foreground focus:outline-none 
                                            focus:ring-0 focus-visible:ring-0 transition-colors
                                          "
                                          onMouseDown={(e) => e.preventDefault()}
                                          onClick={() =>
                                            toast?.({
                                              title: "Coming soon",
                                              description: "Report functionality will be available soon.",
                                            })
                                          }
                                          aria-label="Report message (coming soon)"
                                        >
                                          <LuFlag className="h-4 w-4" />
                                        </Button>
                                      </TooltipTrigger>
                                      <TooltipContent
                                        side="bottom"
                                        align="center"
                                        className="!opacity-100 bg-background text-foreground border border-border shadow-card px-2 py-1 rounded-md"
                                      >
                                        <p>Report</p>
                                      </TooltipContent>
                                    </Tooltip>
                                  </div>

                                  <div className="mt-1">
                                    <Tooltip delayDuration={0}>
                                      <TooltipTrigger asChild>
                                        <Button
                                          variant="ghost"
                                          size="icon"
                                          className="
                                            h-8 w-8 text-muted-foreground
                                            hover:bg-muted/60 hover:!text-muted-foreground
                                            active:!bg-muted/70 active:!text-muted-foreground
                                            focus:!bg-muted/60 focus:!text-muted-foreground focus:outline-none 
                                            focus:ring-0 focus-visible:ring-0 transition-colors
                                          "
                                          onMouseDown={(e) => e.preventDefault()}
                                          onClick={() => onRetryMessage?.(message)}
                                          disabled={!onRetryMessage || isStreaming}
                                          aria-label="Retry response"
                                        >
                                          <BsArrowRepeat className="h-4 w-4" />
                                        </Button>
                                      </TooltipTrigger>
                                      <TooltipContent
                                        side="bottom"
                                        align="center"
                                        className="!opacity-100 bg-background text-foreground border border-border shadow-card px-2 py-1 rounded-md"
                                      >
                                        <p>Try again</p>
                                      </TooltipContent>
                                    </Tooltip>
                                  </div>
                                  
                                  <div className="mt-1 flex items-center">
                                    {renderBranchControls(
                                      message.parentMessageId ?? null,
                                      message.parentMessageId
                                        ? branchChildrenMap[message.parentMessageId]
                                        : branchChildrenMap[branchRootKey],
                                      message.parentMessageId
                                        ? branchSelections[message.parentMessageId] ?? 0
                                        : branchSelections[branchRootKey] ?? 0,
                                      "assistant"
                                    )}
                                  </div>
                                  
                                </div>
                              </>
                            )}
                          </div>
                        </div>
                      </div>
                    </Card>

                    {message.sender === "user" && (
                      isEditingMessage ? (
                        <div className="mt-2 flex items-center justify-end gap-2">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="gap-1 text-muted-foreground hover:text-foreground"
                            disabled={editingBusy}
                            onClick={() => onCancelEdit?.()}
                          >
                            <CloseIcon className="h-4 w-4" />
                            Cancel
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            className="gap-1"
                            disabled={editingBusy}
                            onClick={() => onSubmitEdit?.()}
                          >
                            <Check className="h-4 w-4" />
                            Submit
                          </Button>
                        </div>
                      ) : (
                        <div className="mt-2 flex items-center justify-between gap-3">
                          <div className={`flex flex-1 items-center ${userActionVisibilityClass}`}>
                            {renderBranchControls(
                              message.parentMessageId ?? null,
                              message.parentMessageId
                                ? branchChildrenMap[message.parentMessageId]
                                : branchChildrenMap[branchRootKey],
                              message.parentMessageId
                                ? branchSelections[message.parentMessageId] ?? 0
                                : branchSelections[branchRootKey] ?? 0,
                              "user"
                            )}
                          </div>
                          <div className={userActionVisibilityClass}>
                            <div className="flex items-center gap-0.5">
                              <Tooltip delayDuration={0}>
                                <TooltipTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="
                                      h-8 w-8 text-muted-foreground
                                      hover:bg-muted/60 hover:!text-muted-foreground
                                      active:!bg-muted/70 active:!text-muted-foreground
                                      focus:!bg-muted/60 focus:!text-muted-foreground focus:outline-none 
                                      focus:ring-0 focus-visible:ring-0 transition-colors
                                    "
                                    onMouseDown={(e) => e.preventDefault()}
                                    onClick={() => {
                                      onCopy(message.content!, message.id);
                                      onFlashUserActionBar(message.id);
                                    }}
                                    aria-label={copiedId === message.id ? "Copied" : "Copy"}
                                  >
                                    <span className="relative inline-block h-4 w-4">
                                      <Copy
                                        className={`absolute inset-0 h-4 w-4 transition-all duration-200
                                          ${copiedId === message.id ? "opacity-0 scale-75" : "opacity-100 scale-100"}`}
                                      />
                                      <Check
                                        className={`absolute inset-0 h-4 w-4 transition-all duration-200
                                          ${copiedId === message.id ? "opacity-100 scale-100" : "opacity-0 scale-75"}`}
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
                              <Tooltip delayDuration={0}>
                                <TooltipTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="
                                      h-8 w-8 text-muted-foreground
                                      hover:bg-muted/60 hover:!text-muted-foreground
                                      active:!bg-muted/70 active:!text-muted-foreground
                                      focus:!bg-muted/60 focus:!text-muted-foreground focus:outline-none 
                                      focus:ring-0 focus-visible:ring-0 transition-colors
                                    "
                                    onMouseDown={(e) => e.preventDefault()}
                                    onClick={() =>
                                      toast?.({
                                        title: "Coming soon",
                                        description: "Report functionality will be available soon.",
                                      })
                                    }
                                    aria-label="Report message (coming soon)"
                                  >
                                    <LuFlag className="h-4 w-4" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent
                                  side="bottom"
                                  align="center"
                                  className="!opacity-100 bg-background text-foreground border border-border shadow-card px-2 py-1 rounded-md"
                                >
                                  <p>Report</p>
                                </TooltipContent>
                              </Tooltip>
                              {onRequestEdit && (
                                <Tooltip delayDuration={0}>
                                  <TooltipTrigger asChild>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="
                                        h-8 w-8 text-muted-foreground
                                        hover:bg-muted/60 hover:!text-muted-foreground
                                        active:!bg-muted/70 active:!text-muted-foreground
                                        focus:!bg-muted/60 focus:!text-muted-foreground focus:outline-none 
                                        focus:ring-0 focus-visible:ring-0 transition-colors
                                      "
                                      onMouseDown={(e) => e.preventDefault()}
                                      onClick={() => onRequestEdit(message)}
                                      aria-label="Edit message"
                                    >
                                      <Pencil className="h-5 w-5" />
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent
                                    side="bottom"
                                    align="center"
                                    className="!opacity-100 bg-background text-foreground border border-border shadow-card px-2 py-1 rounded-md"
                                  >
                                    <p>Edit</p>
                                  </TooltipContent>
                                </Tooltip>
                              )}
                            </div>
                          </div>
                        </div>
                      )
                    )}
                  </div>
                )}
                </div>
              );
            })}

          {AiTransitionIndicator ? <AiTransitionIndicator /> : null}


          {shouldShowLiveChain && thinkingState && (
            <ChainOfThought
              key={`live-thinking-${thinkingState.startTime ?? "active"}`}
              className="max-w-[85%] md:max-w-[85%] w-full space-y-2"
              open={liveThinkingOpen}
              onOpenChange={setLiveThinkingOpen}
            >
              <ChainOfThoughtHeader className="text-sm md:text-[0.95rem] font-medium text-muted-foreground">
                {thinkingState.isActive ? (
                  <ShimmeringText
                    text="Reasoning..."
                    duration={1.1}
                    pause={1.4}
                    color="hsl(var(--muted-foreground))"
                    shimmeringColor="#2b2d36"
                    className="text-sm md:text-[0.95rem] font-medium"
                  />
                ) : (
                  "Reasoning complete"
                )}
              </ChainOfThoughtHeader>
              <ChainOfThoughtContent className="[&>div:last-child>div:first-child>div:last-child]:hidden">
                {buildChainOfThoughtSteps(liveThoughts, {
                  activeIndex: liveActiveIndex,
                  isComplete: Boolean(thinkingState.isDone),
                })}
              </ChainOfThoughtContent>
            </ChainOfThought>
          )}

          <div ref={messagesEndRef} />
        </div>
      </ScrollArea>
    </div>
  );
}







