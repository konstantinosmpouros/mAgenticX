import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Copy, Check, ThumbsUp, ThumbsDown, Pencil } from "lucide-react";
import { LuFlag } from "react-icons/lu";
import { BsArrowRepeat } from "react-icons/bs";
import type { LucideIcon } from "lucide-react";
import type { MessageOut } from "@/lib/types";
import { BranchControls } from "./BranchControls";

type ToastHandler = (opts: {
  title: string;
  description?: string;
  variant?: string;
  duration?: number;
}) => void;

type BranchControlsConfig = {
  parentId: string | null;
  options?: MessageOut[];
  selectionIndex: number;
  onSelectBranch?: (parentId: string | null, branchIndex: number) => void;
};

type BaseActionBarProps = {
  message: MessageOut;
  copiedId: string | null;
  onCopy: (content: string, messageId: string) => void;
  toast?: ToastHandler;
  branchControls?: BranchControlsConfig;
};

type AIActionBarProps = BaseActionBarProps & {
  onLike: (message: MessageOut) => void;
  onDislike: (message: MessageOut) => void;
  onRetryMessage?: (message: MessageOut) => void;
  isStreaming?: boolean;
  agentName?: string;
  AgentIcon?: LucideIcon;
  timestampLabel?: string;
};

type UserActionBarProps = BaseActionBarProps & {
  onFlashUserActionBar: (messageId: string) => void;
  onRequestEdit?: (message: MessageOut) => void;
  className?: string;
};

const CopyButton = ({
  copiedId,
  messageId,
  onClick,
  onAfterCopy,
}: {
  copiedId: string | null;
  messageId: string;
  onClick: () => void;
  onAfterCopy?: () => void;
}) => {
  const handleClick = () => {
    onClick();
    onAfterCopy?.();
  };

  return (
    <Tooltip delayDuration={0}>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="
            h-8 w-8 text-muted-foreground
            hover:bg-[hsl(var(--hover-surface))] hover:text-muted-foreground
            active:bg-[hsl(var(--hover-surface-strong))] active:text-muted-foreground
            focus:bg-[hsl(var(--hover-surface-strong))] focus:text-muted-foreground focus:outline-none 
            focus:ring-0 focus-visible:ring-0 transition-colors
          "
          onMouseDown={(event) => event.preventDefault()}
          onClick={handleClick}
          aria-label={copiedId === messageId ? "Copied" : "Copy"}
        >
          <span className="relative inline-block h-4 w-4">
            <Copy
              className={`absolute inset-0 h-4 w-4 transition-all duration-200 ${
                copiedId === messageId ? "opacity-0 scale-75" : "opacity-100 scale-100"
              }`}
            />
            <Check
              className={`absolute inset-0 h-4 w-4 transition-all duration-200 ${
                copiedId === messageId ? "opacity-100 scale-100" : "opacity-0 scale-75"
              }`}
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
  );
};

export const AIActionBar = ({
  message,
  copiedId,
  onCopy,
  onLike,
  onDislike,
  toast,
  onRetryMessage,
  isStreaming,
  branchControls,
  agentName,
  AgentIcon,
  timestampLabel,
}: AIActionBarProps) => (
  <div className="flex flex-wrap items-center justify-end gap-2">
    {(timestampLabel || agentName) && (
      <div className="flex items-center gap-2 text-xs md:text-sm text-muted-foreground">
        {timestampLabel ? <span className="opacity-70">{timestampLabel}</span> : null}
        {agentName ? (
          <span className="flex items-center gap-1 opacity-70">
            {AgentIcon ? <AgentIcon size={14} /> : null}
            {agentName}
          </span>
        ) : null}
      </div>
    )}
    <div className="flex items-center gap-0.5">
      <div className="mt-1">
        <CopyButton
          copiedId={copiedId}
          messageId={message.id}
          onClick={() => onCopy(message.content ?? "", message.id)}
        />
      </div>

      {message.liked !== false && (
        <div className="mt-1">
          <Tooltip delayDuration={0}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={`h-8 w-8 hover:bg-[hsl(var(--hover-surface))] active:bg-[hsl(var(--hover-surface-strong))] focus:bg-[hsl(var(--hover-surface-strong))] ${
                  message.liked === true
                    ? "text-[#de8bff] hover:!text-[#de8bff]"
                    : "text-muted-foreground hover:!text-muted-foreground"
                }`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onLike(message)}
                aria-label={message.liked === true ? "Unlike" : "Like"}
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
                className={`h-8 w-8 hover:bg-[hsl(var(--hover-surface))] active:bg-[hsl(var(--hover-surface-strong))] focus:bg-[hsl(var(--hover-surface-strong))] ${
                  message.liked === false
                    ? "text-[#de8bff] hover:!text-[#de8bff]"
                    : "text-muted-foreground hover:!text-muted-foreground"
                }`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onDislike(message)}
                aria-label={message.liked === false ? "Clear dislike" : "Dislike"}
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
                hover:bg-[hsl(var(--hover-surface))] hover:text-muted-foreground
                active:bg-[hsl(var(--hover-surface-strong))] active:text-muted-foreground
                focus:bg-[hsl(var(--hover-surface-strong))] focus:text-muted-foreground focus:outline-none 
                focus:ring-0 focus-visible:ring-0 transition-colors
              "
              onMouseDown={(event) => event.preventDefault()}
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
                hover:bg-[hsl(var(--hover-surface))] hover:text-muted-foreground
                active:bg-[hsl(var(--hover-surface-strong))] active:text-muted-foreground
                focus:bg-[hsl(var(--hover-surface-strong))] focus:text-muted-foreground focus:outline-none 
                focus:ring-0 focus-visible:ring-0 transition-colors
              "
              onMouseDown={(event) => event.preventDefault()}
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
    </div>
    <div className="flex items-center">
      <BranchControls
        parentId={branchControls?.parentId ?? null}
        options={branchControls?.options}
        selectionIndex={branchControls?.selectionIndex ?? 0}
        role="assistant"
        onSelectBranch={branchControls?.onSelectBranch}
      />
    </div>
  </div>
);

export const UserActionBar = ({
  message,
  copiedId,
  onCopy,
  onFlashUserActionBar,
  toast,
  onRequestEdit,
  branchControls,
  className,
}: UserActionBarProps) => (
  <div className={`flex w-full justify-end ${className ?? ""}`}>
    <div className="flex items-center gap-2">
      <BranchControls
        parentId={branchControls?.parentId ?? null}
        options={branchControls?.options}
        selectionIndex={branchControls?.selectionIndex ?? 0}
        role="user"
        onSelectBranch={branchControls?.onSelectBranch}
      />
      <div className="flex items-center gap-0.5">
        <CopyButton
          copiedId={copiedId}
          messageId={message.id}
          onClick={() => onCopy(message.content ?? "", message.id)}
          onAfterCopy={() => onFlashUserActionBar(message.id)}
        />

        <Tooltip delayDuration={0}>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="
                h-8 w-8 text-muted-foreground
                hover:bg-[hsl(var(--hover-surface))] hover:text-muted-foreground
                active:bg-[hsl(var(--hover-surface-strong))] active:text-muted-foreground
                focus:bg-[hsl(var(--hover-surface-strong))] focus:text-muted-foreground focus:outline-none 
                focus:ring-0 focus-visible:ring-0 transition-colors
              "
              onMouseDown={(event) => event.preventDefault()}
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
                  hover:bg-[hsl(var(--hover-surface))] hover:text-muted-foreground
                  active:bg-[hsl(var(--hover-surface-strong))] active:text-muted-foreground
                  focus:bg-[hsl(var(--hover-surface-strong))] focus:text-muted-foreground focus:outline-none 
                  focus:ring-0 focus-visible:ring-0 transition-colors
                "
                onMouseDown={(event) => event.preventDefault()}
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
);
