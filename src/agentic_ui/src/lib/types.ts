import type { LucideIcon } from "lucide-react";


// ------------------------------------------------------
// Authentication Schemas
// ------------------------------------------------------
export type AuthRequest = {
    username: string;
    password: string;
};

export type AuthResponse = {
    authenticated: boolean;
    user_id?: string;
};



// ------------------------------------------------------
// Agent Schemas
// ------------------------------------------------------
// Raw shape returned by backend
export type AgentPublic = {
    id: string;
    name: string;
    description: string;
    icon: string; // Lucide icon name string, e.g., "Building2"
};

// Agent type used in the application
export type Agent = {
    id: string;
    name: string;
    description: string;
    icon: LucideIcon;
};



// ------------------------------------------------------
// Conversation Schemas from Backend
// ------------------------------------------------------
// Raw shape returned by backend for conversations
export type ConversationSummary = {
    id: string;
    agentId: string;
    agentName?: string;
    title?: string;
    isPrivate: boolean;
    lastMessage?: string;
    created_at: string;
    updated_at: string;
};

// Backend conversation detail type from API response
export type ConversationDetail = {
    id: string;
    agentId: string;
    agentName?: string;
    title?: string;
    isPrivate: boolean;
    created_at: Date;
    updated_at: Date;
    messages: MessageOut[];
};

// Backend message type from API response
export type MessageOut = {
    id: string;
    content?: string;
    sender: string;
    type: string;
    timestamp: Date;
    attachments: AttachmentOut[];
    thinking?: string[];
    thinkingTime?: number;
    error?: boolean;
    errorMessage?: string;
};

// Backend attachment type from API response
export type AttachmentOut = {
    id: string;
    name: string;
    mime: string;
    size?: number;
    timestamp: Date;
};



// ------------------------------------------------------
// Conversation Schemas from UI
// ------------------------------------------------------
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
    error?: boolean;
    errorMessage?: string;
};

// Attachment type for messages
export type Attachment = {
    file: File;
    url: string | null;
    name: string;
    type: string;
};



// ------------------------------------------------------
// Other Schemas from UI
// ------------------------------------------------------
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