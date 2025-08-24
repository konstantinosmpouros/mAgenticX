// src/components/layouts/Header.tsx
import { Button } from "@/components/utils/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/utils/tooltip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/utils/select";
import { Plus, Ghost, User } from "lucide-react";
import type { Agent } from "@/lib/types";

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
    return (
        <div className="border-b border-gradient[pink] bg-gradient-to-r from-white/80 to-gray-50/80 dark:from-[rgba(17,22,40,0.7)] dark:to-[rgba(17,22,40,0.7)] backdrop-blur-lg p-3 md:p-6 relative after:absolute after:bottom-0 after:left-0 after:right-0 after:h-px after:bg-gradient-to-r after:from-transparent after:via-primary/40 after:to-transparent">
            <div className="flex items-center justify-between max-w-6xl mx-auto">
                {/* Agent select + New chat */}
                <div className="flex items-center gap-1.5 md:gap-3">
                    <Select value={selectedAgent} onValueChange={onAgentChange}>
                        <SelectTrigger className="w-28 sm:w-36 md:w-48 bg-transparent border-1 border-fuchsia-500/30 hover:border-fuchsia-400/50 hover:bg-gradient-to-r hover:from-fuchsia-500/5 hover:via-fuchsia-400/8 hover:to-fuchsia-500/5 hover:shadow-[0_0_20px_rgba(217,70,239,0.3)] transition-all duration-300 shadow-card focus:ring-0 focus:ring-offset-0 focus:border-fuchsia-400/60 text-fuchsia-300 font-medium">
                            <SelectValue placeholder="Select an agent">
                                <div className="flex items-center gap-2">
                                    {selectedAgent && (
                                        <span className="truncate text-sm text-fuchsia-300 drop-shadow-[0_0_3px_rgba(217,70,239,0.6)]">
                                        {agents.find(a => a.id === selectedAgent)?.name}
                                        </span>
                                    )}
                                </div>
                            </SelectValue>
                        </SelectTrigger>
                        
                        <SelectContent className="w-[20rem] bg-transparent backdrop-blur-xl shadow-[0_0_20px_rgba(217,70,239,0.2)]">
                            {agents.map(agent => (
                                <SelectItem
                                key={agent.id}
                                value={agent.id}
                                className="cursor-pointer transition-colors data-[highlighted]:bg-gray-800 data-[highlighted]:text-fuchsia-200 data-[state=checked]:bg-gray-900 data-[state=checked]:text-fuchsia-200"
                                >
                                <div className="flex items-center gap-2 mt-1">
                                    <div className="flex flex-col">
                                    <span className="font-medium text-sm">{agent.name}</span>
                                    <span className="text-xs text-muted-foreground">{agent.description}</span>
                                    </div>
                                </div>
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                onClick={onNewChat}
                                className="p-4 text-muted-foreground hover:text-foreground hover:bg-gray-800 rounded-full transition-smooth active:bg-gray-700 active:scale-110"
                                variant="ghost"
                            >
                                <Plus size={20} />
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent><p>New Chat</p></TooltipContent>
                    </Tooltip>
                </div>
                
                {/* Right controls */}
                <div className="flex items-center gap-1.5 md:gap-3 ml-auto">
                    {showPrivateToggle && (
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <button
                                    onClick={onTogglePrivate}
                                    className={`p-3 rounded-full transition-smooth duration-300 ${
                                        isPrivateMode
                                        ? 'text-fuchsia-600 bg-gradient-to-r from-fuchsia-500/20 via-fuchsia-400/25 to-fuchsia-500/20 shadow-[0_0_20px_rgba(217,70,239,0.4)] border border-fuchsia-500/40 hover:shadow-[0_0_25px_rgba(217,70,239,0.5)]'
                                        : 'text-muted-foreground hover:text-white hover:bg-gray-800 active:bg-gradient-to-r active:from-fuchsia-500/15 active:via-fuchsia-400/20 active:to-fuchsia-500/15 active:scale-110'
                                    }`}
                                >
                                    <Ghost size={20} />
                                </button>
                            </TooltipTrigger>
                            <TooltipContent><p>Private Chat</p></TooltipContent>
                        </Tooltip>
                    )}
                    
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                onClick={onOpenUserProfile}
                                className="p-4 text-muted-foreground hover:text-foreground hover:bg-gray-800 rounded-full transition-smooth active:scale-110 active:bg-fuchsia-500/20 active:border-fuchsia-500/50"
                                variant="ghost"
                            >
                                <User size={20} className="active:text-fuchsia-600" />
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent><p>User Profile</p></TooltipContent>
                    </Tooltip>
                </div>
            </div>
        </div>
    );
}
