import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/select";
import { Archive, BookmarkPlus, Flag, Trash2, MoreHorizontal, HelpCircle, Loader2, X } from "lucide-react";
import type { Agent } from "@/shared/lib/types";
import React from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { SidebarTrigger } from "@/shared/ui/sidebar";
import { HiOutlineUpload } from "react-icons/hi";
import { AnimatePresence, motion, useAnimationControls, useReducedMotion } from "framer-motion";
import type { TargetAndTransition, Transition } from "framer-motion";
import { INTERACTIVE_SURFACE } from "@/shared/lib/consts";
import { returnFocusOnlyForKeyboard } from "@/shared/lib/focus-return";
import { NewChatIcon } from "@/shared/ui/new-chat-icon";
import { IncognitoIcon } from "@/shared/ui/incognito-icon";
import { RADIX_MOTION } from "@/shared/lib/motion/panels";

const TAP_PULSE: TargetAndTransition = { scale: [1, 1.28, 1] };
const TAP_PULSE_TRANSITION: Transition = { duration: 0.36, ease: [0.34, 1.56, 0.64, 1] };
// The private controls (the "Private" pill, the toggle, Save chat) come and go
// with a short fade-and-scale; reduced motion keeps only the fade.
const PRIVATE_SWAP: Transition = { duration: 0.24, ease: [0.22, 1, 0.36, 1] };
const PRIVATE_HINT = "Hidden from your chat list, search and memory";

type ChatHeaderProps = {
  agents: Agent[];
  inactiveAgent?: Agent | null;
  selectedAgent: string;
  onAgentChange: (id: string) => void;
  agentTriggerRef?: React.Ref<HTMLButtonElement>;
  agentPickerOpen?: boolean;
  onAgentPickerOpenChange?: (open: boolean) => void;
  /** Private mode can be switched here (a new chat, before its first message). */
  showPrivateToggle: boolean;
  isPrivateMode: boolean;
  onTogglePrivate: () => void;
  /** Saves the open private chat as a normal one. Given only for a stored
      private conversation, where "Save chat" takes the toggle's place. */
  onSaveConversation?: () => Promise<boolean>;
  showBottomBorder?: boolean;
  showConversationActions?: boolean;
  isConversationArchived?: boolean;
  isConversationReported?: boolean;
  conversationActionsOpen?: boolean;
  onConversationActionsOpenChange?: (open: boolean) => void;
  onArchiveConversation?: () => void;
  onUnarchiveConversation?: () => void;
  onReportConversation?: () => void;
  onDeleteConversation?: () => void;
  onShareConversation?: () => void;
  canShareConversation?: boolean;
  onNewChat?: () => void;
  isStreaming?: boolean;
};

export default function ChatHeader({
  agents,
  inactiveAgent = null,
  selectedAgent,
  onAgentChange,
  agentTriggerRef,
  agentPickerOpen = false,
  onAgentPickerOpenChange,
  showPrivateToggle,
  isPrivateMode,
  onTogglePrivate,
  onSaveConversation,
  showBottomBorder = false,
  showConversationActions = false,
  isConversationArchived = false,
  isConversationReported = false,
  conversationActionsOpen = false,
  onConversationActionsOpenChange,
  onArchiveConversation,
  onUnarchiveConversation,
  onReportConversation,
  onDeleteConversation,
  onShareConversation,
  canShareConversation = false,
  onNewChat,
  isStreaming = false,
}: ChatHeaderProps) {

  const moreMenuPulse = useAnimationControls();
  const reduceMotion = useReducedMotion() ?? false;
  const [saving, setSaving] = React.useState(false);
  const swapIn = reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.9 };
  const swapShown = reduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1 };
  const canSave = isPrivateMode && Boolean(onSaveConversation);
  const handleSave = async () => {
    if (!onSaveConversation || saving) return;
    setSaving(true);
    try {
      await onSaveConversation();
    } finally {
      setSaving(false);
    }
  };

  const displayAgents = React.useMemo(() => {
    if (inactiveAgent && !agents.some((agent) => agent.id === inactiveAgent.id)) {
      return [...agents, inactiveAgent];
    }
    return agents;
  }, [agents, inactiveAgent]);

  const selected = React.useMemo(
    () => displayAgents.find((a) => a.id === selectedAgent),
    [displayAgents, selectedAgent],
  );
  // Keyed to the agent currently *shown in the picker*, not to the conversation's
  // agent: the warning sits next to the trigger and describes what it displays,
  // so deriving it from `inactiveAgent` left it stuck on after switching to a
  // healthy agent.
  const showInactiveIndicator = selected?.isActive === false;

  // A private ("incognito") conversation is deliberately kept out of the
  // conversation list, so the actions that would publish it (Share) or manage
  // its listing (Archive / Delete) make no sense and are hidden entirely —
  // offering Share on a private chat in particular contradicts the mode.
  const showShareAction = Boolean(onShareConversation) && !isPrivateMode;
  const showArchiveAction = !isPrivateMode;
  const showDeleteAction = !isPrivateMode;
  const showReportAction = !isConversationReported;
  const showActionsMenu = showArchiveAction || showDeleteAction || showReportAction;

  return (
    <div
      // Measured by popovers that open upwards (the "/" menu), so they stop
      // below the header instead of running under it.
      data-chat-header=""
      className={`sticky top-0 z-40 w-full bg-transparent px-3 py-2 md:px-6 md:py-3 border-b transition-colors duration-200 ${showBottomBorder ? "border-border/100 backdrop-blur-md" : "border-transparent"}`}
    >
      <div className="flex w-full items-center gap-1.5 md:gap-3">
        <SidebarTrigger
          aria-label="Toggle sidebar"
          className="inline-flex h-10 w-10 rounded-xl bg-transparent text-foreground transition-colors hover:bg-[hsl(var(--hover-surface))] hover:text-foreground active:bg-[hsl(var(--hover-surface-strong))] focus-visible:ring-2 focus-visible:ring-ring md:hidden [&_svg]:size-5"
        />
        <div className="flex items-center gap-2">
          <Select
            value={selectedAgent}
            open={agentPickerOpen}
            onOpenChange={onAgentPickerOpenChange}
            onValueChange={onAgentChange}
          >
            <SelectTrigger
              ref={agentTriggerRef}
              onMouseDown={(e) => e.preventDefault()}
              // Width hugs the agent name (no min-width): the trigger is
              // followed by the "might be inactive" indicator, and a fixed
              // floor left that badge stranded far from the chevron on
              // short names. max-w still caps it; the label truncates.
              className={`w-auto max-w-[16rem] border-0 bg-transparent text-foreground transition-colors focus:ring-0 focus:ring-offset-0 ${INTERACTIVE_SURFACE} justify-start gap-2 px-3 h-11 rounded-xl`}
            >
              <SelectValue placeholder="Select an agent">
                <div className="flex items-center">
                  {/* Radix only renders its own placeholder for an empty
                                        value, so a selection naming an agent that isn't in
                                        the list (a deleted one, or an old conversation's
                                        inactive agent after starting a new chat) has to fall
                                        back here — otherwise the trigger renders blank. */}
                  <span
                    className={`truncate text-lg max-w-[8.5rem] md:max-w-[10.5rem] ${
                      selected ? "text-foreground" : "text-muted-foreground"
                    }`}
                  >
                    {selected ? selected.name : "Select an agent"}
                  </span>
                </div>
              </SelectValue>
            </SelectTrigger>

            <SelectContent className="w-[18rem] rounded-xl border border-border/60 bg-background text-foreground shadow-lg">
              {displayAgents.map((agent) => (
                <SelectItem
                  key={agent.id}
                  value={agent.id}
                  className="cursor-pointer text-sm transition-colors data-[highlighted]:bg-muted data-[highlighted]:text-foreground data-[state=checked]:bg-muted data-[state=checked]:text-foreground"
                >
                  <div className="flex items-center gap-2">
                    {(() => {
                      const Icon = agent.icon;
                      return (
                        <div className="flex h-5 w-5 items-center justify-center rounded-md text-muted-foreground">
                          <Icon className="h-4 w-4" aria-hidden="true" />
                        </div>
                      );
                    })()}
                    <div className="flex flex-col">
                      <span className="font-medium text-sm text-foreground">
                        {agent.name}
                        {!agent.isActive && (
                          <span className="ml-1 text-xs uppercase tracking-wide text-amber-500">
                            inactive
                          </span>
                        )}
                      </span>
                      <span className="text-xs text-muted-foreground">{agent.description}</span>
                    </div>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {showInactiveIndicator && (
            <Tooltip delayDuration={0}>
              <TooltipTrigger asChild>
                <span className="inline-flex h-6 w-6 items-center justify-center rounded-full text-amber-500">
                  <HelpCircle size={16} />
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="start">
                <p>This agent might be inactive.</p>
              </TooltipContent>
            </Tooltip>
          )}
        </div>

        <div className="ml-auto flex items-center gap-0.5 md:gap-1">
          <AnimatePresence initial={false} mode="popLayout">
            {isPrivateMode && (
              <motion.div
                key="private-pill"
                layout
                initial={swapIn}
                animate={swapShown}
                exit={swapIn}
                transition={PRIVATE_SWAP}
                className="mr-0.5 md:mr-1"
              >
                {/* No tooltip: the pill speaks for itself. Screen readers still
                    get the meaning from aria-label. */}
                {showPrivateToggle ? (
                  <button
                    type="button"
                    onClick={onTogglePrivate}
                    onMouseDown={(e) => e.preventDefault()}
                    aria-pressed="true"
                    aria-label={`Private chat is on. ${PRIVATE_HINT}. Turn it off`}
                    data-testid="private-pill"
                    className="group inline-flex h-9 items-center gap-1.5 rounded-full border border-primary/35 bg-primary/15 pl-2.5 pr-2 text-sm font-medium text-primary transition-colors hover:bg-primary/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                  >
                    <PrivatePillIcon reduceMotion={reduceMotion} />
                    <span className="hidden sm:inline">Private</span>
                    <X
                      className="h-3.5 w-3.5 opacity-60 transition-opacity group-hover:opacity-100"
                      aria-hidden="true"
                    />
                  </button>
                ) : (
                  <span
                    role="status"
                    aria-label={`Private chat. ${PRIVATE_HINT}`}
                    data-testid="private-pill"
                    className="inline-flex h-9 items-center gap-1.5 rounded-full border border-primary/35 bg-primary/15 px-2.5 text-sm font-medium text-primary"
                  >
                    <PrivatePillIcon reduceMotion={reduceMotion} />
                    <span className="hidden sm:inline">Private</span>
                  </span>
                )}
              </motion.div>
            )}
            {canSave ? (
              <motion.div
                key="save-chat"
                layout
                initial={swapIn}
                animate={swapShown}
                exit={swapIn}
                transition={PRIVATE_SWAP}
              >
                <Tooltip delayDuration={0}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => void handleSave()}
                      onMouseDown={(e) => e.preventDefault()}
                      disabled={saving}
                      aria-busy={saving || undefined}
                      aria-label="Save chat"
                      className="inline-flex h-10 w-10 items-center justify-center gap-2 rounded-xl bg-primary font-medium text-primary-foreground shadow-[0_0_22px_-6px_hsl(var(--primary)/0.75)] transition-[filter,box-shadow,opacity] hover:shadow-[0_0_28px_-4px_hsl(var(--primary)/0.85)] hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:opacity-70 sm:w-auto sm:px-3.5"
                    >
                      {saving ? (
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                      ) : (
                        <BookmarkPlus className="h-4 w-4" aria-hidden="true" />
                      )}
                      <span className="hidden sm:inline">Save chat</span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" align="center">
                    <p>Keep it in your chat list, search and memory</p>
                  </TooltipContent>
                </Tooltip>
              </motion.div>
            ) : (
              !isPrivateMode &&
              showPrivateToggle && (
                <motion.div
                  key="private-toggle"
                  layout
                  initial={swapIn}
                  animate={swapShown}
                  exit={swapIn}
                  transition={PRIVATE_SWAP}
                >
                  <Tooltip delayDuration={0}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={onTogglePrivate}
                        onMouseDown={(e) => e.preventDefault()}
                        aria-pressed="false"
                        aria-label="Private chat"
                        className={`inline-flex h-10 w-10 items-center justify-center rounded-xl text-muted-foreground hover:text-foreground transition-smooth ${INTERACTIVE_SURFACE} focus-visible:outline-none`}
                      >
                        <IncognitoIcon />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" align="center">
                      <p>Private chat</p>
                    </TooltipContent>
                  </Tooltip>
                </motion.div>
              )
            )}
          </AnimatePresence>
          {showConversationActions && (
            <>
              {onNewChat && (
                <Tooltip delayDuration={0}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={onNewChat}
                      onMouseDown={(e) => e.preventDefault()}
                      className={`md:hidden inline-flex items-center justify-center rounded-xl h-10 w-10 text-foreground transition-smooth ${INTERACTIVE_SURFACE} focus-visible:outline-none`}
                      aria-label="New chat"
                    >
                      <NewChatIcon />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" align="center" className="md:hidden">
                    <p>New chat</p>
                  </TooltipContent>
                </Tooltip>
              )}
              {showShareAction && (
                <Tooltip delayDuration={0}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={onShareConversation}
                      onMouseDown={(e) => e.preventDefault()}
                      disabled={!canShareConversation || isStreaming}
                      className={`inline-flex items-center justify-center gap-2 rounded-xl h-10 w-10 md:w-auto md:px-3 text-foreground transition-smooth ${INTERACTIVE_SURFACE} focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40`}
                      aria-label="Share full conversation"
                    >
                      <HiOutlineUpload className="h-5 w-5" aria-hidden="true" />
                      <span className="hidden md:inline">Share</span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" align="center" className="md:hidden">
                    <p>Share</p>
                  </TooltipContent>
                </Tooltip>
              )}
              {showActionsMenu && (
                <DropdownMenu.Root
                  open={conversationActionsOpen}
                  onOpenChange={onConversationActionsOpenChange}
                >
                  <DropdownMenu.Trigger asChild>
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => moreMenuPulse.start(TAP_PULSE, TAP_PULSE_TRANSITION)}
                      className={`inline-flex items-center justify-center rounded-xl h-10 w-10 text-foreground transition-smooth ${INTERACTIVE_SURFACE} focus-visible:outline-none`}
                      aria-label="Conversation actions"
                    >
                      <motion.span animate={moreMenuPulse} className="inline-flex">
                        <MoreHorizontal size={18} />
                      </motion.span>
                    </button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      sideOffset={8}
                      align="end"
                      onCloseAutoFocus={returnFocusOnlyForKeyboard}
                      className={`z-50 w-48 rounded-xl border border-border bg-background text-foreground shadow-lg p-1.5 focus:outline-none focus-visible:outline-none origin-[--radix-dropdown-menu-content-transform-origin] ${RADIX_MOTION.popover}`}
                    >
                      {showArchiveAction && (
                        <DropdownMenu.Item
                          onSelect={() => {
                            if (isConversationArchived) {
                              onUnarchiveConversation?.();
                              return;
                            }
                            onArchiveConversation?.();
                          }}
                          className="flex cursor-pointer items-center gap-1 rounded-lg px-2.5 py-1 text-sm text-foreground transition-colors data-[highlighted]:bg-muted data-[highlighted]:text-foreground focus-visible:outline-none data-[highlighted]:outline-none"
                        >
                          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-transparent text-muted-foreground">
                            <Archive size={16} />
                          </div>
                          <span>{isConversationArchived ? "Unarchive" : "Archive"}</span>
                        </DropdownMenu.Item>
                      )}
                      {showReportAction && (
                        <DropdownMenu.Item
                          onSelect={() => {
                            onReportConversation?.();
                          }}
                          className="flex cursor-pointer items-center gap-1 rounded-lg px-2.5 py-1 text-sm text-foreground transition-colors data-[highlighted]:bg-muted data-[highlighted]:text-foreground focus-visible:outline-none data-[highlighted]:outline-none"
                        >
                          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-transparent text-muted-foreground">
                            <Flag size={16} />
                          </div>
                          <span>Report</span>
                        </DropdownMenu.Item>
                      )}
                      {showDeleteAction && (showArchiveAction || showReportAction) && (
                        <DropdownMenu.Separator className="my-1 h-px bg-border/60" />
                      )}
                      {showDeleteAction && (
                        <DropdownMenu.Item
                          onSelect={() => {
                            onDeleteConversation?.();
                          }}
                          className="flex cursor-pointer items-center gap-1 rounded-lg px-2.5 py-1 text-sm text-destructive transition-colors data-[highlighted]:bg-destructive/10 data-[highlighted]:text-destructive focus-visible:outline-none data-[highlighted]:outline-none"
                        >
                          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-transparent text-destructive">
                            <Trash2 size={16} />
                          </div>
                          <span>Delete</span>
                        </DropdownMenu.Item>
                      )}
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** The pill's incognito mark: settles in with a small tilt when private mode starts. */
function PrivatePillIcon({ reduceMotion }: { reduceMotion: boolean }) {
  return (
    <motion.span
      className="inline-flex"
      initial={reduceMotion ? false : { rotate: -14, scale: 0.7 }}
      animate={{ rotate: 0, scale: 1 }}
      transition={{ type: "spring", stiffness: 420, damping: 16 }}
    >
      <IncognitoIcon className="h-[18px] w-[18px]" />
    </motion.span>
  );
}
