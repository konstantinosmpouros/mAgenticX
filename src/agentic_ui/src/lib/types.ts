import type { LucideIcon } from "lucide-react";

// Attachment type for messages
export type Attachment = {
    file: File;
    url: string | null;
    name: string;
    type: string;
};

// Message type used in the application
export type Message = {
    id: string;
    content: string;
    sender: "user" | "agent";
    timestamp: Date;
    type: "text" | "image" | "file";
    attachments?: (Attachment | string)[];
    thinking?: string[];
    thinkingTime?: number;
};

// Thinking state type used in the application
export type ThinkingState = {
    messageId: string;
    thoughts: string[];
    currentThoughtIndex: number;
    isActive: boolean;
    isDone: boolean;
    startTime: number;
    endTime?: number;
};

// Conversation type used in the application
export type Conversation = {
    id: string;
    agentId: string;
    agentName: string;
    lastMessage: string;
    timestamp: Date;
    messages: Message[];
    isPrivate?: boolean;
};

// Agent type used in the application
export type Agent = {
    id: string;
    name: string;
    description: string;
    icon: LucideIcon;
};




