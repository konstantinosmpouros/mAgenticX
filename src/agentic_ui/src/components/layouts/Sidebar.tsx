import * as React from "react";
import { MessageSquare, X, Building2, PanelLeft, Search } from "lucide-react";
import { FiEdit } from "react-icons/fi";

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
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";

type AppSidebarProps = {
  conversations: ConversationSummary[];
  currentConversationId: string | null;
  onSelectConversation: (conversation: ConversationSummary) => void;
  onDeleteConversation: (id: string, e?: React.MouseEvent) => void;
  onLoadMore: () => void;
  isLoadingMore: boolean;
  hasMore: boolean;
  onTitleClick: () => void;
  onNewChat: () => void;
  onOpenSearch: () => void;
  onOpenUserProfile: () => void;
  agents: Agent[];
  userProfile: UserProfile | null;
};

const ConversationLoadingSkeleton = ({ count = 3 }: { count?: number }) => (
  <div className="space-y-2 pt-2" aria-hidden="true">
    {Array.from({ length: count }).map((_, index) => (
      <div
        key={`conversation-skeleton-${index}`}
        className="rounded-xl px-3 py-3"
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

export default function AppSidebar({
  conversations,
  currentConversationId,
  onSelectConversation,
  onDeleteConversation,
  onLoadMore,
  isLoadingMore,
  hasMore,
  onTitleClick,
  onNewChat,
  onOpenSearch,
  onOpenUserProfile,
  agents,
  userProfile,
}: AppSidebarProps) {
  const { isMobile, setOpenMobile, state, toggleSidebar } = useSidebar();
  const isCollapsed = !isMobile && state === "collapsed";
  const [isLogoHovered, setIsLogoHovered] = React.useState(false);
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    if (!isCollapsed) {
      setIsLogoHovered(false);
    }
  }, [isCollapsed]);
  const rawProfileName =
    userProfile?.displayName ?? userProfile?.fullName ?? userProfile?.username ?? "";
  const profileName = rawProfileName.trim() || "Profile";
  const profileInitial = profileName.charAt(0).toUpperCase() || "P";
  const profileEmail = (userProfile?.email ?? "Open profile").trim();
  const avatarUrl = userProfile?.avatarUrl || null;

  const handleConversationSelect = React.useCallback(
    (conversation: ConversationSummary) => {
      onSelectConversation(conversation);
      if (isMobile) {
        setOpenMobile(false);
      }
    },
    [onSelectConversation, isMobile, setOpenMobile]
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

  const handleSidebarMouseEnter = React.useCallback(() => {
    if (isCollapsed) {
      setIsLogoHovered(true);
    }
  }, [isCollapsed]);

  const handleSidebarMouseLeave = React.useCallback(() => {
    setIsLogoHovered(false);
  }, []);

  return (
    <SidebarRoot
      collapsible="icon"
      className="bg-sidebar"
      onMouseEnter={handleSidebarMouseEnter}
      onMouseLeave={handleSidebarMouseLeave}
    >

      <SidebarHeader
        className={cn("gap-3 py-4 pl-2 pr-3", isCollapsed && "pr-2")}
      >
        <SidebarMenu className="!gap-0.5">
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              tooltip="Go to workspace"
              onClick={handleTitleClickInternal}
              className={cn(
                "group items-center gap-3 rounded-xl bg-transparent px-3 py-3 text-left transition hover:bg-muted/20",
                "group-data-[collapsible=icon]:!h-12 group-data-[collapsible=icon]:!w-12 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-0 group-data-[collapsible=icon]:rounded-full group-data-[collapsible=icon]:!p-0 group-data-[collapsible=icon]:self-start"
              )}
            >
              <div
                className={cn(
                  "relative flex h-9 w-9 flex-shrink-0 items-center justify-center overflow-hidden rounded-full transition",
                  isCollapsed ? "bg-transparent" : "bg-sidebar-accent/40"
                )}
              >
                <img
                  src="/8.png"
                  alt="mAgenticX logo"
                  className={cn(
                    "h-full w-full object-cover transition-opacity",
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
              <SidebarTrigger className="size-9 [&_svg]:h-5 [&_svg]:w-5" />
            </SidebarMenuAction>
          </SidebarMenuItem>
        </SidebarMenu>

        <SidebarMenu className="!gap-0.5">
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              onClick={handleNewChatClick}
              className={cn(
                "!h-10 gap-2 rounded-xl bg-transparent px-3 py-1 transition hover:bg-muted/20",
                "group-data-[collapsible=icon]:!h-10 group-data-[collapsible=icon]:!w-10 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:rounded-full group-data-[collapsible=icon]:gap-0 group-data-[collapsible=icon]:!p-1 group-data-[collapsible=icon]:self-start"
              )}
              tooltip="Start a new chat"
            >
              <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl group-data-[collapsible=icon]:ml-1 group-data-[collapsible=icon]:!h-8 group-data-[collapsible=icon]:!w-8">
                <FiEdit className="h-4 w-4" />
              </div>
              <span className="text-md group-data-[collapsible=icon]:hidden">New chat</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              onClick={handleSearchClick}
              className={cn(
                "!h-10 gap-2 rounded-xl bg-transparent px-3 py-1 transition hover:bg-muted/20",
                "group-data-[collapsible=icon]:!h-10 group-data-[collapsible=icon]:!w-10 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:rounded-full group-data-[collapsible=icon]:gap-0 group-data-[collapsible=icon]:!p-1 group-data-[collapsible=icon]:self-start"
              )}
              tooltip="Search"
            >
              <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl group-data-[collapsible=icon]:ml-1 group-data-[collapsible=icon]:!h-8 group-data-[collapsible=icon]:!w-8">
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
      >
        {!isCollapsed && (
          <SidebarGroup className="flex flex-1 flex-col space-y-2">
            <SidebarGroupLabel className="pr-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Chats
            </SidebarGroupLabel>
            <SidebarGroupContent className="min-h-0 flex-1 space-y-2">
              {conversations.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-1.5 rounded-xl bg-muted/10 py-10 text-center text-muted-foreground">
                  <MessageSquare size={28} className="mb-3 text-muted-foreground/60" />
                  <p className="text-sm">No conversations yet</p>
                </div>
              ) : (
                <SidebarMenu>
                  {conversations.map((conversation) => {
                    const agent = conversation.agent;
                    const Icon = agent?.icon ?? Building2;
                    const conversationTitle = agent?.name || "Untitled chat";
                    const lastMessage = conversation.lastMessage || "No messages yet";

                    return (
                      <SidebarMenuItem key={conversation.id}>
                        <SidebarMenuButton
                          size="lg"
                          isActive={conversation.id === currentConversationId}
                          onClick={() => handleConversationSelect(conversation)}
                          tooltip={{
                            children: (
                              <div className="flex flex-col gap-0.5">
                                <span className="text-sm font-medium">{conversationTitle}</span>
                                <span className="text-xs text-muted-foreground">{lastMessage}</span>
                              </div>
                            ),
                          }}
                          className="items-start gap-2.5 rounded-xl bg-transparent py-2.5 text-left shadow-none transition hover:bg-muted/15 focus-visible:ring-2 data-[active=true]:bg-muted/25 data-[active=true]:text-foreground !h-auto min-h-[3.75rem]"
                        >
                          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                            <Icon size={16} />
                          </div>
                          <div className="flex min-w-0 flex-col gap-1">
                            <span className="truncate text-sm font-medium text-foreground">
                              {conversationTitle}
                            </span>
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
                          </div>
                        </SidebarMenuButton>
                        <SidebarMenuAction
                          aria-label="Delete conversation"
                          onClick={(event) => {
                            event.stopPropagation();
                            onDeleteConversation(conversation.id, event);
                          }}
                          showOnHover
                          className="text-muted-foreground hover:bg-destructive/15 hover:text-destructive focus-visible:text-destructive"
                        >
                          <X size={14} />
                        </SidebarMenuAction>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              )}
              {isLoadingMore && <ConversationLoadingSkeleton />}
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>

      <SidebarFooter
        className={cn(
          "border-t border-sidebar-border/40 py-3 pl-2 pr-3",
          isCollapsed && "pr-2"
        )}
      >
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              onClick={handleOpenProfile}
              className={cn(
                "gap-3 rounded-xl bg-transparent px-3 py-3 transition hover:bg-muted/20",
                "group-data-[collapsible=icon]:!h-12 group-data-[collapsible=icon]:!w-12 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:rounded-full group-data-[collapsible=icon]:gap-0 group-data-[collapsible=icon]:!p-0 group-data-[collapsible=icon]:self-start",
                "group-data-[collapsible=icon]:hover:bg-transparent group-data-[collapsible=icon]:focus-visible:bg-transparent group-data-[collapsible=icon]:active:bg-transparent"
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
              <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center overflow-hidden rounded-lg bg-primary/10 text-primary">
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
