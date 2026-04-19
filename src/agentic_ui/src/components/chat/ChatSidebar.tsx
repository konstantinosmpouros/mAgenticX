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
} from "lucide-react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useTheme } from "next-themes";
import { Loader } from "@/components/ui/shadcn-io/loader";

import type { Agent, ConversationSummary, UserProfile } from "@/lib/types";
import { cn } from "@/lib/utils";
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
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";

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
  onOpenUserProfile: () => void;
  agents: Agent[];
  userProfile: UserProfile | null;
  dismissFloatingUiSignal?: number;
  onFloatingUiStateChange?: (open: boolean) => void;
  sidebarInteractionHook: (args: {
    isCollapsed: boolean;
    toggleSidebar: () => void;
  }) => {
    isLogoHovered: boolean;
    handleSidebarMouseEnter: () => void;
    handleSidebarMouseLeave: () => void;
    toggleCollapsedOnBlankArea: (event: React.MouseEvent) => void;
  };
};

const ConversationLoadingSkeleton = ({ count = 3 }: { count?: number }) => (
  <div className="space-y-2 pt-2" aria-hidden="true">
    {Array.from({ length: count }).map((_, index) => (
      <div
        key={`conversation-skeleton-${index}`}
        className="rounded-lg px-3 py-3"
      >
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
  onOpenUserProfile,
  agents,
  userProfile,
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
  const profileInitial = profileName.charAt(0).toUpperCase() || "P";
  const profileEmail = (userProfile?.email ?? "Open profile").trim();
  const avatarUrl = userProfile?.avatarUrl || null;
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
    [onSelectConversation, isMobile, setOpenMobile, setOpenActionMenuId]
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

  const handleOpenProfile = React.useCallback(() => {
    onOpenUserProfile();
    if (isMobile) {
      setOpenMobile(false);
    }
  }, [onOpenUserProfile, isMobile, setOpenMobile]);

  const handleScroll: React.UIEventHandler<HTMLDivElement> = React.useCallback(
    (event) => {
      if (isLoadingMore || !hasMore) return;
      const el = event.currentTarget;
      const threshold = 16;
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - threshold) {
        onLoadMore();
      }
    },
    [isLoadingMore, hasMore, onLoadMore]
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
    [onRenameConversation]
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
    onFloatingUiStateChange?.(Boolean(openActionMenuId || renamingConversationId));
  }, [onFloatingUiStateChange, openActionMenuId, renamingConversationId]);

  const lastDismissFloatingUiSignalRef = React.useRef(dismissFloatingUiSignal);
  React.useEffect(() => {
    if (dismissFloatingUiSignal === lastDismissFloatingUiSignalRef.current) {
      return;
    }

    lastDismissFloatingUiSignalRef.current = dismissFloatingUiSignal;
    setOpenActionMenuId(null);
    handleCancelRename();
  }, [dismissFloatingUiSignal, handleCancelRename]);

  const canSubmitRename = renameDraft.trim().length > 0;

  const showEmptyState = !isInitialLoading && !isLoadingMore && conversations.length === 0;
  const showInitialSkeleton = isInitialLoading || (isLoadingMore && conversations.length === 0);

  return (
    <SidebarRoot
      collapsible="icon"
      className={cn(
        "relative overflow-hidden",
        isCollapsed
          ? "bg-transparent [&_[data-sidebar=sidebar]]:bg-transparent [&_[data-sidebar=sidebar]]:text-foreground"
          : "bg-sidebar"
      )}
      onMouseEnter={handleSidebarMouseEnter}
      onMouseLeave={handleSidebarMouseLeave}
    >
      <SidebarHeader
        className={cn("gap-3 py-4 pl-2 pr-3", isCollapsed && "pr-2")}
      >
        <SidebarMenu className="!gap-0">
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              tooltip="Go to workspace"
              onClick={handleTitleClickInternal}
              className={cn(
                "group items-center gap-3 rounded-lg bg-transparent px-3 py-3 text-left transition supports-[hover:hover]:hover:bg-[hsl(var(--hover-surface))] active:bg-[hsl(var(--hover-surface-strong))] focus-visible:bg-[hsl(var(--hover-surface-strong))]",
                "group-data-[collapsible=icon]:!h-12 group-data-[collapsible=icon]:!w-12 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-0 group-data-[collapsible=icon]:!p-0 group-data-[collapsible=icon]:self-start"
              )}
            >
              <div
                className="relative flex h-9 w-9 flex-shrink-0 items-center justify-center overflow-hidden rounded-lg transition bg-transparent"
              >
                <img
                  src={logoSrc}
                  alt="mAgenticX logo"
                  className={cn(
                    "h-full w-full object-contain transition-opacity",
                    isCollapsed && isLogoHovered ? "opacity-0" : "opacity-100"
                  )}
                />
                <PanelLeft
                  className={cn(
                    "absolute inset-0 h-full w-full p-2 text-foreground transition-opacity",
                    isCollapsed && isLogoHovered ? "opacity-100" : "opacity-0"
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
              onClick={handleNewChatClick}
              className={cn(
                "!flex !h-10 gap-1 items-center rounded-lg bg-transparent px-3 py-1 transition supports-[hover:hover]:hover:bg-[hsl(var(--hover-surface))] active:bg-[hsl(var(--hover-surface-strong))] focus-visible:bg-[hsl(var(--hover-surface-strong))]",
                "group-data-[collapsible=icon]:!h-10 group-data-[collapsible=icon]:!w-10 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-0 group-data-[collapsible=icon]:px-0 group-data-[collapsible=icon]:py-0 group-data-[collapsible=icon]:self-start group-data-[collapsible=icon]:ml-0.5"
              )}
              tooltip="Start a new chat"
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
              onClick={handleSearchClick}
              className={cn(
                "!flex !h-10 gap-1 items-center rounded-lg bg-transparent px-3 py-1 transition supports-[hover:hover]:hover:bg-[hsl(var(--hover-surface))] active:bg-[hsl(var(--hover-surface-strong))] focus-visible:bg-[hsl(var(--hover-surface-strong))]",
                "group-data-[collapsible=icon]:!h-10 group-data-[collapsible=icon]:!w-10 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-0 group-data-[collapsible=icon]:px-0 group-data-[collapsible=icon]:py-0 group-data-[collapsible=icon]:self-start group-data-[collapsible=icon]:ml-0.5"
              )}
              tooltip="Search"
            >
              <div className="grid size-9 flex-shrink-0 place-items-center rounded-lg">
                <Search className="h-[1.125rem] w-[1.125rem]" />
              </div>
              <span className="text-md group-data-[collapsible=icon]:hidden">Search</span>
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
            <SidebarGroupContent
              className="min-h-0 flex-1 space-y-2"
            >
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
                    const rawTitle = typeof conversation.title === "string" ? conversation.title.trim() : "";
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
                        {!isRenaming && (
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
                        )}
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
        className={cn(
          "py-3 pl-2 pr-3",
          !isCollapsed && "border-t border-sidebar-border/40",
          isCollapsed && "pr-2"
        )}
      >
        <SidebarMenu className="!gap-0">
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              onClick={handleOpenProfile}
              className={cn(
                "gap-3 rounded-lg bg-transparent px-3 py-3 transition supports-[hover:hover]:hover:bg-[hsl(var(--hover-surface))] active:bg-[hsl(var(--hover-surface-strong))] focus-visible:bg-[hsl(var(--hover-surface-strong))]",
                "group-data-[collapsible=icon]:!h-12 group-data-[collapsible=icon]:!w-12 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:rounded-lg group-data-[collapsible=icon]:gap-0 group-data-[collapsible=icon]:!p-0 group-data-[collapsible=icon]:self-start",
                "group-data-[collapsible=icon]:supports-[hover:hover]:hover:bg-transparent group-data-[collapsible=icon]:focus-visible:bg-transparent group-data-[collapsible=icon]:active:bg-transparent"
              )}
              tooltip={{
                children: (
                  <div className="flex flex-col text-left">
                    <span className="text-sm font-semibold">{profileName}</span>
                    <span className="text-xs text-muted-foreground">{profileEmail}</span>
                  </div>
                ),
              }}
            >
              <div className="sidebar-icon-badge flex h-9 w-9 flex-shrink-0 items-center justify-center overflow-hidden rounded-xl text-primary">
                {avatarUrl ? (
                  <img src={avatarUrl} alt={profileName} className="h-full w-full object-cover" />
                ) : (
                  <span className="text-sm font-semibold">{profileInitial}</span>
                )}
              </div>
              <div className="flex min-w-0 flex-1 flex-col group-data-[collapsible=icon]:hidden">
                <span className="truncate text-sm font-medium text-foreground">{profileName}</span>
                <span className="truncate text-xs text-muted-foreground">{profileEmail}</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </SidebarRoot>
  );
}
