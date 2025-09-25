import * as React from "react";
import { MessageSquare, X, Loader2, Building2, Plus, User } from "lucide-react";

import type { Agent, ConversationSummary } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
import { cn } from "@/lib/utils";

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
  const { isMobile, setOpenMobile, state } = useSidebar();
  const isCollapsed = state === "collapsed";
  const [isSidebarHovered, setIsSidebarHovered] = React.useState(false);
  const showSwap = isCollapsed && isSidebarHovered;

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
      onMouseEnter={() => setIsSidebarHovered(true)}
      onMouseLeave={() => setIsSidebarHovered(false)}
    >
      <SidebarRail />
      <SidebarHeader
        className={cn(
          "py-4 transition-[padding] duration-200 ease-linear px-3",
          isCollapsed ? "justify-center" : ""
        )}
      >
        {/* Title Icon */}
        <div className="flex w-full items-center gap-2 transition-all duration-200 ease-linear">
          <div className="relative h-8 w-8">
            <button
              type="button"
              onClick={handleTitleClickInternal}
              className={cn(
                "absolute inset-0 flex items-center justify-center rounded-xl bg-background/60 transition-opacity focus:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
                showSwap ? "pointer-events-none opacity-0" : "opacity-100"
              )}
            >
              <img src="/8.png" alt="mAgenticX logo" className="h-8 w-8 rounded-xl object-cover" />
            </button>
            <SidebarTrigger
              aria-label="Toggle sidebar"
              variant="ghost"
              size="icon"
              className={cn(
                "absolute inset-0 h-8 w-8 rounded-xl text-muted-foreground transition-opacity hover:text-foreground",
                showSwap ? "opacity-100" : "pointer-events-none opacity-0"
              )}
            />
          </div>
          <SidebarTrigger
            aria-label="Toggle sidebar"
            variant="ghost"
            size="icon"
            className={cn(
              "ml-auto h-8 w-8 rounded-xl text-muted-foreground transition-colors hover:text-foreground",
              isCollapsed ? "hidden" : "inline-flex"
            )}
          />
        </div>
        
        {/* New Chat Button */}
        <div
          className={cn(
            "flex w-full items-center gap-2 py-5 transition-all duration-200 ease-linear",
            isCollapsed && "justify-center"
          )}
        >
          <Button
            variant="default"
            className={cn(
              "relative mt-2 w-full items-center justify-center gap-2 rounded-xl px-3 py-3 transition-all duration-200 ease-linear overflow-hidden",
              isCollapsed && "mt-0 h-10 w-10 self-center px-0 py-0 gap-0"
            )}
            onClick={handleNewChatClick}
          >
            <Plus className="h-4 w-4 flex-shrink-0 transition-transform duration-200" />
            <span
              className={cn(
                "truncate text-sm transition-all duration-200",
                isCollapsed
                  ? "pointer-events-none absolute left-full top-1/2 -translate-y-1/2 opacity-0"
                  : "opacity-100"
              )}
            >
              New Chat
            </span>
          </Button>
        </div>

      </SidebarHeader>

      <SidebarContent
        className="flex-1 px-4 pb-4 pt-0"
        onScroll={!isCollapsed ? handleScroll : undefined}
      >
        {!isCollapsed && (
          <SidebarGroup className="flex h-full flex-col space-y-3 !p-0">
            <SidebarGroupLabel className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Chats
            </SidebarGroupLabel>
            <SidebarGroupContent
              className="min-h-0 flex-1 space-y-3"
            >
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
                          className="w-full items-start gap-3 rounded-xl border border-transparent bg-background/60 px-3 py-3 text-left shadow-sm transition-all hover:border-border/70 hover:bg-background/90 data-[active=true]:border-primary/30 data-[active=true]:bg-primary/10 data-[active=true]:shadow-md"
                          isActive={conversation.id === currentConversationId}
                          onClick={() => handleConversationSelect(conversation)}
                        >
                          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                            <Icon size={16} />
                          </div>
                          <div className="flex min-w-0 flex-col gap-1">
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
                          className="opacity-0 transition-opacity hover:bg-destructive/15 hover:text-destructive focus-visible:opacity-100 group-hover/menu-item:opacity-100"
                        >
                          <X size={14} />
                        </SidebarMenuAction>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              )}
              {isLoadingMore && (
                <div className="flex justify-center py-2">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              )}
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>

      <SidebarFooter className="border-t border-border px-4 py-4">
        <Tooltip delayDuration={0}>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="lg"
              className={cn(
                "h-12 w-full items-center justify-start gap-3 rounded-xl px-3 transition-all duration-200 ease-linear overflow-hidden",
                isCollapsed && "h-10 w-10 justify-center gap-0 px-0"
              )}
              onClick={handleOpenProfile}
            >
              <div
                className={cn(
                  "flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary transition-all duration-200",
                  isCollapsed && "h-8 w-8"
                )}
              >
                <User className="h-4 w-4" />
              </div>
              <div
                className={cn(
                  "flex min-w-0 flex-col overflow-hidden transition-all duration-200",
                  isCollapsed ? "max-w-0 opacity-0" : "max-w-[160px] opacity-100"
                )}
              >
                <span className="truncate text-sm font-medium text-foreground">john Doe</span>
              </div>
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
    </SidebarRoot>
  );
}




