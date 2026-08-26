import * as React from "react";
import {
  MessageSquare,
  MoreHorizontal,
  Building2,
  PanelLeft,
  Search,
  Archive,
  Flag,
  Trash2,
  Pencil,
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
import { useTheme } from "next-themes";
import { Loader } from "@/shared/ui/shadcn-io/loader";

import type { AccountSummary, ConversationSummary, UserProfile } from "@/shared/lib/types";
import AccountMenu from "@/features/auth/components/AccountMenu";
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

type ChatSidebarProps = {
  conversations: ConversationSummary[];
  currentConversationId: string | null;
  onSelectConversation: (conversation: ConversationSummary) => void;
  onDeleteConversation: (id: string, e?: React.MouseEvent) => void;
  onRenameConversation?: (id: string, newTitle: string) => Promise<void> | void;
  onArchiveConversation?: (id: string) => void;
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

export default function ChatSidebar({
  conversations,
  currentConversationId,
  onSelectConversation,
  onDeleteConversation,
  onRenameConversation,
  onArchiveConversation,
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
  const { resolvedTheme, theme } = useTheme();
  const isCollapsed = !isMobile && state === "collapsed";
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const rawProfileName =
    userProfile?.displayName ?? userProfile?.fullName ?? userProfile?.username ?? "";
  const profileName = rawProfileName.trim() || "Profile";
  // Two-letter avatar initials (e.g. "kostas mpouros" -> "km"): first letters of
  // the first two name parts, or the first two characters of a single-token
  // name. Case is preserved from the name as entered, matching the design.
  const nameParts = profileName.split(/\s+/).filter(Boolean);
  const profileInitials =
    (nameParts.length >= 2
      ? nameParts[0].charAt(0) + nameParts[1].charAt(0)
      : profileName.slice(0, 2)) || "P";
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
  const isDarkTheme = (resolvedTheme ?? theme) === "dark";
  const newChatIconSrc = isDarkTheme ? "/edit.png" : "/edit2.png";
  const logoSrc = isDarkTheme ? "/logo2_white_magentaX.png" : "/logo2.png";

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
      if (isLoadingMore || !hasMore) return;
      const el = event.currentTarget;
      const threshold = 16;
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - threshold) {
        onLoadMore();
      }
    },
    [isLoadingMore, hasMore, onLoadMore],
  );

  React.useEffect(() => {
    if (isCollapsed || isLoadingMore || !hasMore) {
      return;
    }
    const el = contentRef.current;
    if (!el) {
      return;
    }
    if (el.scrollHeight <= el.clientHeight + 4) {
      onLoadMore();
    }
  }, [conversations.length, hasMore, isCollapsed, isLoadingMore, onLoadMore]);

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

  const showEmptyState = !isInitialLoading && !isLoadingMore && conversations.length === 0;
  const showInitialSkeleton = isInitialLoading || (isLoadingMore && conversations.length === 0);

  // Shared between the desktop Help flyout and the mobile flattened section. A
  // Radix SubContent can only open left/right of its trigger; on a phone the
  // parent menu already spans the viewport, so neither side fits and the flyout
  // clips off-screen — on mobile these render inline in the main menu instead.
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
      className={cn(
        "relative overflow-hidden",
        isCollapsed
          ? "bg-transparent [&_[data-sidebar=sidebar]]:bg-transparent [&_[data-sidebar=sidebar]]:text-foreground"
          : "bg-sidebar",
      )}
      onMouseEnter={handleSidebarMouseEnter}
      onMouseLeave={handleSidebarMouseLeave}
    >
      <SidebarHeader className="gap-3 py-4 px-2">
        <SidebarMenu className="!gap-0">
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              tooltip="Go to workspace"
              onClick={handleTitleClickInternal}
              className={cn(
                "group items-center gap-3 rounded-lg bg-transparent px-3 py-3 text-left transition supports-[hover:hover]:hover:bg-[hsl(var(--hover-surface))] active:bg-[hsl(var(--hover-surface-strong))] focus-visible:bg-[hsl(var(--hover-surface-strong))]",
                // Collapsed: only drop to the shared px-1.5 lead (justify-start, full
                // width) so the logo centers at the same x as every other icon. Height
                // stays h-12 (size lg) in BOTH states — changing it would shift the logo
                // and push the action menu below it up/down.
                "group-data-[collapsible=icon]:px-1.5",
              )}
            >
              <div className="relative flex h-9 w-9 flex-shrink-0 items-center justify-center overflow-hidden rounded-lg transition bg-transparent">
                <img
                  src={logoSrc}
                  alt="mAgenticX logo"
                  className={cn(
                    "h-full w-full object-contain transition-opacity",
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
              <div className="flex min-w-0 flex-col text-left group-data-[collapsible=icon]:hidden">
                <span className="truncate text-sm font-semibold text-foreground">mAgenticX</span>
                <span className="truncate text-xs text-muted-foreground">Workspace</span>
              </div>
            </SidebarMenuButton>
            <SidebarMenuAction
              asChild
              showOnHover={false}
              className="right-2 top-1.5 -translate-y-0.5 group-data-[collapsible=icon]:hidden"
            >
              <SidebarTrigger className="size-9 [&_svg]:h-5 [&_svg]:w-5 supports-[hover:hover]:hover:bg-[hsl(var(--hover-surface))] active:bg-[hsl(var(--hover-surface-strong))] focus-visible:bg-[hsl(var(--hover-surface-strong))]" />
            </SidebarMenuAction>
          </SidebarMenuItem>
        </SidebarMenu>

        <SidebarMenu className="!gap-0">
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              onClick={handleSearchClick}
              className={cn(
                // Frozen by construction: a constant px-1.5 lead + full width in both
                // states keeps the icon pinned at the same x (centered when collapsed,
                // see SIDEBAR_WIDTH_ICON), so only the rail width animates around it.
                "!flex !h-10 gap-1 items-center rounded-lg bg-transparent px-1.5 py-1 transition supports-[hover:hover]:hover:bg-[hsl(var(--hover-surface))] active:bg-[hsl(var(--hover-surface-strong))] focus-visible:bg-[hsl(var(--hover-surface-strong))]",
              )}
              tooltip="Search"
            >
              <div className="grid size-9 flex-shrink-0 place-items-center rounded-lg">
                <Search className="!h-5 !w-5" />
              </div>
              <span className="text-md group-data-[collapsible=icon]:hidden">Search</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              onClick={handleNewChatClick}
              className={cn(
                // Frozen by construction: a constant px-1.5 lead + full width in both
                // states keeps the icon pinned at the same x (centered when collapsed,
                // see SIDEBAR_WIDTH_ICON), so only the rail width animates around it.
                "!flex !h-10 gap-1 items-center rounded-lg bg-transparent px-1.5 py-1 transition supports-[hover:hover]:hover:bg-[hsl(var(--hover-surface))] active:bg-[hsl(var(--hover-surface-strong))] focus-visible:bg-[hsl(var(--hover-surface-strong))]",
              )}
              tooltip="New chat"
            >
              <div className="grid size-9 flex-shrink-0 place-items-center rounded-lg">
                <img
                  src={newChatIconSrc}
                  alt="New chat"
                  className="h-7 w-7 object-contain"
                  draggable={false}
                />
              </div>
              <span className="text-md group-data-[collapsible=icon]:hidden">New chat</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              onClick={handleVoiceModeClick}
              className={cn(
                // Frozen by construction: a constant px-1.5 lead + full width in both
                // states keeps the icon pinned at the same x (centered when collapsed,
                // see SIDEBAR_WIDTH_ICON), so only the rail width animates around it.
                "!flex !h-10 gap-1 items-center rounded-lg bg-transparent px-1.5 py-1 transition supports-[hover:hover]:hover:bg-[hsl(var(--hover-surface))] active:bg-[hsl(var(--hover-surface-strong))] focus-visible:bg-[hsl(var(--hover-surface-strong))]",
              )}
              tooltip="Voice mode"
            >
              <div className="grid size-9 flex-shrink-0 place-items-center rounded-lg">
                <PiWaveformBold className="!h-5 !w-5" />
              </div>
              <span className="text-md group-data-[collapsible=icon]:hidden">Voice mode</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              onClick={handleScheduledTasksClick}
              className={cn(
                // Frozen by construction: a constant px-1.5 lead + full width in both
                // states keeps the icon pinned at the same x (centered when collapsed,
                // see SIDEBAR_WIDTH_ICON), so only the rail width animates around it.
                "!flex !h-10 gap-1 items-center rounded-lg bg-transparent px-1.5 py-1 transition supports-[hover:hover]:hover:bg-[hsl(var(--hover-surface))] active:bg-[hsl(var(--hover-surface-strong))] focus-visible:bg-[hsl(var(--hover-surface-strong))]",
              )}
              tooltip="Scheduled tasks"
            >
              <div className="relative grid size-9 flex-shrink-0 place-items-center rounded-lg">
                <MdOutlineSchedule className="!h-5 !w-5" />
                {scheduledTasksRunningCount > 0 ? (
                  <span
                    className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground"
                    aria-label={`${scheduledTasksRunningCount} running`}
                  >
                    {scheduledTasksRunningCount}
                  </span>
                ) : null}
              </div>
              <span className="text-md group-data-[collapsible=icon]:hidden">Tasks</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent
        ref={contentRef}
        className="flex-1 overflow-y-auto pl-2 pr-3 pb-4 pt-0"
        onScroll={handleScroll}
        onClick={toggleCollapsedOnBlankArea}
      >
        {!isCollapsed && (
          <SidebarGroup className="flex flex-1 flex-col space-y-2">
            <SidebarGroupLabel className="pr-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Chats
            </SidebarGroupLabel>
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
                  {conversations.map((conversation) => {
                    const agent = conversation.agent;
                    const Icon = agent?.icon ?? Building2;
                    const rawTitle =
                      typeof conversation.title === "string" ? conversation.title.trim() : "";
                    const lastMessage = (conversation.lastMessage ?? "").trim();
                    const fallbackTitle = lastMessage || agent?.name || "Untitled chat";
                    const resolvedTitle = rawTitle || fallbackTitle;
                    const isRenaming = renamingConversationId === conversation.id;

                    return (
                      <SidebarMenuItem key={conversation.id}>
                        <SidebarMenuButton
                          size="lg"
                          isActive={conversation.id === currentConversationId}
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
                          className="items-center gap-2.5 rounded-lg bg-transparent py-1.5 text-left shadow-none transition-all duration-200 supports-[hover:hover]:hover:scale-[1.01] supports-[hover:hover]:hover:shadow-[0_8px_24px_rgba(0,0,0,0.35)] supports-[hover:hover]:hover:bg-[hsl(var(--hover-surface))] supports-[hover:hover]:hover:!text-primary/60 active:bg-[hsl(var(--hover-surface-strong))] focus-visible:bg-[hsl(var(--hover-surface-strong))] focus-visible:!text-primary focus-visible:ring-2 focus-visible:scale-[1.01] data-[active=true]:bg-primary/10 data-[active=true]:text-primary data-[active=true]:supports-[hover:hover]:hover:!bg-primary/10 data-[active=true]:supports-[hover:hover]:hover:!text-primary data-[active=true]:focus-visible:!bg-primary/10 !h-auto min-h-[2.5rem]"
                        >
                          <div className="sidebar-icon-badge flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl text-primary">
                            <Icon size={14} />
                          </div>
                          {isRenaming ? (
                            <div
                              ref={renameContainerRef}
                              className="flex w-full items-center gap-2 rounded-xl border border-border/60 bg-background/80 px-2 py-1"
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
                                className="grid size-7 flex-shrink-0 place-items-center rounded-full bg-[#f093f9] text-[#1b0f2a] shadow-md transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                {isSubmittingRename ? (
                                  <Loader size={14} className="text-[#1b0f2a]" />
                                ) : (
                                  <ArrowRight className="h-3.5 w-3.5" />
                                )}
                              </button>
                            </div>
                          ) : (
                            <span className="truncate text-sm font-medium text-foreground">
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
                              className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:!bg-transparent hover:!text-muted-foreground active:!bg-transparent focus-visible:!bg-transparent focus-visible:text-foreground peer-data-[size=lg]/menu-button:!top-1/2 peer-data-[size=lg]/menu-button:-translate-y-1/2"
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
                              <DropdownMenu.Trigger asChild>
                                <SidebarMenuAction
                                  aria-label="Conversation actions"
                                  onClick={(event) => event.stopPropagation()}
                                  onMouseDown={(event) => event.stopPropagation()}
                                  onPointerDown={(event) => event.stopPropagation()}
                                  showOnHover
                                  className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:!bg-transparent hover:!text-muted-foreground active:!bg-transparent focus-visible:!bg-transparent focus-visible:text-foreground peer-data-[size=lg]/menu-button:!top-1/2 peer-data-[size=lg]/menu-button:-translate-y-1/2"
                                >
                                  <MoreHorizontal size={14} />
                                </SidebarMenuAction>
                              </DropdownMenu.Trigger>
                              <DropdownMenu.Portal>
                                <DropdownMenu.Content
                                  side="right"
                                  sideOffset={8}
                                  align="end"
                                  className="z-50 w-48 rounded-lg border border-border bg-background p-1.5 text-sm text-foreground shadow-lg focus:outline-none"
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
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              )}
              {!showInitialSkeleton && isLoadingMore && <ConversationLoadingSkeleton />}
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>

      <SidebarFooter
        className={cn("py-3 px-2", !isCollapsed && "border-t border-sidebar-border/40")}
      >
        <SidebarMenu className="!gap-0">
          <SidebarMenuItem>
            <DropdownMenu.Root open={profileMenuOpen} onOpenChange={setProfileMenuOpen}>
              {/* Tooltip composed manually (not via SidebarMenuButton's `tooltip` prop):
                  the dropdown trigger must slot straight onto the real <button> — the
                  prop variant would wrap it in a Tooltip and break the asChild chain. */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenu.Trigger asChild>
                    <SidebarMenuButton
                      size="lg"
                      className={cn(
                        // Frozen by construction, matching the Search/New chat/Voice/Tasks rows:
                        // a constant px-1.5 lead keeps the avatar pinned at the same x in both
                        // states (centered when collapsed, see SIDEBAR_WIDTH_ICON), so toggling
                        // the rail never shifts it.
                        "!flex items-center gap-1 rounded-lg bg-transparent px-1.5 py-2 transition supports-[hover:hover]:hover:bg-[hsl(var(--hover-surface))] active:bg-[hsl(var(--hover-surface-strong))] focus-visible:bg-[hsl(var(--hover-surface-strong))]",
                        "group-data-[collapsible=icon]:!h-12",
                        "group-data-[collapsible=icon]:supports-[hover:hover]:hover:bg-transparent group-data-[collapsible=icon]:focus-visible:bg-transparent group-data-[collapsible=icon]:active:bg-transparent",
                        profileMenuOpen && "bg-[hsl(var(--hover-surface))]",
                      )}
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
                      <div className="flex min-w-0 flex-1 flex-col group-data-[collapsible=icon]:hidden">
                        <span className="truncate text-sm font-medium text-foreground">
                          {profileName}
                        </span>
                        <span className="truncate text-xs text-muted-foreground">
                          {profileEmail}
                        </span>
                      </div>
                      <ChevronsUpDown className="ml-auto h-4 w-4 flex-shrink-0 text-muted-foreground group-data-[collapsible=icon]:hidden" />
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
                  className="z-50 w-64 rounded-xl border border-border bg-background p-1.5 text-sm text-foreground shadow-xl focus:outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[side=top]:slide-in-from-bottom-2 data-[side=right]:slide-in-from-left-2"
                  onCloseAutoFocus={(event) => event.preventDefault()}
                >
                  {/* Identity header. With other accounts available it becomes a
                      submenu holding the switcher; otherwise it stays what it was
                      and opens the Edit profile dialog. Radix's Sub opens on hover
                      *and* on click/keyboard, so the switcher is reachable by
                      touch and by arrow keys without extra handling. */}
                  {showAccountSwitcher ? (
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
                          className="z-50 rounded-xl border border-border bg-background text-sm text-foreground shadow-xl focus:outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
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
                      onSelect={() => handleProfileMenuAction(onEditProfile)}
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
                        className="ml-auto flex-shrink-0 text-muted-foreground"
                      />
                    </DropdownMenu.Item>
                  )}

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
                          className="z-50 w-56 rounded-xl border border-border bg-background p-1.5 text-sm text-foreground shadow-xl focus:outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[side=right]:slide-in-from-left-2 data-[side=left]:slide-in-from-right-2"
                        >
                          {helpMenuItems}
                        </DropdownMenu.SubContent>
                      </DropdownMenu.Portal>
                    </DropdownMenu.Sub>
                  )}

                  <DropdownMenu.Separator className="my-1 h-px bg-border/60" />

                  {accounts.length > 1 ? (
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
                          className="z-50 w-[19rem] rounded-xl border border-border bg-background p-1.5 text-sm text-foreground shadow-xl focus:outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
                        >
                          {accounts.map((account) => (
                            <DropdownMenu.Item
                              key={account.id}
                              onSelect={() =>
                                handleProfileMenuAction(() => onLogoutAccount?.(account))
                              }
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
