import * as React from "react";
import { MessageSquare, X, Loader2, Building2, Plus, User } from "lucide-react";

import type { Agent, ConversationSummary } from "@/lib/types";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Sidebar as SidebarRoot,
  SidebarContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuAction,
  SidebarGroup,
  SidebarGroupContent,
  SidebarFooter,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";

type AppSidebarProps = {
  conversations: ConversationSummary[];
  currentConversationId: string | null;
  onSelectConversation: (conversation: ConversationSummary) => void;
  onDeleteConversation: (id: string, e: React.MouseEvent) => void;
  onLoadMore: () => void;
  isLoadingMore: boolean;
  hasMore: boolean;
  onTitleClick: () => void;
  onNewChat: () => void;
  onOpenUserProfile: () => void;
  agents: Agent[];
};

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
  onOpenUserProfile,
  agents,
}: AppSidebarProps) {
  const { isMobile, setOpenMobile, state: sidebarState } = useSidebar();
  const isCollapsed = sidebarState === "collapsed";
  const [isHoveringCollapsed, setIsHoveringCollapsed] = React.useState(false);

  React.useEffect(() => {
    if (!isCollapsed && isHoveringCollapsed) {
      setIsHoveringCollapsed(false);
    }
  }, [isCollapsed, isHoveringCollapsed]);

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
    onTitleClick();
    if (isMobile) {
      setOpenMobile(false);
    }
  }, [onTitleClick, isMobile, setOpenMobile]);

  const handleNewChatClick = React.useCallback(() => {
    onNewChat();
    if (isMobile) {
      setOpenMobile(false);
    }
  }, [onNewChat, isMobile, setOpenMobile]);

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

  return (
    <SidebarRoot
      collapsible="icon"
      className="border-r border-border bg-gradient-card"
      onMouseEnter={() => {
        if (isCollapsed) setIsHoveringCollapsed(true);
      }}
      onMouseLeave={() => setIsHoveringCollapsed(false)}
    >
      <SidebarRail />
      <div className="flex h-full flex-col">
        <SidebarHeader className="px-4 py-6 flex items-center justify-between gap-2">
          {isCollapsed && isHoveringCollapsed ? (
            <SidebarTrigger variant="outline" size="icon" className="h-10 w-10 rounded-xl" />
          ) : (
            <button
              type="button"
              onClick={handleTitleClickInternal}
              className="flex w-full items-center gap-3 rounded-md text-left transition-colors hover:bg-sidebar-accent/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
            >
              <img
                src="/8.png"
                alt="mAgenticX logo"
                className="h-8 w-8 rounded-xl object-cover"
              />
              <div className="flex flex-col leading-tight group-data-[collapsible=icon]:hidden">
                <span className="text-base font-semibold text-foreground">mAgenticX</span>
                <span className="text-xs text-muted-foreground">Professional AI Agent Interactions</span>
              </div>
            </button>
          )}

          {!isCollapsed && (
            <SidebarTrigger
              variant="ghost"
              size="icon"
              className="ml-2 h-10 w-10 text-muted-foreground hover:text-foreground"
            />
          )}
        </SidebarHeader>

        <div className="px-4 group-data-[collapsible=icon]:hidden">
          <Button
            variant="default"
            className="mt-3 w-full justify-center"
            onClick={handleNewChatClick}
          >
            <Plus className="mr-2 h-4 w-4" /> New Chat
          </Button>
        </div>

        <SidebarContent className="px-0 py-4 group-data-[collapsible=icon]:hidden">
          <div className="relative flex h-full flex-col">
            <ScrollArea className="h-full" onScroll={handleScroll}>
              <SidebarGroup>
                <SidebarGroupContent className="px-3 pb-6">
                  {conversations.length === 0 ? (
                    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border/60 bg-sidebar/40 py-10 text-center text-muted-foreground">
                      <MessageSquare size={28} className="mb-3 text-muted-foreground/60" />
                      <p className="text-sm">No conversations yet</p>
                    </div>
                  ) : (
                    <SidebarMenu className="space-y-3">
                      {conversations.map((conversation) => {
                        const agent = agents.find((a) => a.id === conversation.agentId);
                        const Icon = agent?.icon || Building2;

                        return (
                          <SidebarMenuItem key={conversation.id}>
                            <SidebarMenuButton
                              className="items-start gap-3 rounded-xl border border-transparent bg-background/60 text-left shadow-sm transition-all hover:border-border/70 hover:bg-background/90 data-[active=true]:border-primary/30 data-[active=true]:bg-primary/10 data-[active=true]:shadow-md"
                              isActive={conversation.id === currentConversationId}
                              onClick={() => handleConversationSelect(conversation)}
                            >
                              <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                                <Icon size={16} />
                              </div>
                              <div className="flex min-w-0 flex-col gap-1 group-data-[collapsible=icon]:hidden">
                                <span className="truncate text-sm font-medium text-foreground">
                                  {conversation.title && conversation.title.trim() !== ""
                                    ? conversation.title
                                    : agent?.name}
                                </span>
                                <span className="truncate text-xs text-muted-foreground">
                                  {conversation.lastMessage || "No messages yet"}
                                </span>
                                <span className="text-[11px] text-muted-foreground/80">
                                  {new Date(conversation.updated_at).toLocaleDateString()}
                                </span>
                              </div>
                            </SidebarMenuButton>
                            <SidebarMenuAction
                              aria-label="Delete conversation"
                              onClick={(event) => {
                                event.stopPropagation();
                                onDeleteConversation(conversation.id, event);
                              }}
                              className="hover:bg-destructive/15 hover:text-destructive"
                            >
                              <X size={14} />
                            </SidebarMenuAction>
                          </SidebarMenuItem>
                        );
                      })}
                    </SidebarMenu>
                  )}
                </SidebarGroupContent>
              </SidebarGroup>
            </ScrollArea>
            {isLoadingMore && (
              <div className="pointer-events-none absolute bottom-0 left-0 right-0 flex h-16 items-center justify-center bg-gradient-to-t from-sidebar/95 to-transparent">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            )}
          </div>
        </SidebarContent>

        <SidebarFooter className="border-t border-border px-4 py-4 flex items-center gap-2">
          <Tooltip delayDuration={0}>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                className="h-10 w-10"
                onClick={handleOpenProfile}
              >
                <User className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent
              side="top"
              align="center"
              className="!opacity-100 bg-background text-foreground border border-border shadow-card px-2 py-1 rounded-md"
            >
              <p>Profile</p>
            </TooltipContent>
          </Tooltip>
        </SidebarFooter>
      </div>
    </SidebarRoot>
  );
}

