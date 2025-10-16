// src/components/layouts/Header.tsx
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Ghost, Archive, Flag, Trash2, MoreHorizontal } from "lucide-react";
import type { Agent } from "@/lib/types";
import React from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";

type HeaderProps = {
    agents: Agent[];
    selectedAgent: string;
    onAgentChange: (id: string) => void;
    showPrivateToggle: boolean;
    isPrivateMode: boolean;
    onTogglePrivate: () => void;
    showBottomBorder?: boolean;
    showConversationActions?: boolean;
    onArchiveConversation?: () => void;
    onReportConversation?: () => void;
    onDeleteConversation?: () => void;
};

export default function Header({
    agents,
    selectedAgent,
    onAgentChange,
    showPrivateToggle,
    isPrivateMode,
    onTogglePrivate,
    showBottomBorder = false,
    showConversationActions = false,
    onArchiveConversation,
    onReportConversation,
    onDeleteConversation,
}: HeaderProps) {
    const selected = React.useMemo(
        () => agents.find(a => a.id === selectedAgent),
        [agents, selectedAgent]
    );
    const SelectedIcon = selected?.icon;

    return (
        <div
            className={`sticky top-0 z-40 w-full bg-transparent px-3 py-2 md:px-6 md:py-3 border-b transition-colors duration-200 ${showBottomBorder ? 'border-border/100 backdrop-blur-md' : 'border-transparent'}`}
        >
            <div className="flex w-full items-center gap-1.5 md:gap-3">
                <Select value={selectedAgent} onValueChange={onAgentChange}>
                    <SelectTrigger
                        onMouseDown={(e) => e.preventDefault()}
                        className="w-auto min-w-[9rem] max-w-[16rem] border-0 bg-background/70 text-foreground transition-colors focus:ring-0 focus:ring-offset-0 hover:bg-muted/60 dark:bg-background/40 dark:text-foreground dark:hover:bg-muted/40 justify-start gap-1.5 px-3"
                    >
                        <SelectValue placeholder="Select an agent">
                            <div className="flex items-center gap-2">
                                {selected && SelectedIcon && (
                                    <SelectedIcon size={16} className="text-muted-foreground" />
                                )}
                                {selected && (
                                    <span className="truncate text-sm text-foreground max-w-[8.5rem] md:max-w-[10.5rem]">
                                        {selected.name}
                                    </span>
                                )}
                            </div>
                        </SelectValue>
                    </SelectTrigger>

                    <SelectContent className="w-[18rem] rounded-xl border border-border/60 bg-background text-foreground shadow-lg">
                        {agents.map(agent => (
                            <SelectItem
                                key={agent.id}
                                value={agent.id}
                                className="cursor-pointer text-sm transition-colors data-[highlighted]:bg-muted data-[highlighted]:text-foreground data-[state=checked]:bg-muted data-[state=checked]:text-foreground"
                            >
                                <div className="flex items-center gap-2">
                                    {(() => {
                                        const Icon = agent.icon;
                                        return <Icon size={18} className="text-muted-foreground" />;
                                    })()}
                                    <div className="flex flex-col">
                                        <span className="font-medium text-sm text-foreground">{agent.name}</span>
                                        <span className="text-xs text-muted-foreground">{agent.description}</span>
                                    </div>
                                </div>
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>

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
                                            : 'text-muted-foreground hover:text-white hover:bg-gray-800 active:bg-gradient-to-r active:from-fuchsia-500/15 active:via-fuchsia-400/20 active:to-fuchsia-500/15 active:scale-110'
                                    }`}
                                >
                                    <Ghost size={20} />
                                </button>
                            </TooltipTrigger>
                            <TooltipContent
                                side="bottom"
                                align="center"
                                className="!opacity-100 bg-background text-foreground border border-border shadow-card px-2 py-1 rounded-md"
                            >
                                <p>Private Chat</p>
                            </TooltipContent>
                        </Tooltip>
                    )}
                    {showConversationActions && (
                        <DropdownMenu.Root>
                            <DropdownMenu.Trigger asChild>
                                <button
                                    type="button"
                                    onMouseDown={(e) => e.preventDefault()}
                                    className="rounded-full p-2 text-muted-foreground transition-smooth hover:bg-gray-800/80 hover:text-white focus-visible:outline-none"
                                    aria-label="Conversation actions"
                                >
                                    <MoreHorizontal size={18} />
                                </button>
                            </DropdownMenu.Trigger>
                            <DropdownMenu.Portal>
                                <DropdownMenu.Content
                                    sideOffset={8}
                                    align="end"
                                    className="z-50 w-48 rounded-xl border border-border/60 bg-background text-foreground shadow-lg"
                                >
                                    <DropdownMenu.Item
                                        onSelect={() => {
                                            onArchiveConversation?.();
                                        }}
                                        className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm text-foreground transition-colors data-[highlighted]:bg-muted data-[highlighted]:text-foreground"
                                    >
                                        <Archive size={16} className="text-muted-foreground" />
                                        <span>Archive</span>
                                    </DropdownMenu.Item>
                                    <DropdownMenu.Item
                                        onSelect={() => {
                                            onReportConversation?.();
                                        }}
                                        className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm text-foreground transition-colors data-[highlighted]:bg-muted data-[highlighted]:text-foreground"
                                    >
                                        <Flag size={16} className="text-muted-foreground" />
                                        <span>Report</span>
                                    </DropdownMenu.Item>
                                    <DropdownMenu.Separator className="my-1 h-px bg-border/60" />
                                    <DropdownMenu.Item
                                        onSelect={() => {
                                            onDeleteConversation?.();
                                        }}
                                        className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm text-destructive transition-colors data-[highlighted]:bg-destructive/10 data-[highlighted]:text-destructive"
                                    >
                                        <Trash2 size={16} />
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
