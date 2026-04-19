import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Ghost, Archive, Flag, Trash2, MoreHorizontal, HelpCircle } from "lucide-react";
import type { Agent } from "@/lib/types";
import React from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { SidebarTrigger } from "@/components/ui/sidebar";

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
    conversationActionsOpen?: boolean;
    onConversationActionsOpenChange?: (open: boolean) => void;
    onArchiveConversation?: () => void;
    onUnarchiveConversation?: () => void;
    onReportConversation?: () => void;
    onDeleteConversation?: () => void;
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
    conversationActionsOpen = false,
    onConversationActionsOpenChange,
    onArchiveConversation,
    onUnarchiveConversation,
    onReportConversation,
    onDeleteConversation,
}: ChatHeaderProps) {
    const displayAgents = React.useMemo(() => {
        if (inactiveAgent && !agents.some((agent) => agent.id === inactiveAgent.id)) {
            return [...agents, inactiveAgent];
        }
        return agents;
    }, [agents, inactiveAgent]);

    const selected = React.useMemo(
        () => displayAgents.find(a => a.id === selectedAgent),
        [displayAgents, selectedAgent]
    );
    const showInactiveIndicator = Boolean(inactiveAgent && inactiveAgent.isActive === false);

    return (
        <div
            className={`sticky top-0 z-40 w-full bg-transparent px-3 py-2 md:px-6 md:py-3 border-b transition-colors duration-200 ${showBottomBorder ? 'border-border/100 backdrop-blur-md' : 'border-transparent'}`}
        >
            <div className="flex w-full items-center gap-1.5 md:gap-3">
                <SidebarTrigger
                    aria-label="Toggle sidebar"
                    className="inline-flex h-10 w-10 rounded-lg bg-transparent text-foreground transition-colors hover:bg-[hsl(var(--hover-surface))] hover:text-foreground active:bg-[hsl(var(--hover-surface-strong))] focus-visible:ring-2 focus-visible:ring-ring md:hidden"
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
                            className="w-auto min-w-[9rem] max-w-[16rem] border-0 bg-transparent text-foreground transition-colors focus:ring-0 focus:ring-offset-0 hover:bg-[hsl(var(--hover-surface))] active:bg-[hsl(var(--hover-surface-strong))] focus-visible:bg-[hsl(var(--hover-surface-strong))] justify-start gap-2 px-3 h-11"
                        >
                            <SelectValue placeholder="Select an agent">
                                <div className="flex items-center">
                                    {selected && (
                                        <span className="truncate text-lg text-foreground max-w-[8.5rem] md:max-w-[10.5rem]">
                                            {selected.name}
                                        </span>
                                    )}
                                </div>
                            </SelectValue>
                        </SelectTrigger>

                        <SelectContent className="w-[18rem] rounded-xl border border-border/60 bg-background text-foreground shadow-lg">
                            {displayAgents.map(agent => (
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
                            <TooltipContent
                                side="bottom"
                                align="start"
                            >
                                <p>This agent might be inactive.</p>
                            </TooltipContent>
                        </Tooltip>
                    )}
                </div>

                <div className="ml-auto flex items-center gap-1.5 md:gap-3">
                    {showPrivateToggle && (
                        <Tooltip delayDuration={0}>
                            <TooltipTrigger asChild>
                                <button
                                    onClick={onTogglePrivate}
                                    onMouseDown={(e) => e.preventDefault()}
                                    className={`p-3 rounded-full transition-smooth duration-300 ${
                                        isPrivateMode
                                            ? 'text-fuchsia-600 bg-gradient-to-r from-fuchsia-500/20 via-fuchsia-400/25 to-fuchsia-500/20 shadow-[0_0_20px_rgba(217,70,239,0.4)] border border-fuchsia-500/40 hover:shadow-[0_0_25px_rgba(217,70,239,0.5)]'
                                            : 'text-muted-foreground hover:text-foreground hover:bg-[hsl(var(--hover-surface))] active:bg-[hsl(var(--hover-surface-strong))] focus-visible:bg-[hsl(var(--hover-surface-strong))] active:scale-110'
                                    }`}
                                >
                                    <Ghost size={20} />
                                </button>
                            </TooltipTrigger>
                            <TooltipContent
                                side="bottom"
                                align="center"
                            >
                                <p>Private Chat</p>
                            </TooltipContent>
                        </Tooltip>
                    )}
                    {showConversationActions && (
                        <DropdownMenu.Root
                            open={conversationActionsOpen}
                            onOpenChange={onConversationActionsOpenChange}
                        >
                            <DropdownMenu.Trigger asChild>
                                <button
                                    type="button"
                                    onMouseDown={(e) => e.preventDefault()}
                                    className="rounded-xl p-2 text-muted-foreground transition-smooth hover:bg-[hsl(var(--hover-surface))] active:bg-[hsl(var(--hover-surface-strong))] hover:text-foreground focus-visible:bg-[hsl(var(--hover-surface-strong))] focus-visible:outline-none"
                                    aria-label="Conversation actions"
                                >
                                    <MoreHorizontal size={18} />
                                </button>
                            </DropdownMenu.Trigger>
                            <DropdownMenu.Portal>
                                    <DropdownMenu.Content
                                        sideOffset={8}
                                        align="end"
                                        className="z-50 w-48 rounded-xl border border-border bg-background text-foreground shadow-lg p-1.5 focus:outline-none focus-visible:outline-none"
                                    >
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
                                    <DropdownMenu.Separator className="my-1 h-px bg-border/60" />
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
                                </DropdownMenu.Content>
                            </DropdownMenu.Portal>
                        </DropdownMenu.Root>
                    )}
                </div>
            </div>
        </div>
    );
}
