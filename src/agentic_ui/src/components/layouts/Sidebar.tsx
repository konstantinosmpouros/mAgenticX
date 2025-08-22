// src/components/layouts/Sidebar.tsx
import * as React from "react";
import { Button } from "@/components/utils/button";
import { Card } from "@/components/utils/card";
import { ScrollArea } from "@/components/utils/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/utils/tooltip";
import { Sheet, SheetContent, SheetTrigger } from "@/components/utils/sheet";
import { ChevronRightIcon, MessageSquare, X, Building2 } from "lucide-react";
import type { Agent, ConversationSummary } from "@/lib/types";

type SidebarProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    
    // Conversations
    conversations: ConversationSummary[];
    currentConversationId: string | null;
    onSelectConversation: (c: ConversationSummary) => void;
    onDeleteConversation: (id: string, e: React.MouseEvent) => void;
    
    // Title click handler
    onTitleClick: () => void;
    agents: Agent[];
};

export default function Sidebar({
    open,
    onOpenChange,
    conversations,
    currentConversationId,
    onSelectConversation,
    onDeleteConversation,
    onTitleClick,
    agents,
}: SidebarProps) {
    return (
        <div className="absolute left-2 top-[5.8rem] z-10">
            <Sheet open={open} onOpenChange={onOpenChange}>
                <Tooltip>
                    <TooltipTrigger asChild>
                        <SheetTrigger asChild>
                            <Button
                                variant="outline"
                                className="w-10 h-10 rounded-full bg-secondary/90 border-border hover:bg-secondary transition-bounce shadow-card hover:scale-105 active:scale-95"
                            >
                                <ChevronRightIcon size={16} />
                            </Button>
                        </SheetTrigger>
                    </TooltipTrigger>
                    <TooltipContent side="right"><p>Conversation History</p></TooltipContent>
                </Tooltip>
                
                <SheetContent side="left" className="w-[clamp(16rem,30vw,20rem)] md:w-[clamp(18rem,35vw,22rem)] lg:w-[clamp(16rem,30vw,20rem)] p-0 transition-slow">
                    <div className="h-full bg-gradient-card border-r border-border">
                        {/* Title */}
                        <div className="p-6 border-b border-border">
                            <div className="flex items-center gap-2 md:gap-4 cursor-pointer mb-6" onClick={onTitleClick}>
                                <div className="w-8 h-8 md:w-12 md:h-12 rounded-xl bg-gradient-primary flex items-center justify-center shadow-elegant">
                                    <MessageSquare size={16} className="md:hidden text-primary-foreground" />
                                    <MessageSquare size={24} className="hidden md:block text-primary-foreground" />
                                </div>
                                <div>
                                    <h1 className="text-lg md:text-2xl font-bold bg-gradient-primary bg-clip-text text-transparent">
                                        Agentic Chatting
                                    </h1>
                                    <p className="text-muted-foreground text-xs md:text-sm">Professional AI agent interactions</p>
                                </div>
                            </div>
                            <h3 className="text-lg font-semibold mb-[-1rem] text-muted-foreground">Conversation History</h3>
                        </div>
                        
                        {/* List */}
                        <ScrollArea className="h-full pb-20">
                            <div className="p-4 space-y-3">
                                {conversations.length === 0 ? (
                                    <div className="text-center py-8">
                                        <MessageSquare size={32} className="mx-auto text-muted-foreground/50 mb-3" />
                                        <p className="text-sm text-muted-foreground">No conversations yet</p>
                                    </div>
                                ) : (
                                    conversations.map(conv => {
                                        const agent = agents.find(a => a.id === conv.agentId);
                                        const Icon = agent?.icon || Building2;
                                        return (
                                            <Card
                                                key={conv.id}
                                                className={`relative p-4 cursor-pointer transition-bounce border-border/50 group transform hover:scale-[1.02] hover:shadow-lg ${
                                                    conv.id === currentConversationId ? "bg-primary/10 border-primary/30 ring-1 ring-primary/20 scale-[1.01]" : "hover:bg-accent/50"
                                                }`}
                                                onClick={() => onSelectConversation(conv)}
                                            >
                                                <Button
                                                    size="sm"
                                                    variant="ghost"
                                                    className="absolute top-2 right-2 w-6 h-6 p-0 opacity-0 group-hover:opacity-100 transition-bounce hover:bg-destructive/20 hover:text-destructive hover:scale-110 active:scale-95"
                                                    onClick={(e) => onDeleteConversation(conv.id, e)}
                                                >
                                                    <X size={12} />
                                                </Button>
                                            
                                                <div className="flex items-start gap-3">
                                                    <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
                                                        <Icon size={16} className="text-primary" />
                                                    </div>
                                                    <div className="flex-1 min-w-0">
                                                        <div className="font-medium text-sm mb-1">{conv.agentName}</div>
                                                        <div className="text-xs text-muted-foreground truncate">{conv.lastMessage}</div>
                                                        <div className="text-xs text-muted-foreground/70 mt-1">{new Date(conv.updated_at).toLocaleDateString()}</div>
                                                    </div>
                                                </div>
                                            </Card>
                                        );
                                    })
                                )}
                            </div>
                        </ScrollArea>
                    </div>
                </SheetContent>
            </Sheet>
        </div>
    );
}
