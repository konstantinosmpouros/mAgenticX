import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Copy, Check, ThumbsUp, ThumbsDown, Pencil, MoreHorizontal } from "lucide-react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useEffect, useState } from "react";
import { LuFlag } from "react-icons/lu";
import { PiArrowsCounterClockwise } from "react-icons/pi";
import { BiGitRepoForked } from "react-icons/bi";
import { HiOutlineUpload } from "react-icons/hi";
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
  onReportMessage?: (message: MessageOut) => void;
  onRetryMessage?: (message: MessageOut) => void;
  onForkMessage?: (message: MessageOut) => void;
  onShareMessage?: (message: MessageOut) => void;
  isStreaming?: boolean;
  readOnly?: boolean;
  agentName?: string;
  AgentIcon?: LucideIcon;
  timestampLabel?: string;
  conversationIsReported?: boolean;
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

const moreMenuItemClass =
  "flex cursor-pointer select-none items-center gap-2 rounded-md px-2.5 py-2 text-sm text-foreground outline-none transition-colors data-[highlighted]:bg-[hsl(var(--hover-surface))] data-[highlighted]:text-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-45";
const CLOSE_AI_ACTION_MENUS_EVENT = "magenticx:close-ai-action-menus";

export const AIActionBar = ({
  message,
  copiedId,
  onCopy,
  onLike,
  onDislike,
  onReportMessage,
  onRetryMessage,
  onForkMessage,
  onShareMessage,
  isStreaming,
  readOnly = false,
  branchControls,
  agentName,
  AgentIcon,
  timestampLabel,
  conversationIsReported = false,
}: AIActionBarProps) => {
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);

  useEffect(() => {
    if (!moreMenuOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMoreMenuOpen(false);
      }
    };
    const handleCloseMenus = () => setMoreMenuOpen(false);

    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener(CLOSE_AI_ACTION_MENUS_EVENT, handleCloseMenus);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener(CLOSE_AI_ACTION_MENUS_EVENT, handleCloseMenus);
    };
  }, [moreMenuOpen]);

  return (
  <div className="flex flex-wrap items-center justify-end gap-2">
    {(timestampLabel || agentName) && (
      <div className="flex items-center gap-2 text-xs md:text-sm text-muted-foreground">
        {timestampLabel ? <span>{timestampLabel}</span> : null}
        {agentName ? (
          <span className="flex items-center gap-1">
            {AgentIcon ? <AgentIcon className="h-4 w-4" /> : null}
            <span>{agentName}</span>
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

      {!readOnly && message.liked !== false && (
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

      {!readOnly && message.liked !== true && (
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

      {!readOnly && (
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
                  [&_svg]:!size-[18px]
                "
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onShareMessage?.(message)}
                disabled={!onShareMessage || isStreaming}
                aria-label="Share conversation"
              >
                <HiOutlineUpload className="size-[18px]" />
              </Button>
            </TooltipTrigger>
            <TooltipContent
              side="bottom"
              align="center"
              className="!opacity-100 bg-background text-foreground border border-border shadow-card px-2 py-1 rounded-md"
            >
              <p>Share</p>
            </TooltipContent>
          </Tooltip>
        </div>
      )}

      {!readOnly && (
        <div className="mt-1">
          <DropdownMenu.Root open={moreMenuOpen} onOpenChange={setMoreMenuOpen}>
            <Tooltip delayDuration={0}>
              <TooltipTrigger asChild>
                <DropdownMenu.Trigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="
                      h-8 w-8 text-muted-foreground
                      hover:bg-[hsl(var(--hover-surface))] hover:text-muted-foreground
                      active:bg-[hsl(var(--hover-surface-strong))] active:text-muted-foreground
                      focus:bg-[hsl(var(--hover-surface-strong))] focus:text-muted-foreground focus:outline-none
                      focus:ring-0 focus-visible:ring-0 transition-colors
                      data-[state=open]:bg-[hsl(var(--hover-surface-strong))]
                    "
                    onMouseDown={(event) => event.preventDefault()}
                    aria-label="More message actions"
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenu.Trigger>
              </TooltipTrigger>
              <TooltipContent
                side="bottom"
                align="center"
                className="!opacity-100 bg-background text-foreground border border-border shadow-card px-2 py-1 rounded-md"
              >
                <p>More</p>
              </TooltipContent>
            </Tooltip>

            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="start"
                side="top"
                sideOffset={8}
                collisionPadding={10}
                className="z-[70] min-w-[12rem] rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-lg animate-scale-in"
              >
                <DropdownMenu.Item
                  className={moreMenuItemClass}
                  disabled={!onRetryMessage || isStreaming}
                  onSelect={() => onRetryMessage?.(message)}
                >
                  <PiArrowsCounterClockwise className="h-4 w-4" />
                  <span>Try again</span>
                </DropdownMenu.Item>

                <DropdownMenu.Item
                  className={moreMenuItemClass}
                  disabled={!onForkMessage || isStreaming}
                  onSelect={() => onForkMessage?.(message)}
                >
                  <BiGitRepoForked className="h-4 w-4" />
                  <span>Fork conversation</span>
                </DropdownMenu.Item>

                {!conversationIsReported && onReportMessage && (
                  <>
                    <DropdownMenu.Separator className="my-1 h-px bg-border/60" />
                    <DropdownMenu.Item
                      className={moreMenuItemClass}
                      onSelect={() => onReportMessage(message)}
                    >
                      <LuFlag className="h-4 w-4" />
                      <span>Report</span>
                    </DropdownMenu.Item>
                  </>
                )}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      )}
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
};

export const UserActionBar = ({
  message,
  copiedId,
  onCopy,
  onFlashUserActionBar,
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
