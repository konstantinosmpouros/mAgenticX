import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/select";
import { Ghost, Archive, Flag, Trash2, MoreHorizontal, HelpCircle } from "lucide-react";
import type { Agent } from "@/shared/lib/types";
import React from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { SidebarTrigger } from "@/shared/ui/sidebar";
import { HiOutlineUpload } from "react-icons/hi";
import { useTheme } from "next-themes";
import { motion, useAnimationControls } from "framer-motion";
import type { TargetAndTransition, Transition } from "framer-motion";

const TAP_PULSE: TargetAndTransition = { scale: [1, 1.28, 1] };
const TAP_PULSE_TRANSITION: Transition = { duration: 0.36, ease: [0.34, 1.56, 0.64, 1] };
// Slightly bigger overshoot for the private-mode toggle: when entering private
// mode the ghost icon also gets a small wiggle so the activation feels like a
// proper "mode change", not just a tap.
const PRIVATE_ENTER: TargetAndTransition = { scale: [1, 1.35, 1], rotate: [0, -10, 8, 0] };
const PRIVATE_ENTER_TRANSITION: Transition = { duration: 0.5, ease: [0.34, 1.56, 0.64, 1] };

type ChatHeaderProps = {
  agents: Agent[];
  inactiveAgent?: Agent | null;
  selectedAgent: string;
  onAgentChange: (id: string) => void;
  agentTriggerRef?: React.Ref<HTMLButtonElement>;
  agentPickerOpen?: boolean;
  onAgentPickerOpenChange?: (open: boolean) => void;
  showPrivateToggle: boolean;
  isPrivateMode: boolean;
  onTogglePrivate: () => void;
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
  const { resolvedTheme } = useTheme();
  const newChatIconSrc = resolvedTheme === "dark" ? "/edit.png" : "/edit2.png";

  const privatePulse = useAnimationControls();
  const moreMenuPulse = useAnimationControls();

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
              className="w-auto max-w-[16rem] border-0 bg-transparent text-foreground transition-colors focus:ring-0 focus:ring-offset-0 hover:bg-[hsl(var(--hover-surface))] active:bg-[hsl(var(--hover-surface-strong))] focus-visible:bg-[hsl(var(--hover-surface-strong))] justify-start gap-2 px-3 h-11 rounded-xl"
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
          {showPrivateToggle && (
            <Tooltip delayDuration={0}>
              <TooltipTrigger asChild>
                <button
                  onClick={() => {
                    onTogglePrivate();
                    // If we're about to enter private mode, do the bigger
                    // wiggle; if we're about to leave it, just a regular tap.
                    if (isPrivateMode) {
                      privatePulse.start(TAP_PULSE, TAP_PULSE_TRANSITION);
                    } else {
                      privatePulse.start(PRIVATE_ENTER, PRIVATE_ENTER_TRANSITION);
                    }
                  }}
                  onMouseDown={(e) => e.preventDefault()}
                  className={`inline-flex items-center justify-center leading-none p-3 rounded-full transition-smooth duration-300 ${
                    isPrivateMode
                      ? "text-fuchsia-600 bg-gradient-to-r from-fuchsia-500/20 via-fuchsia-400/25 to-fuchsia-500/20 shadow-[0_0_20px_rgba(217,70,239,0.4)] border border-fuchsia-500/40 hover:shadow-[0_0_25px_rgba(217,70,239,0.5)]"
                      : "text-muted-foreground hover:text-foreground hover:bg-[hsl(var(--hover-surface))] active:bg-[hsl(var(--hover-surface-strong))] focus-visible:bg-[hsl(var(--hover-surface-strong))]"
                  }`}
                >
                  <motion.span animate={privatePulse} className="inline-flex">
                    <Ghost size={20} />
                  </motion.span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="center">
                <p>Private Chat</p>
              </TooltipContent>
            </Tooltip>
          )}
          {showConversationActions && (
            <>
              {onNewChat && (
                <Tooltip delayDuration={0}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={onNewChat}
                      onMouseDown={(e) => e.preventDefault()}
                      className="md:hidden inline-flex items-center justify-center rounded-xl h-10 w-10 text-foreground transition-smooth hover:bg-[hsl(var(--hover-surface))] active:bg-[hsl(var(--hover-surface-strong))] focus-visible:bg-[hsl(var(--hover-surface-strong))] focus-visible:outline-none"
                      aria-label="New chat"
                    >
                      <img
                        src={newChatIconSrc}
                        alt="New chat"
                        className="h-7 w-7 object-contain"
                        draggable={false}
                      />
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
                      className="inline-flex items-center justify-center gap-2 rounded-xl h-10 w-10 md:w-auto md:px-3 text-foreground transition-smooth hover:bg-[hsl(var(--hover-surface))] active:bg-[hsl(var(--hover-surface-strong))] focus-visible:bg-[hsl(var(--hover-surface-strong))] focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40"
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
                      className="inline-flex items-center justify-center rounded-xl h-10 w-10 text-foreground transition-smooth hover:bg-[hsl(var(--hover-surface))] active:bg-[hsl(var(--hover-surface-strong))] focus-visible:bg-[hsl(var(--hover-surface-strong))] focus-visible:outline-none"
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
                      className="z-50 w-48 rounded-xl border border-border bg-background text-foreground shadow-lg p-1.5 focus:outline-none focus-visible:outline-none origin-top-right data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
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
