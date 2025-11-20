import React from "react";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Response } from "@/components/ui/ai-elements/response";
import { Button } from "@/components/ui/button";
import type { Agent, MessageOut } from "@/lib/types";
import type { LucideIcon } from "lucide-react";
import { Check, X as CloseIcon } from "lucide-react";
import { AIActionBar, UserActionBar } from "./ActionBars";

type MessageBubbleProps = {
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
  toast?: (opts: { title: string; description?: string; variant?: string; duration?: number }) => void;
  onRetryMessage?: (message: MessageOut) => void;
  isStreaming?: boolean;
  onFlashUserActionBar: (messageId: string) => void;
  onRequestEdit?: (message: MessageOut) => void;
  userActionVisibilityClass: string;
  branchData: {
    parentId: string | null;
    options?: MessageOut[];
    selectionIndex: number;
    onSelectBranch?: (parentId: string | null, branchIndex: number) => void;
  };
};

export function MessageBubble({
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
  toast,
  onRetryMessage,
  isStreaming,
  onFlashUserActionBar,
  onRequestEdit,
  userActionVisibilityClass,
  branchData,
}: MessageBubbleProps) {
  const isUser = message.sender === "user";
  const bubbleClass = isUser
    ? `p-5 bg-chat-user text-chat-user-foreground ml-auto shadow-card border-border ${
        isEditing ? "w-full max-w-full" : "max-w-[85%] md:max-w-[75%]"
      }`
    : "bg-gradient-card text-card-foreground bg-transparent shadow-none border-transparent max-w-[85%] md:max-w-[85%]";

  return (
    <>
      <Card className={bubbleClass}>
        <div className="space-y-3 min-w-0">
          {isEditing ? (
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
          <div className="text-sm opacity-70">
            {isUser ? (
              <div className="flex items-center justify-between">
                <span>
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
                      disabled={editingBusy}
                      onClick={() => onSubmitEdit?.()}
                    >
                      <Check className="h-4 w-4" />
                      Submit
                    </Button>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex w-full flex-wrap items-center gap-2">
                <span>
                  {message.created_at.toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
                <span className="flex items-center gap-1">
                  <AgentIcon size={14} />
                  {currentAgent?.name ?? "Unknown agent"}
                </span>
                <AIActionBar
                  message={message}
                  copiedId={copiedId}
                  onCopy={onCopy}
                  onLike={onLike}
                  onDislike={onDislike}
                  toast={toast}
                  onRetryMessage={onRetryMessage}
                  isStreaming={isStreaming}
                  branchControls={branchData}
                />
              </div>
            )}
          </div>
        </div>
      </Card>

      {isUser && !isEditing && (
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
      )}
    </>
  );
}
