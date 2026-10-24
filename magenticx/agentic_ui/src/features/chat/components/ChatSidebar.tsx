import * as React from "react";
import {
  MessageSquare,
  MoreHorizontal,
  PanelLeft,
  Search,
  Archive,
  Flag,
  Trash2,
  Pencil,
  Pin,
  PinOff,
  ArrowRight,
  ChevronRight,
  ChevronsUpDown,
  FileText,
  HelpCircle,
  Keyboard,
  LifeBuoy,
  LogOut,
  Palette,
  Settings,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { PiWaveformBold } from "react-icons/pi";
import { MdOutlineSchedule } from "react-icons/md";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Loader } from "@/shared/ui/shadcn-io/loader";

import type { AccountSummary, ConversationSummary, UserProfile } from "@/shared/lib/types";
import AccountMenu, { AccountMenuItems } from "@/features/auth/components/AccountMenu";
import { cn } from "@/shared/lib/utils";
import {
  Sidebar as SidebarRoot,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "@/shared/ui/sidebar";
import { Skeleton } from "@/shared/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { NewChatIcon } from "@/shared/ui/new-chat-icon";
import { BrandLogo } from "@/shared/ui/brand-logo";
import { INTERACTIVE_SURFACE } from "@/shared/lib/consts";
import { useTouchMenuTrigger } from "@/features/chat/hooks/useTouchMenuTrigger";
import { loadSidebarSectionOpen, saveSidebarSectionOpen } from "@/shared/lib/sidebarStorage";
import { RADIX_MOTION } from "@/shared/lib/motion/panels";

type ChatSidebarProps = {
  conversations: ConversationSummary[];
  currentConversationId: string | null;
  onSelectConversation: (conversation: ConversationSummary) => void;
  onDeleteConversation: (id: string, e?: React.MouseEvent) => void;
  onRenameConversation?: (id: string, newTitle: string) => Promise<void> | void;
  onArchiveConversation?: (id: string) => void;
  /** Pin an unpinned conversation, or unpin a pinned one. */
  onTogglePinConversation?: (conversation: ConversationSummary) => void;
  onReportConversation?: (id: string) => void;
  onLoadMore: () => void;
  isLoadingMore: boolean;
  isInitialLoading: boolean;
  hasMore: boolean;
  onTitleClick: () => void;
  onNewChat: () => void;
  onOpenSearch: () => void;
  onVoiceMode?: () => void;
  onOpenScheduledTasks?: () => void;
  scheduledTasksRunningCount?: number;
  /** Open the settings panel, optionally on a specific section. */
  onOpenSettings: (tab?: string) => void;
  /** Open the small "Edit profile" dialog. */
  onEditProfile: () => void;
  /** Open the dedicated Keyboard Shortcuts panel. */
  onOpenShortcuts: () => void;
  /** Open the dedicated Help & Resources panel. */
  onOpenHelp: () => void;
  onLogout: () => void;
  userProfile: UserProfile | null;
  /** Accounts this browser is signed in to. Empty ⇒ no switcher is shown,
   *  which is also what happens when the feature is disabled server-side. */
  accounts?: AccountSummary[];
  canAddAccount?: boolean;
  maxAccounts?: number;
  busyAccountId?: string | null;
  onSelectAccount?: (account: AccountSummary) => void;
  onAddAccount?: () => void;
  onLogoutAccount?: (account: AccountSummary) => void;
  onLogoutAllAccounts?: () => void;
  dismissFloatingUiSignal?: number;
  onFloatingUiStateChange?: (open: boolean) => void;
  sidebarInteractionHook: (args: { isCollapsed: boolean; toggleSidebar: () => void }) => {
    isLogoHovered: boolean;
    handleSidebarMouseEnter: () => void;
    handleSidebarMouseLeave: () => void;
    toggleCollapsedOnBlankArea: (event: React.MouseEvent) => void;
  };
};

const ConversationLoadingSkeleton = ({ count = 3 }: { count?: number }) => (
  <div className="space-y-2 pt-2" aria-hidden="true">
    {Array.from({ length: count }).map((_, index) => (
      <div key={`conversation-skeleton-${index}`} className="rounded-lg px-3 py-3">
        <div className="flex items-center gap-3">
          <Skeleton className="h-9 w-9 rounded-full" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-full" />
          </div>
        </div>
      </div>
    ))}
  </div>
);

const pinnedTime = (conversation: ConversationSummary) =>
  conversation.pinnedAt ? new Date(conversation.pinnedAt).getTime() : 0;

/** Fade-and-drop for a section's list: transform and opacity only, instant under reduced motion. */
const sectionListMotion = (reduceMotion: boolean | null) => ({
  initial: reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6 },
  animate: { opacity: 1, y: 0 },
  exit: reduceMotion
    ? { opacity: 0, transition: { duration: 0 } }
    : { opacity: 0, y: -6, transition: { duration: 0.12, ease: "easeIn" as const } },
  transition: reduceMotion ? { duration: 0 } : { duration: 0.18, ease: "easeOut" as const },
});

// Conversation rows are motion <li>s: they fade in with a short stagger (also
// when the rail opens and the list mounts), slide to their new place when the
// list reorders (a pin, a new chat on top), and the selected row's highlight
// glides from row to row.
const MotionMenuItem = motion.create(SidebarMenuItem);
// The top actions' icons grow a little on hover (the row is `group/nav`).
const NAV_ICON_MOTION =
  "transition-transform duration-300 ease-out motion-safe:supports-[hover:hover]:group-hover/nav:scale-110";
// What the open rail adds beside the icons (labels, the chat list) fades in
// once the width transition is under way rather than being squeezed into the
// narrow rail; on collapse it goes at once, before the width closes. Labels are
// display:none while collapsed and the list unmounts, so this replays on every
// expand.
const RAIL_REVEAL = "motion-safe:animate-sidebar-reveal";
// Labels also never wrap: mid-animation the rail is narrower than "New chat".
const RAIL_LABEL = `whitespace-nowrap ${RAIL_REVEAL} group-data-[collapsible=icon]:hidden`;
const ROW_SPRING = { type: "spring", stiffness: 520, damping: 42, mass: 0.8 } as const;
const rowMotion = (reduceMotion: boolean | null, index: number) => ({
  layout: "position" as const,
  initial: reduceMotion ? { opacity: 0 } : { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0 },
  exit: reduceMotion
    ? { opacity: 0, transition: { duration: 0 } }
    : { opacity: 0, x: -8, transition: { duration: 0.15, ease: "easeIn" as const } },
  transition: reduceMotion
    ? { duration: 0 }
    : {
        opacity: { duration: 0.22, delay: Math.min(index * 0.025, 0.3) },
        y: { duration: 0.22, delay: Math.min(index * 0.025, 0.3) },
        layout: ROW_SPRING,
      },
});

/**
 * A sidebar section heading that folds its list ("Pinned", "Chats").
 *
 * A plain disclosure button rather than Radix Collapsible: its Content hides
 * itself the instant `open` flips, which would cut the list's exit fade.
 * aria-expanded/-controls carry the state for assistive tech.
 */
function SectionToggle({
  label,
  open,
  controlsId,
  onToggle,
}: {
  label: string;
  open: boolean;
  controlsId: string;
  onToggle: () => void;
}) {
  return (
    <SidebarGroupLabel asChild>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={controlsId}
        onClick={onToggle}
        className="group/section mr-5 h-11 gap-1 px-2.5 text-left text-[13px] font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:text-foreground md:h-8"
      >
        <span>{label}</span>
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "!size-3.5 opacity-60 transition-[transform,opacity] duration-200 ease-out group-hover/section:opacity-100 group-focus-visible/section:opacity-100 motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
      </button>
    </SidebarGroupLabel>
  );
}

export default function ChatSidebar({
  conversations,
  currentConversationId,
  onSelectConversation,
  onDeleteConversation,
  onRenameConversation,
  onArchiveConversation,
  onTogglePinConversation,
  onReportConversation,
  onLoadMore,
  isLoadingMore,
  isInitialLoading,
  hasMore,
  onTitleClick,
  onNewChat,
  onOpenSearch,
  onVoiceMode,
  onOpenScheduledTasks,
  scheduledTasksRunningCount = 0,
  onOpenSettings,
  onEditProfile,
  onOpenShortcuts,
  onOpenHelp,
  onLogout,
  userProfile,
  accounts = [],
  canAddAccount = false,
  maxAccounts = 0,
  busyAccountId = null,
  onSelectAccount,
  onAddAccount,
  onLogoutAccount,
  onLogoutAllAccounts,
  dismissFloatingUiSignal = 0,
  onFloatingUiStateChange,
  sidebarInteractionHook,
}: ChatSidebarProps) {
  const { isMobile, setOpenMobile, state, toggleSidebar } = useSidebar();
  const isCollapsed = !isMobile && state === "collapsed";
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const reduceMotion = useReducedMotion();
  // Each section heading folds its list away; remembered per browser.
  const [pinnedOpen, setPinnedOpen] = React.useState(() => loadSidebarSectionOpen("pinned"));
  const [chatsOpen, setChatsOpen] = React.useState(() => loadSidebarSectionOpen("chats"));
  React.useEffect(() => {
    saveSidebarSectionOpen("pinned", pinnedOpen);
  }, [pinnedOpen]);
  React.useEffect(() => {
    saveSidebarSectionOpen("chats", chatsOpen);
  }, [chatsOpen]);
  const pinnedListId = React.useId();
  const chatsListId = React.useId();
  const rawProfileName =
    userProfile?.displayName ?? userProfile?.fullName ?? userProfile?.username ?? "";
  const profileName = rawProfileName.trim() || "Profile";
  // Two-letter avatar initials (e.g. "kostas mpouros" -> "KM"): first letters of
  // the first two name parts, or the first two characters of a single-token
  // name. Always upper-cased so the avatar reads the same however the name was
  // entered, matching the account switcher's avatars.
  const nameParts = profileName.split(/\s+/).filter(Boolean);
  const profileInitials = (
    (nameParts.length >= 2
      ? nameParts[0].charAt(0) + nameParts[1].charAt(0)
      : profileName.slice(0, 2)) || "P"
  ).toUpperCase();
  const profileEmail = (userProfile?.email ?? "Open profile").trim();
  const avatarUrl = userProfile?.avatarUrl || null;
  // Only worth a submenu when there is somewhere to switch to, or room to add
  // one. With the feature off the backend sends nothing and this stays false.
  const showAccountSwitcher = accounts.length > 1 || (accounts.length > 0 && canAddAccount);
  const [openActionMenuId, setOpenActionMenuId] = React.useState<string | null>(null);
  const [renamingConversationId, setRenamingConversationId] = React.useState<string | null>(null);
  const [renameDraft, setRenameDraft] = React.useState("");
  const [isSubmittingRename, setIsSubmittingRename] = React.useState(false);
  const renameInputRef = React.useRef<HTMLTextAreaElement | null>(null);
  const renameContainerRef = React.useRef<HTMLDivElement | null>(null);

  const handleConversationSelect = React.useCallback(
    (conversation: ConversationSummary) => {
      setOpenActionMenuId(null);
      onSelectConversation(conversation);
      if (isMobile) {
        setOpenMobile(false);
      }
    },
    [onSelectConversation, isMobile, setOpenMobile, setOpenActionMenuId],
  );

  const handleTitleClickInternal = React.useCallback(() => {
    if (isCollapsed) {
      toggleSidebar();
      return;
    }
    onTitleClick();
    if (isMobile) {
      setOpenMobile(false);
    }
  }, [isCollapsed, toggleSidebar, onTitleClick, isMobile, setOpenMobile]);

  const handleNewChatClick = React.useCallback(() => {
    onNewChat();
    if (isMobile) {
      setOpenMobile(false);
    }
  }, [onNewChat, isMobile, setOpenMobile]);

  const handleSearchClick = React.useCallback(() => {
    onOpenSearch();
    if (isMobile) {
      setOpenMobile(false);
    }
  }, [onOpenSearch, isMobile, setOpenMobile]);

  const handleVoiceModeClick = React.useCallback(() => {
    onVoiceMode?.();
    if (isMobile) {
      setOpenMobile(false);
    }
  }, [onVoiceMode, isMobile, setOpenMobile]);

  const handleScheduledTasksClick = React.useCallback(() => {
    onOpenScheduledTasks?.();
    if (isMobile) {
      setOpenMobile(false);
    }
  }, [onOpenScheduledTasks, isMobile, setOpenMobile]);

  // Profile popover (the ChatGPT-style menu on the footer account button).
  const [profileMenuOpen, setProfileMenuOpen] = React.useState(false);
  // A finger opens the sidebar's menus on the tap's click (see the hook).
  const touchMenuTrigger = useTouchMenuTrigger();
  // Mobile only: whether the profile header has expanded the account list,
  // and whether "Log out" has expanded the per-account choices.
  const [mobileAccountsOpen, setMobileAccountsOpen] = React.useState(false);
  const [mobileLogoutOpen, setMobileLogoutOpen] = React.useState(false);
  const mobileLogoutListRef = React.useRef<HTMLDivElement | null>(null);
  // Collapse both whenever the menu closes, however it closed — several paths
  // call setProfileMenuOpen(false) directly, which bypasses onOpenChange.
  React.useEffect(() => {
    if (!profileMenuOpen) {
      setMobileAccountsOpen(false);
      setMobileLogoutOpen(false);
    }
  }, [profileMenuOpen]);
  // "Log out" is the menu's last row, so its choices open below the fold of
  // the scrolling menu on a short screen — bring them into view.
  React.useEffect(() => {
    if (mobileLogoutOpen) mobileLogoutListRef.current?.scrollIntoView({ block: "nearest" });
  }, [mobileLogoutOpen]);
  const mobileSwitcher = isMobile && showAccountSwitcher;
  const handleProfileMenuAction = React.useCallback(
    (action: () => void) => {
      action();
      if (isMobile) {
        setOpenMobile(false);
      }
    },
    [isMobile, setOpenMobile],
  );

  const handleScroll: React.UIEventHandler<HTMLDivElement> = React.useCallback(
    (event) => {
      if (!chatsOpen || isLoadingMore || !hasMore) return;
      const el = event.currentTarget;
      const threshold = 16;
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - threshold) {
        onLoadMore();
      }
    },
    [chatsOpen, isLoadingMore, hasMore, onLoadMore],
  );

  // Fill a short list until it scrolls. Not while the section is folded: the
  // empty area would always look "unfilled" and page through every chat.
  React.useEffect(() => {
    if (isCollapsed || !chatsOpen || isLoadingMore || !hasMore) {
      return;
    }
    const el = contentRef.current;
    if (!el) {
      return;
    }
    if (el.scrollHeight <= el.clientHeight + 4) {
      onLoadMore();
    }
  }, [chatsOpen, conversations.length, hasMore, isCollapsed, isLoadingMore, onLoadMore]);

  const {
    isLogoHovered,
    handleSidebarMouseEnter,
    handleSidebarMouseLeave,
    toggleCollapsedOnBlankArea,
  } = sidebarInteractionHook({
    isCollapsed,
    toggleSidebar,
  });

  const handleStartRename = React.useCallback(
    (conversationId: string, currentTitle: string) => {
      if (!onRenameConversation) return;
      setOpenActionMenuId(null);
      setRenamingConversationId(conversationId);
      setRenameDraft(currentTitle);
      setIsSubmittingRename(false);
    },
    [onRenameConversation],
  );

  const handleCancelRename = React.useCallback(() => {
    setRenamingConversationId(null);
    setRenameDraft("");
    setIsSubmittingRename(false);
  }, []);

  const handleSubmitRename = React.useCallback(async () => {
    if (!renamingConversationId || !onRenameConversation) return;
    const trimmed = renameDraft.trim();
    if (isSubmittingRename) return;
    if (!trimmed) return;
    setIsSubmittingRename(true);
    try {
      await onRenameConversation(renamingConversationId, trimmed);
      setRenamingConversationId(null);
      setRenameDraft("");
    } catch (error) {
      console.error("Failed to rename conversation:", error);
    } finally {
      setIsSubmittingRename(false);
    }
  }, [isSubmittingRename, onRenameConversation, renameDraft, renamingConversationId]);

  React.useEffect(() => {
    if (!renamingConversationId) return;
    const raf = requestAnimationFrame(() => {
      if (renameInputRef.current) {
        renameInputRef.current.focus();
        renameInputRef.current.select();
      }
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        handleCancelRename();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (renameContainerRef.current && target && renameContainerRef.current.contains(target)) {
        return;
      }
      handleCancelRename();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [handleCancelRename, renamingConversationId]);

  React.useEffect(() => {
    onFloatingUiStateChange?.(
      Boolean(openActionMenuId || renamingConversationId || profileMenuOpen),
    );
  }, [onFloatingUiStateChange, openActionMenuId, renamingConversationId, profileMenuOpen]);

  const lastDismissFloatingUiSignalRef = React.useRef(dismissFloatingUiSignal);
  React.useEffect(() => {
    if (dismissFloatingUiSignal === lastDismissFloatingUiSignalRef.current) {
      return;
    }

    lastDismissFloatingUiSignalRef.current = dismissFloatingUiSignal;
    setOpenActionMenuId(null);
    setProfileMenuOpen(false);
    handleCancelRename();
  }, [dismissFloatingUiSignal, handleCancelRename]);

  const canSubmitRename = renameDraft.trim().length > 0;

  // Pinned and Chats are disjoint views over the one conversations list, so
  // every existing update (rename, delete, streaming, new message) reaches a
  // row in whichever section shows it. Pins sort newest-pinned first.
  const pinnedConversations = React.useMemo(
    () =>
      conversations
        .filter((conversation) => conversation.isPinned)
        .sort((a, b) => pinnedTime(b) - pinnedTime(a)),
    [conversations],
  );
  const chatConversations = React.useMemo(
    () => conversations.filter((conversation) => !conversation.isPinned),
    [conversations],
  );

  const showEmptyState = !isInitialLoading && !isLoadingMore && conversations.length === 0;
  const showInitialSkeleton = isInitialLoading || (isLoadingMore && conversations.length === 0);
  // Every loaded chat is pinned: say where the rest will go instead of "no conversations".
  const showAllPinnedHint =
    !showInitialSkeleton && !showEmptyState && !isLoadingMore && chatConversations.length === 0;

  // One row renderer for both sections: Pinned and Chats are views over the
  // same list, so rename, delete and the streaming spinner behave identically.
  const renderConversationRow = (conversation: ConversationSummary, index: number) => {
    const agent = conversation.agent;
    const rawTitle = typeof conversation.title === "string" ? conversation.title.trim() : "";
    const lastMessage = (conversation.lastMessage ?? "").trim();
    const fallbackTitle = lastMessage || agent?.name || "Untitled chat";
    const resolvedTitle = rawTitle || fallbackTitle;
    const isRenaming = renamingConversationId === conversation.id;
    const isActive = conversation.id === currentConversationId;

    return (
      <MotionMenuItem key={conversation.id} {...rowMotion(reduceMotion, index)}>
        <SidebarMenuButton
          size="lg"
          isActive={isActive}
          onClick={(event) => {
            if (isRenaming) {
              event.stopPropagation();
              return;
            }
            handleConversationSelect(conversation);
          }}
          tooltip={{
            children: (
              <div className="flex max-w-xs flex-col gap-0.5">
                <span className="text-sm font-medium">{resolvedTitle}</span>
                {lastMessage && (
                  <span
                    className="text-xs text-muted-foreground leading-snug"
                    style={{
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                    }}
                  >
                    {lastMessage}
                  </span>
                )}
              </div>
            ),
          }}
          // Overflow stays visible so the gliding highlight is not clipped while
          // it moves in; titles sit above it (z-[1]) in every row it passes.
          className="group/row relative !h-auto min-h-[2rem] items-center !overflow-visible rounded-xl bg-transparent px-2.5 py-1 text-left text-muted-foreground shadow-none transition-colors duration-150 supports-[hover:hover]:hover:bg-[hsl(var(--hover-surface))] supports-[hover:hover]:hover:text-foreground active:bg-[hsl(var(--hover-surface-strong))] focus-visible:bg-[hsl(var(--hover-surface))] focus-visible:text-foreground focus-visible:ring-2 data-[active=true]:font-medium data-[active=true]:text-foreground"
        >
          {isActive && (
            // The selected row's highlight, shared across rows (and sections), so it
            // glides to the newly selected chat; a short bar of the brand gradient
            // marks it.
            <motion.span
              layoutId="sidebar-active-row"
              aria-hidden
              className="absolute inset-0 z-0 rounded-xl bg-[hsl(var(--hover-surface))]"
              transition={reduceMotion ? { duration: 0 } : ROW_SPRING}
            >
              <span
                className="absolute left-[3px] top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full"
                style={{ background: "var(--gradient-primary)" }}
              />
            </motion.span>
          )}
          {isRenaming ? (
            <div
              ref={renameContainerRef}
              className="relative z-[1] flex w-full items-center gap-2 rounded-xl border border-border/60 bg-background/80 px-2 py-1"
              onClick={(event) => event.stopPropagation()}
            >
              <textarea
                ref={renameInputRef}
                rows={1}
                value={renameDraft}
                onChange={(event) => setRenameDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void handleSubmitRename();
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    handleCancelRename();
                  }
                }}
                className="h-5 min-h-[1.25rem] w-full resize-none overflow-hidden border-none bg-transparent px-1 py-0 text-sm font-medium leading-5 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-0"
                placeholder="Rename conversation"
                spellCheck={false}
              />
              <button
                type="button"
                aria-label="Confirm rename"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  void handleSubmitRename();
                }}
                disabled={!canSubmitRename || isSubmittingRename}
                className="grid size-7 flex-shrink-0 place-items-center rounded-full bg-primary text-primary-foreground shadow-md transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSubmittingRename ? (
                  <Loader size={14} className="text-primary-foreground" />
                ) : (
                  <ArrowRight className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
          ) : (
            <span className="relative z-[1] truncate text-[13px] transition-transform duration-200 ease-out motion-safe:supports-[hover:hover]:group-hover/row:translate-x-[3px]">
              {resolvedTitle}
            </span>
          )}
        </SidebarMenuButton>
        {!isRenaming &&
          (conversation.isStreaming ? (
            <SidebarMenuAction
              aria-label="Conversation is streaming"
              onClick={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
              className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground hover:!bg-transparent hover:!text-muted-foreground active:!bg-transparent focus-visible:!bg-transparent focus-visible:text-foreground peer-data-[size=lg]/menu-button:!top-1/2 peer-data-[size=lg]/menu-button:-translate-y-1/2"
            >
              <Loader size={14} />
            </SidebarMenuAction>
          ) : (
            <DropdownMenu.Root
              open={openActionMenuId === conversation.id}
              onOpenChange={(isOpen) => {
                setOpenActionMenuId(isOpen ? conversation.id : null);
              }}
            >
              <DropdownMenu.Trigger
                asChild
                {...touchMenuTrigger(() =>
                  setOpenActionMenuId((current) =>
                    current === conversation.id ? null : conversation.id,
                  ),
                )}
              >
                <SidebarMenuAction
                  aria-label="Conversation actions"
                  onClick={(event) => event.stopPropagation()}
                  onMouseDown={(event) => event.stopPropagation()}
                  onPointerDown={(event) => event.stopPropagation()}
                  showOnHover
                  className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground hover:!bg-transparent hover:!text-muted-foreground active:!bg-transparent focus-visible:!bg-transparent focus-visible:text-foreground peer-data-[size=lg]/menu-button:!top-1/2 peer-data-[size=lg]/menu-button:-translate-y-1/2"
                >
                  <MoreHorizontal size={14} />
                </SidebarMenuAction>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  side="right"
                  sideOffset={8}
                  align="end"
                  className={`z-50 w-48 rounded-lg border border-border bg-background p-1.5 text-sm text-foreground shadow-lg focus:outline-none origin-[--radix-dropdown-menu-content-transform-origin] ${RADIX_MOTION.popover}`}
                  onCloseAutoFocus={(event) => event.preventDefault()}
                >
                  <DropdownMenu.Item
                    onSelect={() => {
                      handleStartRename(conversation.id, resolvedTitle);
                    }}
                    className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1 text-sm transition-colors data-[highlighted]:bg-muted data-[highlighted]:text-foreground focus-visible:outline-none data-[highlighted]:outline-none"
                  >
                    <div className="flex h-7 w-7 items-center justify-center rounded-md bg-transparent text-muted-foreground">
                      <Pencil size={15} />
                    </div>
                    <span>Rename</span>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    onSelect={() => {
                      onTogglePinConversation?.(conversation);
                    }}
                    className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1 text-sm transition-colors data-[highlighted]:bg-muted data-[highlighted]:text-foreground focus-visible:outline-none data-[highlighted]:outline-none"
                  >
                    <div className="flex h-7 w-7 items-center justify-center rounded-md bg-transparent text-muted-foreground">
                      {conversation.isPinned ? <PinOff size={15} /> : <Pin size={15} />}
                    </div>
                    <span>{conversation.isPinned ? "Unpin" : "Pin"}</span>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    onSelect={() => {
                      onArchiveConversation?.(conversation.id);
                    }}
                    className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1 text-sm transition-colors data-[highlighted]:bg-muted data-[highlighted]:text-foreground focus-visible:outline-none data-[highlighted]:outline-none"
                  >
                    <div className="flex h-7 w-7 items-center justify-center rounded-md bg-transparent text-muted-foreground">
                      <Archive size={15} />
                    </div>
                    <span>Archive</span>
                  </DropdownMenu.Item>
                  {!conversation.isReported && (
                    <DropdownMenu.Item
                      onSelect={() => {
                        onReportConversation?.(conversation.id);
                      }}
                      className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1 text-sm transition-colors data-[highlighted]:bg-muted data-[highlighted]:text-foreground focus-visible:outline-none data-[highlighted]:outline-none"
                    >
                      <div className="flex h-7 w-7 items-center justify-center rounded-md bg-transparent text-muted-foreground">
                        <Flag size={15} />
                      </div>
                      <span>Report</span>
                    </DropdownMenu.Item>
                  )}
                  <DropdownMenu.Separator className="my-1 h-px bg-border/60" />
                  <DropdownMenu.Item
                    onSelect={() => {
                      onDeleteConversation(conversation.id);
                    }}
                    className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1 text-sm text-destructive transition-colors data-[highlighted]:bg-destructive/10 data-[highlighted]:text-destructive focus-visible:outline-none data-[highlighted]:outline-none"
                  >
                    <div className="flex h-7 w-7 items-center justify-center rounded-md bg-transparent text-destructive">
                      <Trash2 size={15} />
                    </div>
                    <span>Delete</span>
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          ))}
      </MotionMenuItem>
    );
  };

  // Shared between the desktop Help flyout and the mobile flattened section. A
  // Radix SubContent can only open left/right of its trigger; on a phone the
  // parent menu already spans the viewport, so neither side fits and the flyout
  // clips off-screen — on mobile these render inline in the main menu instead.
  // "Log out of <account>" for every signed-in account, plus log out of all.
  // Shared by the desktop flyout and the inline mobile section below.
  const logoutAccountItems = (
    <>
      {accounts.map((account) => (
        <DropdownMenu.Item
          key={account.id}
          onSelect={() => handleProfileMenuAction(() => onLogoutAccount?.(account))}
          className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors data-[highlighted]:bg-[hsl(var(--hover-surface))] focus-visible:outline-none data-[highlighted]:outline-none"
        >
          <span
            aria-hidden
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[0.65rem] font-semibold text-primary"
          >
            {(account.displayName || account.username || "?")
              .split(/\s+/)
              .slice(0, 2)
              .map((part) => part.charAt(0).toUpperCase())
              .join("")}
          </span>
          <span className="min-w-0 flex-1 truncate">
            Log out of {account.email || account.username}
          </span>
        </DropdownMenu.Item>
      ))}
      <DropdownMenu.Separator className="my-1 h-px bg-border/60" />
      <DropdownMenu.Item
        onSelect={() => handleProfileMenuAction(() => onLogoutAllAccounts?.())}
        className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-destructive transition-colors data-[highlighted]:bg-destructive/10 data-[highlighted]:text-destructive focus-visible:outline-none data-[highlighted]:outline-none"
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-destructive">
          <LogOut size={15} />
        </span>
        <span>Log out of all accounts</span>
      </DropdownMenu.Item>
    </>
  );

  const helpMenuItems = (
    <>
      <DropdownMenu.Item
        onSelect={() => handleProfileMenuAction(onOpenHelp)}
        className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1 transition-colors data-[highlighted]:bg-[hsl(var(--hover-surface))] focus-visible:outline-none data-[highlighted]:outline-none"
      >
        <div className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground">
          <HelpCircle size={15} />
        </div>
        <span>Help center</span>
      </DropdownMenu.Item>
      <DropdownMenu.Item
        onSelect={() => handleProfileMenuAction(onOpenShortcuts)}
        className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1 transition-colors data-[highlighted]:bg-[hsl(var(--hover-surface))] focus-visible:outline-none data-[highlighted]:outline-none"
      >
        <div className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground">
          <Keyboard size={15} />
        </div>
        <span>Keyboard shortcuts</span>
      </DropdownMenu.Item>
      <DropdownMenu.Separator className="my-1 h-px bg-border/60" />
      <DropdownMenu.Item asChild>
        <a
          href="/terms"
          target="_blank"
          rel="noreferrer"
          className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1 transition-colors data-[highlighted]:bg-[hsl(var(--hover-surface))] focus-visible:outline-none data-[highlighted]:outline-none"
        >
          <div className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground">
            <FileText size={15} />
          </div>
          <span>Terms of Service</span>
        </a>
      </DropdownMenu.Item>
      <DropdownMenu.Item asChild>
        <a
          href="/privacy"
          target="_blank"
          rel="noreferrer"
          className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1 transition-colors data-[highlighted]:bg-[hsl(var(--hover-surface))] focus-visible:outline-none data-[highlighted]:outline-none"
        >
          <div className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground">
            <ShieldCheck size={15} />
          </div>
          <span>Privacy Policy</span>
        </a>
      </DropdownMenu.Item>
    </>
  );

  return (
    <SidebarRoot
      collapsible="icon"
      // A transparent rail on the shell's tinted frame (WorkspaceShell); the
      // chat card beside it carries the edge, so no border here.
      className="relative overflow-hidden border-r-0 bg-transparent [&_[data-sidebar=sidebar]]:bg-transparent [&_[data-sidebar=sidebar]]:text-foreground"
      onMouseEnter={handleSidebarMouseEnter}
      onMouseLeave={handleSidebarMouseLeave}
    >
      <SidebarHeader className="gap-4 px-2 pb-2 pt-4">
        <SidebarMenu className="!gap-0">
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              tooltip="Go to workspace"
              onClick={handleTitleClickInternal}
              className={cn(
                // The same px-1.5 lead in both states (and h-12): the logo sits at
                // the same x and y as every icon below it whether the rail is open
                // or collapsed, so toggling never moves it.
                `group items-center gap-2 rounded-xl bg-transparent px-1.5 py-0 text-left transition supports-[hover:hover]:${INTERACTIVE_SURFACE}`,
              )}
            >
              <div className="relative flex h-9 w-9 flex-shrink-0 items-center justify-center overflow-hidden rounded-lg transition bg-transparent">
                <BrandLogo
                  label="mAgenticX logo"
                  className={cn(
                    "h-full w-full transition-opacity",
                    isCollapsed && isLogoHovered ? "opacity-0" : "opacity-100",
                  )}
                />
                <PanelLeft
                  className={cn(
                    "absolute inset-0 h-full w-full p-2 text-foreground transition-opacity",
                    isCollapsed && isLogoHovered ? "opacity-100" : "opacity-0",
                  )}
                />
              </div>
              <div className={cn("flex min-w-0 flex-col text-left", RAIL_LABEL)}>
                <span className="truncate text-sm font-semibold text-foreground">mAgenticX</span>
                <span className="truncate text-xs text-muted-foreground">Workspace</span>
              </div>
            </SidebarMenuButton>
            <SidebarMenuAction
              asChild
              showOnHover={false}
              className={cn("right-2 top-1.5 -translate-y-0.5", RAIL_LABEL)}
            >
              <SidebarTrigger
                className={`size-9 [&_svg]:h-5 [&_svg]:w-5 supports-[hover:hover]:${INTERACTIVE_SURFACE}`}
              />
            </SidebarMenuAction>
          </SidebarMenuItem>
        </SidebarMenu>

        <SidebarMenu className="!gap-0">
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              onClick={handleNewChatClick}
              className={cn(
                // A card when the rail is open; the plain icon row when collapsed.
                // Its 1px border + px-[5px] make the same 6px lead as the px-1.5
                // rows below, so the icon never moves.
                "group/nav !flex !h-10 items-center gap-1 rounded-xl border border-border/70 bg-background px-[5px] py-0 text-sm font-medium text-foreground shadow-sm transition-colors supports-[hover:hover]:hover:bg-[hsl(var(--hover-surface))]",
                "group-data-[collapsible=icon]:border-transparent group-data-[collapsible=icon]:bg-transparent group-data-[collapsible=icon]:shadow-none",
              )}
              tooltip="New chat"
            >
              <div className="grid size-9 flex-shrink-0 place-items-center">
                {/* 20px, not the 18px of the rows below: an outlined square reads
                    smaller than a magnifier or a waveform at the same box size. */}
                <NewChatIcon
                  className={`!h-5 !w-5 ${NAV_ICON_MOTION} motion-safe:supports-[hover:hover]:group-hover/nav:-rotate-12`}
                />
              </div>
              <span className={RAIL_LABEL}>New chat</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>

        <SidebarMenu className="!gap-0.5">
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              onClick={handleSearchClick}
              className={cn(
                // Frozen by construction: a constant px-1.5 lead + full width in both
                // states keeps the icon pinned at the same x (centered when collapsed,
                // see SIDEBAR_WIDTH_ICON), so only the rail width animates around it.
                `group/nav !flex !h-9 gap-1 items-center rounded-xl bg-transparent px-1.5 py-0 text-sm text-foreground/90 transition-colors supports-[hover:hover]:${INTERACTIVE_SURFACE}`,
              )}
              tooltip="Search"
            >
              <div className="grid size-9 flex-shrink-0 place-items-center">
                <Search className={`!h-[18px] !w-[18px] ${NAV_ICON_MOTION}`} />
              </div>
              <span className={RAIL_LABEL}>Search</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              onClick={handleVoiceModeClick}
              className={cn(
                `group/nav !flex !h-9 gap-1 items-center rounded-xl bg-transparent px-1.5 py-0 text-sm text-foreground/90 transition-colors supports-[hover:hover]:${INTERACTIVE_SURFACE}`,
              )}
              tooltip="Voice mode"
            >
              <div className="grid size-9 flex-shrink-0 place-items-center">
                <PiWaveformBold className={`!h-[18px] !w-[18px] ${NAV_ICON_MOTION}`} />
              </div>
              <span className={RAIL_LABEL}>Voice mode</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              onClick={handleScheduledTasksClick}
              className={cn(
                `group/nav !flex !h-9 gap-1 items-center rounded-xl bg-transparent px-1.5 py-0 text-sm text-foreground/90 transition-colors supports-[hover:hover]:${INTERACTIVE_SURFACE}`,
              )}
              tooltip="Schedules"
            >
              <div className="relative grid size-9 flex-shrink-0 place-items-center">
                <MdOutlineSchedule className={`!h-[18px] !w-[18px] ${NAV_ICON_MOTION}`} />
                {scheduledTasksRunningCount > 0 ? (
                  <span
                    className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground"
                    aria-label={`${scheduledTasksRunningCount} running`}
                  >
                    {scheduledTasksRunningCount}
                  </span>
                ) : null}
              </div>
              <span className={RAIL_LABEL}>Schedules</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      {/* The body itself never scrolls: the "Chats" heading stays pinned and
          only the conversation list below it scrolls (and pages in more). */}
      <SidebarContent
        className="flex-1 overflow-hidden pl-3 pr-0 pt-2"
        onClick={toggleCollapsedOnBlankArea}
      >
        {!isCollapsed && (
          <div className={cn("flex min-h-0 flex-1 flex-col", RAIL_REVEAL)}>
            {/* No pins, no section: it appears with the first pin and leaves with the last. */}
            <AnimatePresence initial={false}>
              {pinnedConversations.length > 0 && (
                <motion.div
                  key="pinned-section"
                  className="shrink-0"
                  {...sectionListMotion(reduceMotion)}
                >
                  <SidebarGroup className="gap-2 pb-0 pr-0">
                    <SectionToggle
                      label="Pinned"
                      open={pinnedOpen}
                      controlsId={pinnedListId}
                      onToggle={() => setPinnedOpen((open) => !open)}
                    />
                    <AnimatePresence initial={false}>
                      {pinnedOpen && (
                        <motion.div
                          key="pinned-list"
                          id={pinnedListId}
                          data-sidebar="chats-list"
                          // Capped so a long pin list scrolls on its own and
                          // never pushes Chats off the screen.
                          className="max-h-[30dvh] overflow-y-auto pr-5"
                          // Lets the rows' layout animations account for this list's scroll.
                          layoutScroll
                          {...sectionListMotion(reduceMotion)}
                        >
                          <SidebarGroupContent>
                            <SidebarMenu className="!gap-0">
                              <AnimatePresence>
                                {pinnedConversations.map(renderConversationRow)}
                              </AnimatePresence>
                            </SidebarMenu>
                          </SidebarGroupContent>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </SidebarGroup>
                </motion.div>
              )}
            </AnimatePresence>
            <SidebarGroup className="min-h-0 flex-1 gap-2 pb-0 pr-0">
              <SectionToggle
                label="Chats"
                open={chatsOpen}
                controlsId={chatsListId}
                onToggle={() => setChatsOpen((open) => !open)}
              />
              <AnimatePresence initial={false}>
                {chatsOpen && (
                  <motion.div
                    key="chats-list"
                    id={chatsListId}
                    ref={contentRef}
                    onScroll={handleScroll}
                    data-sidebar="chats-list"
                    // Flush with the sidebar's right edge so the scrollbar sits
                    // there; pr-5 keeps the rows where they were before.
                    className="min-h-0 flex-1 overflow-y-auto pb-4 pr-5"
                    layoutScroll
                    {...sectionListMotion(reduceMotion)}
                  >
                    <SidebarGroupContent className="min-h-0 flex-1 space-y-2">
                      {showInitialSkeleton ? (
                        <ConversationLoadingSkeleton />
                      ) : showEmptyState ? (
                        <div className="flex flex-col items-center justify-center gap-1.5 rounded-lg bg-muted/10 py-10 text-center text-muted-foreground">
                          <MessageSquare size={28} className="mb-3 text-muted-foreground/60" />
                          <p className="text-sm">No conversations yet</p>
                        </div>
                      ) : (
                        <SidebarMenu className="!gap-0">
                          <AnimatePresence>
                            {chatConversations.map(renderConversationRow)}
                          </AnimatePresence>
                        </SidebarMenu>
                      )}
                      {showAllPinnedHint && (
                        <p className="px-2 py-2 text-xs text-muted-foreground">
                          Chats you haven&apos;t pinned show up here.
                        </p>
                      )}
                      {!showInitialSkeleton && isLoadingMore && <ConversationLoadingSkeleton />}
                    </SidebarGroupContent>
                  </motion.div>
                )}
              </AnimatePresence>
            </SidebarGroup>
          </div>
        )}
      </SidebarContent>

      <SidebarFooter className="px-2 pb-3 pt-2">
        <SidebarMenu className="!gap-0">
          <SidebarMenuItem>
            <DropdownMenu.Root open={profileMenuOpen} onOpenChange={setProfileMenuOpen}>
              {/* Tooltip composed manually (not via SidebarMenuButton's `tooltip` prop):
                  the dropdown trigger must slot straight onto the real <button> — the
                  prop variant would wrap it in a Tooltip and break the asChild chain. */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenu.Trigger
                    asChild
                    {...touchMenuTrigger(() => setProfileMenuOpen((open) => !open))}
                  >
                    <SidebarMenuButton
                      size="lg"
                      className={cn(
                        // A card when the rail is open, like New chat; frozen by construction:
                        // the same h-14 and the same 6px lead (1px border + px-[5px]) in both
                        // states keep the avatar pinned at the same x and y (centered when
                        // collapsed, see SIDEBAR_WIDTH_ICON), so toggling never shifts it.
                        "!flex !h-14 items-center gap-2 rounded-2xl border border-border/60 bg-background px-[5px] py-2 shadow-sm transition-colors supports-[hover:hover]:hover:bg-[hsl(var(--hover-surface))]",
                        "group-data-[collapsible=icon]:border-transparent group-data-[collapsible=icon]:bg-transparent group-data-[collapsible=icon]:shadow-none",
                        "group-data-[collapsible=icon]:supports-[hover:hover]:hover:bg-transparent group-data-[collapsible=icon]:focus-visible:bg-transparent group-data-[collapsible=icon]:active:bg-transparent",
                        profileMenuOpen && "bg-[hsl(var(--hover-surface))]",
                      )}
                    >
                      <div className="grid size-9 flex-shrink-0 place-items-center overflow-hidden rounded-full bg-primary text-primary-foreground">
                        {avatarUrl ? (
                          <img
                            src={avatarUrl}
                            alt={profileName}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <span className="text-sm font-semibold">{profileInitials}</span>
                        )}
                      </div>
                      <div className={cn("flex min-w-0 flex-1 flex-col", RAIL_LABEL)}>
                        <span className="truncate text-sm font-medium text-foreground">
                          {profileName}
                        </span>
                        <span className="truncate text-xs text-muted-foreground">
                          {profileEmail}
                        </span>
                      </div>
                      <ChevronsUpDown
                        className={cn(
                          "ml-auto h-4 w-4 flex-shrink-0 text-muted-foreground",
                          RAIL_LABEL,
                        )}
                      />
                    </SidebarMenuButton>
                  </DropdownMenu.Trigger>
                </TooltipTrigger>
                <TooltipContent
                  side="right"
                  align="center"
                  hidden={state !== "collapsed" || isMobile || profileMenuOpen}
                >
                  <div className="flex flex-col text-left">
                    <span className="text-sm font-semibold">{profileName}</span>
                    <span className="text-xs text-muted-foreground">{profileEmail}</span>
                  </div>
                </TooltipContent>
              </Tooltip>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  side={isCollapsed ? "right" : "top"}
                  sideOffset={10}
                  align={isCollapsed ? "end" : "start"}
                  // Scroll rather than overflow: on mobile the account rows render
                  // inline (below), so the menu can outgrow a short screen.
                  className={`z-50 max-h-[var(--radix-dropdown-menu-content-available-height)] w-64 overflow-y-auto rounded-xl border border-border bg-background p-1.5 text-sm text-foreground shadow-xl focus:outline-none origin-[--radix-dropdown-menu-content-transform-origin] ${RADIX_MOTION.popover}`}
                  onCloseAutoFocus={(event) => event.preventDefault()}
                >
                  {/* Identity header. With other accounts available it becomes a
                      submenu holding the switcher; otherwise it stays what it was
                      and opens the Edit profile dialog. Radix's Sub opens on hover
                      *and* on click/keyboard, so the switcher is reachable by
                      touch and by arrow keys without extra handling. On mobile the
                      switcher renders inline below instead — a side flyout has no
                      room beside the menu on a phone and hangs off the screen. */}
                  {showAccountSwitcher && !isMobile ? (
                    <DropdownMenu.Sub>
                      <DropdownMenu.SubTrigger className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-2 transition-colors data-[highlighted]:bg-[hsl(var(--hover-surface))] data-[state=open]:bg-[hsl(var(--hover-surface))] focus-visible:outline-none data-[highlighted]:outline-none">
                        <div className="sidebar-icon-badge grid size-9 flex-shrink-0 place-items-center overflow-hidden rounded-xl text-primary">
                          {avatarUrl ? (
                            <img
                              src={avatarUrl}
                              alt={profileName}
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <span className="text-sm font-semibold">{profileInitials}</span>
                          )}
                        </div>
                        <div className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate text-sm font-medium text-foreground">
                            {profileName}
                          </span>
                          <span className="truncate text-xs text-muted-foreground">
                            {profileEmail}
                          </span>
                        </div>
                        <ChevronRight
                          size={15}
                          className="ml-auto flex-shrink-0 text-muted-foreground"
                        />
                      </DropdownMenu.SubTrigger>
                      <DropdownMenu.Portal>
                        <DropdownMenu.SubContent
                          sideOffset={8}
                          className={`z-50 rounded-xl border border-border bg-background text-sm text-foreground shadow-xl focus:outline-none origin-[--radix-dropdown-menu-content-transform-origin] ${RADIX_MOTION.popover}`}
                        >
                          <AccountMenu
                            accounts={accounts}
                            canAddAccount={canAddAccount}
                            maxAccounts={maxAccounts}
                            busyAccountId={busyAccountId}
                            onSelectAccount={(account) => {
                              setProfileMenuOpen(false);
                              onSelectAccount?.(account);
                            }}
                            onAddAccount={() => {
                              setProfileMenuOpen(false);
                              onAddAccount?.();
                            }}
                          />
                        </DropdownMenu.SubContent>
                      </DropdownMenu.Portal>
                    </DropdownMenu.Sub>
                  ) : (
                    <DropdownMenu.Item
                      // On mobile with other accounts available, this row is the
                      // switcher: it expands the account list in place (a side
                      // flyout has no room on a phone). Otherwise it opens the
                      // Edit profile dialog, as it always has.
                      onSelect={(event) => {
                        if (mobileSwitcher) {
                          event.preventDefault(); // keep the menu open
                          setMobileAccountsOpen((open) => !open);
                          return;
                        }
                        handleProfileMenuAction(onEditProfile);
                      }}
                      aria-expanded={mobileSwitcher ? mobileAccountsOpen : undefined}
                      aria-controls={mobileSwitcher ? "mobile-account-list" : undefined}
                      className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-2 transition-colors data-[highlighted]:bg-[hsl(var(--hover-surface))] focus-visible:outline-none data-[highlighted]:outline-none"
                    >
                      <div className="sidebar-icon-badge grid size-9 flex-shrink-0 place-items-center overflow-hidden rounded-xl text-primary">
                        {avatarUrl ? (
                          <img
                            src={avatarUrl}
                            alt={profileName}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <span className="text-sm font-semibold">{profileInitials}</span>
                        )}
                      </div>
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm font-medium text-foreground">
                          {profileName}
                        </span>
                        <span className="truncate text-xs text-muted-foreground">
                          {profileEmail}
                        </span>
                      </div>
                      <ChevronRight
                        size={15}
                        aria-hidden
                        className={cn(
                          "ml-auto flex-shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none",
                          mobileAccountsOpen && "rotate-90",
                        )}
                      />
                    </DropdownMenu.Item>
                  )}

                  {mobileSwitcher && mobileAccountsOpen ? (
                    <div
                      id="mobile-account-list"
                      className="animate-in fade-in-0 slide-in-from-top-1 duration-150 motion-reduce:animate-none"
                    >
                      <AccountMenuItems
                        accounts={accounts}
                        canAddAccount={canAddAccount}
                        maxAccounts={maxAccounts}
                        busyAccountId={busyAccountId}
                        onSelectAccount={(account) => {
                          setProfileMenuOpen(false);
                          handleProfileMenuAction(() => onSelectAccount?.(account));
                        }}
                        onAddAccount={() => {
                          setProfileMenuOpen(false);
                          handleProfileMenuAction(() => onAddAccount?.());
                        }}
                      />
                    </div>
                  ) : null}

                  <DropdownMenu.Separator className="my-1 h-px bg-border/60" />

                  <DropdownMenu.Item
                    onSelect={() =>
                      handleProfileMenuAction(() => onOpenSettings("personalization"))
                    }
                    className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1 transition-colors data-[highlighted]:bg-[hsl(var(--hover-surface))] focus-visible:outline-none data-[highlighted]:outline-none"
                  >
                    <div className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground">
                      <Palette size={15} />
                    </div>
                    <span>Personalization</span>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    onSelect={() => handleProfileMenuAction(onEditProfile)}
                    className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1 transition-colors data-[highlighted]:bg-[hsl(var(--hover-surface))] focus-visible:outline-none data-[highlighted]:outline-none"
                  >
                    <div className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground">
                      <UserRound size={15} />
                    </div>
                    <span>Profile</span>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    onSelect={() => handleProfileMenuAction(() => onOpenSettings("general"))}
                    className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1 transition-colors data-[highlighted]:bg-[hsl(var(--hover-surface))] focus-visible:outline-none data-[highlighted]:outline-none"
                  >
                    <div className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground">
                      <Settings size={15} />
                    </div>
                    <span>Settings</span>
                  </DropdownMenu.Item>

                  <DropdownMenu.Separator className="my-1 h-px bg-border/60" />

                  {isMobile ? (
                    helpMenuItems
                  ) : (
                    <DropdownMenu.Sub>
                      <DropdownMenu.SubTrigger className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1 transition-colors data-[highlighted]:bg-[hsl(var(--hover-surface))] data-[state=open]:bg-[hsl(var(--hover-surface))] focus-visible:outline-none data-[highlighted]:outline-none">
                        <div className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground">
                          <LifeBuoy size={15} />
                        </div>
                        <span>Help</span>
                        <ChevronRight size={15} className="ml-auto text-muted-foreground" />
                      </DropdownMenu.SubTrigger>
                      <DropdownMenu.Portal>
                        <DropdownMenu.SubContent
                          sideOffset={8}
                          className={`z-50 w-56 rounded-xl border border-border bg-background p-1.5 text-sm text-foreground shadow-xl focus:outline-none origin-[--radix-dropdown-menu-content-transform-origin] ${RADIX_MOTION.popover}`}
                        >
                          {helpMenuItems}
                        </DropdownMenu.SubContent>
                      </DropdownMenu.Portal>
                    </DropdownMenu.Sub>
                  )}

                  <DropdownMenu.Separator className="my-1 h-px bg-border/60" />

                  {accounts.length > 1 && isMobile ? (
                    /* Mobile: one "Log out" row that expands the choices in place,
                       like the account header above — a flyout has no room beside
                       the menu on a phone. */
                    <>
                      <DropdownMenu.Item
                        onSelect={(event) => {
                          event.preventDefault(); // keep the menu open
                          setMobileLogoutOpen((open) => !open);
                        }}
                        aria-expanded={mobileLogoutOpen}
                        aria-controls="mobile-logout-list"
                        className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1 text-destructive transition-colors data-[highlighted]:bg-destructive/10 data-[highlighted]:text-destructive focus-visible:outline-none data-[highlighted]:outline-none"
                      >
                        <div className="flex h-7 w-7 items-center justify-center rounded-md text-destructive">
                          <LogOut size={15} />
                        </div>
                        <span>Log out</span>
                        <ChevronRight
                          size={15}
                          aria-hidden
                          className={cn(
                            "ml-auto flex-shrink-0 text-destructive/70 transition-transform duration-200 motion-reduce:transition-none",
                            mobileLogoutOpen && "rotate-90",
                          )}
                        />
                      </DropdownMenu.Item>
                      {mobileLogoutOpen ? (
                        <div
                          id="mobile-logout-list"
                          ref={mobileLogoutListRef}
                          className="animate-in fade-in-0 slide-in-from-top-1 duration-150 motion-reduce:animate-none"
                        >
                          {logoutAccountItems}
                        </div>
                      ) : null}
                    </>
                  ) : accounts.length > 1 ? (
                    /* With several accounts signed in, "Log out" has to ask which
                       one — otherwise the only way to sign out of a specific
                       account is to switch to it first. Same submenu pattern as
                       Help and the account switcher above. */
                    <DropdownMenu.Sub>
                      <DropdownMenu.SubTrigger className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1 text-destructive transition-colors data-[highlighted]:bg-destructive/10 data-[highlighted]:text-destructive data-[state=open]:bg-destructive/10 focus-visible:outline-none data-[highlighted]:outline-none">
                        <div className="flex h-7 w-7 items-center justify-center rounded-md text-destructive">
                          <LogOut size={15} />
                        </div>
                        <span>Log out</span>
                        <ChevronRight size={15} className="ml-auto text-destructive/70" />
                      </DropdownMenu.SubTrigger>
                      <DropdownMenu.Portal>
                        <DropdownMenu.SubContent
                          sideOffset={8}
                          className={`z-50 w-[19rem] rounded-xl border border-border bg-background p-1.5 text-sm text-foreground shadow-xl focus:outline-none origin-[--radix-dropdown-menu-content-transform-origin] ${RADIX_MOTION.popover}`}
                        >
                          {logoutAccountItems}
                        </DropdownMenu.SubContent>
                      </DropdownMenu.Portal>
                    </DropdownMenu.Sub>
                  ) : (
                    <DropdownMenu.Item
                      onSelect={() => handleProfileMenuAction(onLogout)}
                      className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1 text-destructive transition-colors data-[highlighted]:bg-destructive/10 data-[highlighted]:text-destructive focus-visible:outline-none data-[highlighted]:outline-none"
                    >
                      <div className="flex h-7 w-7 items-center justify-center rounded-md text-destructive">
                        <LogOut size={15} />
                      </div>
                      <span>Log out</span>
                    </DropdownMenu.Item>
                  )}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </SidebarRoot>
  );
}
