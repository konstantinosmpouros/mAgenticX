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
  Workflow,
} from "lucide-react";
import { PiWaveformBold } from "react-icons/pi";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Loader } from "@/shared/ui/shadcn-io/loader";

import type {
  AccountSummary,
  ConversationSummary,
  UserProfile,
  Workflow as WorkflowSummary,
} from "@/shared/lib/types";
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
import { AgentsIcon } from "@/shared/ui/agents-icon";
import { BrandLogo } from "@/shared/ui/brand-logo";
import { INTERACTIVE_SURFACE } from "@/shared/lib/consts";
import { useTouchMenuTrigger } from "@/features/chat/hooks/useTouchMenuTrigger";
import { loadSidebarSectionOpen, saveSidebarSectionOpen } from "@/shared/lib/sidebarStorage";
import { RADIX_MOTION } from "@/shared/lib/motion/panels";
import {
  PAGE_GLIDE,
  ROW_SPRING,
  SIDEBAR_PAGE_LAYOUT_ID,
  SIDEBAR_ROW_LAYOUT_ID,
  rowMotion,
  sectionListMotion,
} from "@/features/chat/lib/sidebarMotion";

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
  /** Open the Automations page ("/automations"). */
  onOpenAutomations?: () => void;
  /** Automations with a live run: the badge on the Automations entry. */
  automationsRunningCount?: number;
  /** Open the Agents section ("/agents"). */
  onOpenAgents?: () => void;
  /** The page open over the chat, if any — its menu entry is highlighted. */
  activePage?: "automations" | "agents" | null;
  /** The user's workflows: one entry each in the Workflows section (hidden when there are none). */
  workflows?: WorkflowSummary[];
  /** The workflow whose view is open, if any — its entry is highlighted. */
  activeWorkflowId?: string | null;
  /** Open a workflow's view ("/workflows/:id"). */
  onOpenWorkflow?: (workflowId: string) => void;
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
// A page entry (Automations, Agents) while its page is open: the highlight is the
// motion span inside it, so the button's own active fill stays off, and the
// label reads as selected like the open conversation's title.
const PAGE_ENTRY_ACTIVE =
  "data-[active=true]:bg-transparent data-[active=true]:font-medium data-[active=true]:text-foreground";
/** The active page's icon takes the theme's colour, on its pill. */
const PAGE_ICON_ACTIVE = "group-data-[active=true]/nav:text-[hsl(var(--primary))]";

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

/**
 * One folding section of the sidebar (Workflows, Pinned, Chats): the heading
 * and the list it folds. The three share this one path, so they expand and
 * collapse alike: the list fades in and drops into place
 * (`sectionListMotion`), its rows fade in on a short stagger (`rowMotion`, see
 * `SidebarSectionRows`), and on collapse it all mirrors back out.
 */
function SidebarSection({
  label,
  open,
  onToggle,
  listId,
  groupClassName,
  listClassName,
  contentClassName,
  listRef,
  onScroll,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  listId: string;
  groupClassName?: string;
  /** The list's own box: its cap (a long list scrolls on its own) and padding. */
  listClassName?: string;
  contentClassName?: string;
  listRef?: React.Ref<HTMLDivElement>;
  onScroll?: React.UIEventHandler<HTMLDivElement>;
  children: React.ReactNode;
}) {
  const reduceMotion = useReducedMotion();
  return (
    <SidebarGroup className={cn("gap-2 pb-0 pr-0", groupClassName)}>
      <SectionToggle label={label} open={open} controlsId={listId} onToggle={onToggle} />
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="list"
            id={listId}
            ref={listRef}
            onScroll={onScroll}
            // The chat lists' scrollbar styling (scrollbars.css).
            data-sidebar="chats-list"
            data-motion="section-list"
            className={cn("overflow-y-auto pr-5", listClassName)}
            // Lets the rows' layout animations account for this list's scroll.
            layoutScroll
            {...sectionListMotion(reduceMotion)}
          >
            <SidebarGroupContent className={contentClassName}>{children}</SidebarGroupContent>
          </motion.div>
        )}
      </AnimatePresence>
    </SidebarGroup>
  );
}

/** A section's rows: they fade in (staggered) as the list opens, and leave sliding out. */
function SidebarSectionRows({ children }: { children: React.ReactNode }) {
  return (
    <SidebarMenu className="!gap-0">
      <AnimatePresence>{children}</AnimatePresence>
    </SidebarMenu>
  );
}

/**
 * The one row of the sidebar's lists (Workflows, Pinned, Chats): the same
 * chrome, hover/press/focus surfaces, nudge-on-hover title, and the selected
 * row's highlight. The highlight shares one layoutId across every list, so it
 * glides between a chat and a workflow exactly as it does between two chats.
 *
 * `reserveActionSpace` keeps a row with no actions menu (a workflow) aligned
 * with the rows that have one: SidebarMenuButton pads itself (pr-8) only when
 * its item holds a SidebarMenuAction.
 */
const SidebarListRow = React.forwardRef<
  HTMLButtonElement,
  Omit<React.ComponentProps<typeof SidebarMenuButton>, "size" | "isActive"> & {
    isActive: boolean;
    reserveActionSpace?: boolean;
  }
>(({ isActive, reserveActionSpace = false, className, children, ...props }, ref) => {
  const reduceMotion = useReducedMotion();
  return (
    <SidebarMenuButton
      ref={ref}
      size="lg"
      isActive={isActive}
      // Overflow stays visible so the gliding highlight is not clipped while
      // it moves in; titles sit above it (z-[1]) in every row it passes.
      className={cn(
        "group/row relative !h-auto min-h-[2rem] items-center !overflow-visible rounded-xl bg-transparent px-2.5 py-1 text-left text-muted-foreground shadow-none transition-colors duration-150 supports-[hover:hover]:hover:bg-[hsl(var(--hover-surface))] supports-[hover:hover]:hover:text-foreground active:bg-[hsl(var(--hover-surface-strong))] focus-visible:bg-[hsl(var(--hover-surface))] focus-visible:text-foreground focus-visible:ring-2 data-[active=true]:font-medium data-[active=true]:text-foreground",
        reserveActionSpace && "pr-8",
        className,
      )}
      {...props}
    >
      {isActive && (
        // The selected row's highlight, shared across rows (and sections), so it
        // glides to the newly selected row; a short bar of the brand gradient
        // marks it.
        <motion.span
          layoutId={SIDEBAR_ROW_LAYOUT_ID}
          data-layout-id={SIDEBAR_ROW_LAYOUT_ID}
          aria-hidden
          data-indicator="row"
          className="absolute inset-0 z-0 rounded-xl bg-[hsl(var(--hover-surface))]"
          transition={reduceMotion ? { duration: 0 } : ROW_SPRING}
        >
          <span
            className="absolute left-[3px] top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full"
            style={{ background: "var(--gradient-primary)" }}
          />
        </motion.span>
      )}
      {children}
    </SidebarMenuButton>
  );
});
SidebarListRow.displayName = "SidebarListRow";

/** A list row's title: truncated, above the highlight, nudged right on hover. */
function SidebarListRowTitle({ children }: { children: React.ReactNode }) {
  return (
    <span className="relative z-[1] truncate text-[13px] transition-transform duration-200 ease-out motion-safe:supports-[hover:hover]:group-hover/row:translate-x-[3px]">
      {children}
    </span>
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
  onOpenAutomations,
  automationsRunningCount = 0,
  onOpenAgents,
  activePage = null,
  workflows = [],
  activeWorkflowId = null,
  onOpenWorkflow,
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
  const [workflowsOpen, setWorkflowsOpen] = React.useState(() =>
    loadSidebarSectionOpen("workflows"),
  );
  const [pinnedOpen, setPinnedOpen] = React.useState(() => loadSidebarSectionOpen("pinned"));
  const [chatsOpen, setChatsOpen] = React.useState(() => loadSidebarSectionOpen("chats"));
  React.useEffect(() => {
    saveSidebarSectionOpen("workflows", workflowsOpen);
  }, [workflowsOpen]);
  React.useEffect(() => {
    saveSidebarSectionOpen("pinned", pinnedOpen);
  }, [pinnedOpen]);
  React.useEffect(() => {
    saveSidebarSectionOpen("chats", chatsOpen);
  }, [chatsOpen]);
  const workflowsListId = React.useId();
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

  const handleAutomationsClick = React.useCallback(() => {
    onOpenAutomations?.();
    if (isMobile) {
      setOpenMobile(false);
    }
  }, [onOpenAutomations, isMobile, setOpenMobile]);

  const handleWorkflowClick = React.useCallback(
    (workflowId: string) => {
      setOpenActionMenuId(null);
      onOpenWorkflow?.(workflowId);
      if (isMobile) {
        setOpenMobile(false);
      }
    },
    [onOpenWorkflow, isMobile, setOpenMobile],
  );

  const handleAgentsClick = React.useCallback(() => {
    onOpenAgents?.();
    if (isMobile) {
      setOpenMobile(false);
    }
  }, [onOpenAgents, isMobile, setOpenMobile]);

  // The open page's entry wears the selected conversation row's highlight (the
  // hover surface and the brand bar), gliding between Automations and Agents. Its
  // own layoutId: a page and a chat are never open at once, but the two lists
  // animate independently.
  const pageHighlight = (page: "automations" | "agents") =>
    activePage === page ? (
      // A soft pill in the theme's colour (no side bar): it reads at a glance in
      // the open rail and in the collapsed one. Between the pages it glides on a
      // short ease-out tween, position only: no spring overshoot, no stretch.
      <motion.span
        layoutId={SIDEBAR_PAGE_LAYOUT_ID}
        data-layout-id={SIDEBAR_PAGE_LAYOUT_ID}
        layout="position"
        aria-hidden
        data-indicator="page"
        className="absolute inset-0 z-0 rounded-xl bg-[hsl(var(--primary)/0.1)] ring-1 ring-inset ring-[hsl(var(--primary)/0.16)]"
        transition={reduceMotion ? { duration: 0 } : PAGE_GLIDE}
      />
    ) : null;

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

  // A workflow's entry: the conversation row itself (SidebarListRow, whose
  // gliding highlight is shared with the chat rows), with no actions menu —
  // the workflow view is where a workflow is acted on — but the menu's space
  // kept, so titles truncate at the same edge.
  const renderWorkflowRow = (workflow: WorkflowSummary, index: number) => {
    const isActive = workflow.id === activeWorkflowId;
    return (
      <MotionMenuItem key={workflow.id} data-motion="row" {...rowMotion(reduceMotion, index)}>
        <SidebarListRow
          isActive={isActive}
          reserveActionSpace
          aria-current={isActive ? "page" : undefined}
          onClick={() => handleWorkflowClick(workflow.id)}
          tooltip={{
            children: (
              <div className="flex max-w-xs flex-col gap-0.5">
                <span className="text-sm font-medium">{workflow.name}</span>
                {workflow.description && (
                  <span className="text-xs leading-snug text-muted-foreground">
                    {workflow.description}
                  </span>
                )}
              </div>
            ),
          }}
        >
          {/* A workflow reads apart from a chat at a glance: its glyph first. */}
          <span
            aria-hidden
            data-testid="sidebar-workflow-icon"
            className={cn(
              "relative z-[1] flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md transition-colors duration-150",
              isActive
                ? "bg-primary/[0.14] text-primary"
                : "bg-primary/[0.07] text-primary/70 group-hover/row:text-primary",
            )}
          >
            <Workflow className="!h-3 !w-3" />
          </span>
          <SidebarListRowTitle>{workflow.name}</SidebarListRowTitle>
        </SidebarListRow>
      </MotionMenuItem>
    );
  };

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
      <MotionMenuItem key={conversation.id} data-motion="row" {...rowMotion(reduceMotion, index)}>
        <SidebarListRow
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
        >
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
            <SidebarListRowTitle>{resolvedTitle}</SidebarListRowTitle>
          )}
        </SidebarListRow>
        {!isRenaming &&
          (conversation.isStreaming || conversation.hasActiveTasks ? (
            <SidebarMenuAction
              aria-label={
                conversation.isStreaming
                  ? "Conversation is streaming"
                  : "Background sub-agents are working"
              }
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
      <SidebarHeader className="gap-2.5 px-2 pb-2 pt-4">
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
                  animated="gentle"
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

        {/* Rows stacked with no gap (36px apart), as ChatGPT's are; each row's
            constant px-1.5 lead keeps its icon pinned. */}
        <SidebarMenu className="!gap-0">
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
              onClick={handleAutomationsClick}
              isActive={activePage === "automations"}
              aria-current={activePage === "automations" ? "page" : undefined}
              className={cn(
                `group/nav relative !flex !h-9 gap-1 items-center !overflow-visible rounded-xl bg-transparent px-1.5 py-0 text-sm text-foreground/90 transition-colors supports-[hover:hover]:${INTERACTIVE_SURFACE}`,
                PAGE_ENTRY_ACTIVE,
              )}
              tooltip="Automations"
            >
              {pageHighlight("automations")}
              <div
                className={cn(
                  "relative z-[1] grid size-9 flex-shrink-0 place-items-center",
                  PAGE_ICON_ACTIVE,
                )}
              >
                <Workflow className={`!h-[18px] !w-[18px] ${NAV_ICON_MOTION}`} />
                {automationsRunningCount > 0 ? (
                  <span
                    className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground"
                    aria-label={`${automationsRunningCount} running`}
                  >
                    {automationsRunningCount}
                  </span>
                ) : null}
              </div>
              <span className={cn("relative z-[1]", RAIL_LABEL)}>Automations</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              onClick={handleAgentsClick}
              isActive={activePage === "agents"}
              aria-current={activePage === "agents" ? "page" : undefined}
              className={cn(
                `group/nav relative !flex !h-9 gap-1 items-center !overflow-visible rounded-xl bg-transparent px-1.5 py-0 text-sm text-foreground/90 transition-colors supports-[hover:hover]:${INTERACTIVE_SURFACE}`,
                PAGE_ENTRY_ACTIVE,
              )}
              tooltip="Agents"
            >
              {pageHighlight("agents")}
              <div
                className={cn(
                  "relative z-[1] grid size-9 flex-shrink-0 place-items-center",
                  PAGE_ICON_ACTIVE,
                )}
              >
                <AgentsIcon className={`!h-[18px] !w-[18px] ${NAV_ICON_MOTION}`} />
              </div>
              <span className={cn("relative z-[1]", RAIL_LABEL)}>Agents</span>
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
            {/* No workflows, no section — like Pinned. One entry per workflow (its
                runs are picked in the workflow view); workflows are created on the
                Automations page (its Workflows area), not from here. */}
            <AnimatePresence initial={false}>
              {workflows.length > 0 && (
                <motion.div
                  key="workflows-section"
                  className="shrink-0"
                  {...sectionListMotion(reduceMotion)}
                >
                  <SidebarSection
                    label="Workflows"
                    open={workflowsOpen}
                    onToggle={() => setWorkflowsOpen((open) => !open)}
                    listId={workflowsListId}
                    // Five rows (2rem each, no gap) show; the rest scroll inside
                    // the section, with the Chats list's scrollbar.
                    listClassName="max-h-[10rem]"
                  >
                    <SidebarSectionRows>{workflows.map(renderWorkflowRow)}</SidebarSectionRows>
                  </SidebarSection>
                </motion.div>
              )}
            </AnimatePresence>
            {/* No pins, no section: it appears with the first pin and leaves with the last. */}
            <AnimatePresence initial={false}>
              {pinnedConversations.length > 0 && (
                <motion.div
                  key="pinned-section"
                  className="shrink-0"
                  {...sectionListMotion(reduceMotion)}
                >
                  <SidebarSection
                    label="Pinned"
                    open={pinnedOpen}
                    onToggle={() => setPinnedOpen((open) => !open)}
                    listId={pinnedListId}
                    // Capped so a long pin list scrolls on its own and never
                    // pushes Chats off the screen.
                    listClassName="max-h-[30dvh]"
                  >
                    <SidebarSectionRows>{pinnedConversations.map(renderConversationRow)}</SidebarSectionRows>
                  </SidebarSection>
                </motion.div>
              )}
            </AnimatePresence>
            <SidebarSection
              label="Chats"
              open={chatsOpen}
              onToggle={() => setChatsOpen((open) => !open)}
              listId={chatsListId}
              groupClassName="min-h-0 flex-1"
              // Flush with the sidebar's right edge so the scrollbar sits
              // there; pr-5 keeps the rows where they were before.
              listClassName="min-h-0 flex-1 pb-4"
              contentClassName="min-h-0 flex-1 space-y-2"
              listRef={contentRef}
              onScroll={handleScroll}
            >
              {showInitialSkeleton ? (
                <ConversationLoadingSkeleton />
              ) : showEmptyState ? (
                <div className="flex flex-col items-center justify-center gap-1.5 rounded-lg bg-muted/10 py-10 text-center text-muted-foreground">
                  <MessageSquare size={28} className="mb-3 text-muted-foreground/60" />
                  <p className="text-sm">No conversations yet</p>
                </div>
              ) : (
                <SidebarSectionRows>{chatConversations.map(renderConversationRow)}</SidebarSectionRows>
              )}
              {showAllPinnedHint && (
                <p className="px-2 py-2 text-xs text-muted-foreground">
                  Chats you haven&apos;t pinned show up here.
                </p>
              )}
              {!showInitialSkeleton && isLoadingMore && <ConversationLoadingSkeleton />}
            </SidebarSection>
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
