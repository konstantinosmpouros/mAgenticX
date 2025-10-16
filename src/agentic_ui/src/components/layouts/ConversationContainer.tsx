import React from "react";
import type { ComponentType } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { MarkdownRenderer } from "@/components/ui/markdownRenderer";
import ThinkingList from "@/components/ui/thinkingList";
import {
  Download,
  FileText,
  ChevronDown,
  ChevronRight,
  ThumbsUp,
  ThumbsDown,
  Copy,
  Check,
} from "lucide-react";
import { BsHandThumbsUpFill, BsHandThumbsDownFill } from "react-icons/bs";
import { VscEye } from "react-icons/vsc";
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

type ConversationContainerProps = {
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
};

export default function ConversationContainer({
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
}: ConversationContainerProps) {
  const viewportRef = React.useRef<HTMLDivElement | null>(null);

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
            messages.map((message) => (
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

                {message.content && (
                  <div
                    className={`space-y-2 md:space-y-2 ${
                      message.sender === 'user' ? 'flex flex-col items-end' : ''
                    } group/message`}
                  >
                    {message.thinking && message.sender === 'ai' && (
                      <div
                        className="
                          flex items-center gap-2 text-xs md:text-sm font-medium 
                          text-muted-foreground hover:text-foreground 
                          transition-colors cursor-pointer max-w-[85%] md:max-w-[85%] w-full"
                        onClick={() => onToggleThinking(message.id)}
                      >
                        <span>
                          {message.thinkingTime
                            ? (() => {
                                const t = message.thinkingTime as number;
                                const m = Math.floor(t / 60);
                                const s = t % 60;
                                const fmt = m > 0 ? `${m}m ${s}s` : `${s}s`;
                                return `Thought for ${fmt}`;
                              })()
                            : 'Thinking...'}
                        </span>
                        {expandedThinking[message.id] ? (
                          <ChevronDown className="h-3 w-3 " />
                        ) : (
                          <ChevronRight className="h-3 w-3" />
                        )}
                      </div>
                    )}

                    {message.thinking && message.sender === 'ai' && (
                      <div
                        className={`transition-all duration-300 ease-smooth ${
                          expandedThinking[message.id]
                            ? 'mt-2 opacity-100 max-h-none overflow-visible'
                            : 'max-h-0 opacity-0 overflow-hidden'
                        }`}
                      >
                        <ThinkingList
                          thoughts={message.thinking}
                          isComplete
                          className="max-w-[85%] md:max-w-[85%] w-full"
                        />
                      </div>
                    )}

                    <Card
                      className={`${
                        message.sender === 'user'
                          ? 'p-5 bg-chat-user text-chat-user-foreground ml-auto shadow-card border-border max-w-[85%] md:max-w-[75%]'
                          : 'bg-gradient-card text-card-foreground bg-transparent shadow-none border-transparent max-w-[85%] md:max-w-[85%]'
                      }`}
                    >
                      <div className="space-y-3 min-w-0">
                        <MarkdownRenderer
                          content={message.content}
                          className="leading-relaxed break-words"
                        />
                        <div className="text-sm opacity-70 flex items-center gap-2">
                          <span>
                            {message.created_at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </span>

                          {message.sender === 'ai' && (
                            <>
                              <span className="flex items-center gap-1">
                                <AgentIcon size={14} />
                                {currentAgent?.name}
                              </span>

                              <div className="flex justify-start gap-1">
                                <div className="mt-1">
                                  <Tooltip delayDuration={0}>
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

                                <div className="mt-1">
                                  <Tooltip delayDuration={0}>
                                    <TooltipTrigger asChild>
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        className={`h-8 w-8 hover:bg-muted/60 ${
                                          message.liked === true
                                            ? 'text-primary'
                                            : 'text-muted-foreground hover:text-foreground'
                                        }`}
                                        onMouseDown={(e) => e.preventDefault()}
                                        onClick={() => onLike(message)}
                                        aria-label={message.liked === true ? 'Unlike' : 'Like'}
                                      >
                                        {message.liked === true ? (
                                        <BsHandThumbsUpFill className="h-4 w-4" />
                                      ) : (
                                        <ThumbsUp className="h-4 w-4" />
                                      )}
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

                                <div className="mt-1">
                                  <Tooltip delayDuration={0}>
                                    <TooltipTrigger asChild>
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        className={`h-8 w-8 hover:bg-muted/60 ${
                                          message.liked === false
                                            ? 'text-primary'
                                            : 'text-muted-foreground hover:text-foreground'
                                        }`}
                                        onMouseDown={(e) => e.preventDefault()}
                                        onClick={() => onDislike(message)}
                                        aria-label={message.liked === false ? 'Clear dislike' : 'Dislike'}
                                      >
                                        {message.liked === false ? (
                                        <BsHandThumbsDownFill className="h-4 w-4" />
                                      ) : (
                                        <ThumbsDown className="h-4 w-4" />
                                      )}
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
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    </Card>

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
                          <Tooltip delayDuration={0}>
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
                                  onCopy(message.content!, message.id);
                                  onFlashUserActionBar(message.id);
                                }}
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
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}

          {AiTransitionIndicator ? <AiTransitionIndicator /> : null}


          <div
            className={`transition-all duration-300 ease-smooth ${
              thinkingState?.isActive
                ? 'mt-2 opacity-100 max-h-none overflow-visible'
                : 'max-h-0 opacity-0 overflow-hidden'
            }`}
          >
            <div className="text-sm text-muted-foreground mb-1">Thinking...</div>
            {thinkingState && (
              <ThinkingList
                thoughts={thinkingState.thoughts.slice(0, thinkingState.currentThoughtIndex + 1)}
                isComplete={thinkingState?.isDone}
                className="max-w-[85%] md:max-w-[85%]"
              />
            )}
          </div>

          <div ref={messagesEndRef} />
        </div>
      </ScrollArea>
    </div>
  );
}







