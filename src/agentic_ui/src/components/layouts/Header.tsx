// src/components/layouts/Header.tsx
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Ghost, User } from "lucide-react";
import type { Agent } from "@/lib/types";
import React from "react";

type HeaderProps = {
    agents: Agent[];
    selectedAgent: string;
    onAgentChange: (id: string) => void;
    onNewChat: () => void;
    
    // private/ghost toggle
    showPrivateToggle: boolean;
    isPrivateMode: boolean;
    onTogglePrivate: () => void;
    
    // user profile
    onOpenUserProfile: () => void;
};

export default function Header({
    agents,
    selectedAgent,
    onAgentChange,
    onNewChat,
    showPrivateToggle,
    isPrivateMode,
    onTogglePrivate,
    onOpenUserProfile,
}: HeaderProps) {
    
    // Get the selected agent and its icon component
    const selected = React.useMemo(
        () => agents.find(a => a.id === selectedAgent),
        [agents, selectedAgent]
    );
    const SelectedIcon = selected?.icon;
    
    return (
        <div className="border-b border-border bg-background dark:bg-background px-3 py-2 md:px-6 md:py-3 relative after:absolute after:bottom-0 after:left-0 after:right-0 after:h-px after:bg-gradient-to-r after:from-transparent after:via-black/40 after:to-transparent dark:after:via-primary/40">
            <div className="flex items-center justify-between max-w-6xl mx-auto">
                {/* Agent select + New chat */}
                <div className="flex items-center gap-1.5 md:gap-3">
                    <Select value={selectedAgent} onValueChange={onAgentChange}>
                        <SelectTrigger 
                        onMouseDown={(e) => e.preventDefault()}
                        className="
                            w-28 sm:w-36 md:w-48 transition-all duration-300 shadow-card 
                            focus:ring-0 focus:ring-offset-0 border-0
                            bg-background text-foreground hover:bg-muted/60
                            dark:bg-transparent dark:text-fuchsia-300 
                            dark:hover:bg-gradient-to-r dark:hover:from-fuchsia-500/5 
                            dark:hover:via-fuchsia-400/8 dark:hover:to-fuchsia-500/5 
                            dark:hover:shadow-[0_0_20px_rgba(217,70,239,0.3)] 
                        ">
                            <SelectValue placeholder="Select an agent">
                                <div className="flex items-center gap-2">
                                    {selected && SelectedIcon && (
                                        <SelectedIcon size={16} className="text-muted-foreground dark:text-fuchsia-300 dark:drop-shadow-[0_0_3px_rgba(217,70,239,0.6)]" />
                                    )}
                                    {selected && (
                                        <span className="truncate text-sm text-foreground dark:text-fuchsia-300 dark:drop-shadow-[0_0_3px_rgba(217,70,239,0.6)]">
                                            {selected.name}
                                        </span>
                                    )}
                                </div>
                            </SelectValue>
                        </SelectTrigger>
                        
                        <SelectContent className="w-[20rem] bg-background border border-input text-foreground shadow-card backdrop-blur-xl dark:bg-transparent dark:shadow-[0_0_20px_rgba(217,70,239,0.2)] dark:border-0">
                            {agents.map(agent => (
                                <SelectItem
                                    key={agent.id}
                                    value={agent.id}
                                    className="group cursor-pointer transition-colors
                                                data-[highlighted]:bg-muted data-[highlighted]:text-foreground
                                                data-[state=checked]:bg-muted data-[state=checked]:text-foreground
                                                dark:data-[highlighted]:bg-gray-800 dark:data-[highlighted]:text-fuchsia-200
                                                dark:data-[state=checked]:bg-gray-900 dark:data-[state=checked]:text-fuchsia-200
                                                [&_[data-radix-select-item-indicator]]:hidden"
                                >
                                    <div className="flex items-center gap-2 mt-1">
                                        {/* Agent icon shown ONLY when the item is selected (replaces the check) */}
                                        {(() => {
                                        const Icon = agent.icon; // type: LucideIcon
                                        return (
                                            <Icon
                                            size={18}
                                            className="text-muted-foreground dark:text-fuchsia-300 absolute left-2 flex h-4 w-4 items-center justify-center opacity-0 group-data-[state=checked]:opacity-100 transition-opacity"
                                            />
                                        );
                                        })()}
                                        
                                        <div className="flex flex-col">
                                            <span className="font-medium text-sm text-foreground dark:text-inherit">{agent.name}</span>
                                            <span className="text-xs text-muted-foreground">{agent.description}</span>
                                        </div>
                                    </div>
                                </SelectItem>
                            
                            ))}
                        </SelectContent>
                    </Select>
                    
                    <Tooltip delayDuration={0}>
                        <TooltipTrigger asChild>
                            <button
                                onClick={onNewChat}
                                className="p-4 text-muted-foreground hover:text-white hover:bg-gray-900 dark:hover:text-white dark:hover:bg-gray-800 rounded-full transition-smooth active:bg-gray-700 active:scale-110"
                                onMouseDown={(e) => e.preventDefault()}
                            >
                                <Plus size={20} />
                            </button>
                        </TooltipTrigger>
                        <TooltipContent
                            side="bottom"
                            align="center"
                            className="!opacity-100 bg-background text-foreground border border-border shadow-card px-2 py-1 rounded-md"
                        >
                            <p>New Chat</p>
                        </TooltipContent>
                    </Tooltip>
                </div>
                
                {/* Right controls */}
                <div className="flex items-center gap-1.5 md:gap-3 ml-auto">
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
                    
                    <Tooltip delayDuration={0}>
                        <TooltipTrigger asChild>
                            <button
                                onClick={onOpenUserProfile}
                                onMouseDown={(e) => e.preventDefault()}
                                className="p-3 text-muted-foreground hover:text-white hover:bg-gray-900 dark:hover:text-white dark:hover:bg-gray-800 rounded-full transition-smooth active:scale-110 active:bg-fuchsia-500/20 active:border-fuchsia-500/50"
                            >
                                <User size={20} className="active:text-fuchsia-600" />
                            </button>
                        </TooltipTrigger>
                        <TooltipContent
                            side="bottom"
                            align="center"
                            className="!opacity-100 bg-background text-foreground border border-border shadow-card px-2 py-1 rounded-md"
                        >
                            <p>User Profile</p>
                        </TooltipContent>
                    </Tooltip>
                </div>
            </div>
        </div>
    );
}

