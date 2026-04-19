import type { LucideIcon } from "lucide-react";
import type { PlanSnapshot } from "@/lib/agui";


// ------------------------------------------------------
// Authentication Schemas
// ------------------------------------------------------
export type AuthRequest = {
    username: string;
    password: string;
};

export type UserProfile = {
    id: string;
    username: string;
    email?: string;
    displayName?: string;
    fullName?: string;
    avatarUrl?: string;
    department?: string;
    roleTitle?: string;
    lastLoginAt?: Date;
    isActive: boolean;
    createdAt: Date;
    updatedAt: Date;
};

export type AuthResponse = {
    authenticated: boolean;
    user_id?: string;
    user?: UserProfile;
    tokenTtl?: number;
};

export type AuthApiError = Error & {
    status?: number;
    retryAfterSeconds?: number;
    detail?: string;
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
    version?: string;
    isActive: boolean;
};

// Agent type used in the application
export type Agent = {
    id: string;
    name: string;
    description: string;
    icon: LucideIcon;
    iconName?: string | null;
    version?: string;
    isActive: boolean;
};



// ------------------------------------------------------
// Tool Schemas
// ------------------------------------------------------
// Tool metadata fetched from the backend
export type ToolMetadata = {
    serverId: string;
    toolName: string;
    description: string;
    parameterCount: number;
};



// ------------------------------------------------------
// User Preferences Schemas
// ------------------------------------------------------
// User preferences related types
export type ToolPreference = {
    serverId: string;
    toolName: string;
};

export type UserPreferences = {
    tools?: {
        disabled?: ToolPreference[];
    };
    prefersAgenticChat?: boolean;
};



// ------------------------------------------------------
// Conversation Schemas from Backend
// ------------------------------------------------------
// Raw shape returned by backend for conversations
export type ConversationSummary = {
    id: string;
    agent: Agent;
    title?: string;
    isPrivate: boolean;
    isArchived?: boolean;
    archivedAt?: Date | null;
    isReported?: boolean;
    reportedAt?: Date | null;
    lastMessage?: string;
    created_at: string;
    updated_at: string;
};

// Backend conversation detail type from API response
export type ConversationDetail = {
    id: string;
    agent: Agent;
    title?: string;
    isPrivate: boolean;
    isArchived?: boolean;
    archivedAt?: Date | null;
    isReported?: boolean;
    reportedAt?: Date | null;
    created_at: Date;
    updated_at: Date;
    messages: MessageOut[];
};

export type ConversationReportPayload = {
    reason: string;
    details?: string;
    messageId?: string | null;
};

// Backend message type from API response
export type MessageOut = {
    id: string;
    parentMessageId?: string | null;
    content?: string;
    sender: string;
    type: string;
    liked?: boolean;
    created_at: Date;
    updated_at: Date;
    attachments: AttachmentOut[];
    thinking?: string[];
    thinkingTime?: number;
    error?: boolean;
    errorMessage?: string;
    rawEvents?: Record<string, any>[];  // defaults to [] on the backend
    plan?: PlanSnapshot;
    subagents?: Record<string, any>;
};

// Backend attachment type from API response
export type AttachmentOut = {
    id: string;
    name: string;
    mime: string;
    size?: number;
    timestamp: Date;
    blobId?: string;
    data?: string; // Base64 encoded image data for images
};


// ------------------------------------------------------
// API Request Schemas (for creating conversations)
// ------------------------------------------------------
// Attachment input for API requests (base64 format)
export type AttachmentIn = {
    name: string;
    mime: string;
    dataB64: string;
    size?: number;
};

// Message input for API requests
export type MessageIn = {
    sender: string;
    type: string;
    parentMessageId?: string | null;
    content?: string;
    attachments?: AttachmentIn[];
    thinking?: string[];
    thinkingTime?: number;
    error?: boolean;
    errorMessage?: string;
    rawEvents?: Record<string, any>[];  // defaults to [] on the backend
    plan?: PlanSnapshot;
    subagents?: Record<string, any>;
};

// Message update payload (used to finalise AI placeholders)
export type MessageUpdate = {
    content: string;
    thinking?: string[];
    thinkingTime?: number;
    error?: boolean;
    errorMessage?: string;
    rawEvents?: Record<string, any>[];  // defaults to [] on the backend
    plan?: PlanSnapshot;
    subagents?: Record<string, any>;
};

// Conversation creation payload
export type ConversationIn = {
    agentId: string;
    isPrivate: boolean;
    title?: string;
    firstMessage: MessageIn;
};

// Response from createConversation API
export type CreateConversationResponse = {
    detail: ConversationDetail;
    summary: ConversationSummary;
};

// Response from addMessageToConversation API  
export type UpdateConversationResponse = {
    message: MessageOut;
    summary: ConversationSummary;
};

// Parameters required to download an attachment from the backend
export type DownloadAttachmentParams = {
    userId: string;
    conversationId: string;
    messageId: string;
    blobId: string;
    filename?: string;
};



// ------------------------------------------------------
// Other Schemas from UI
// ------------------------------------------------------
// File upload attachment type for UI
export type FileAttachment = {
    file: File;
    url: string;
    name: string;
    type: string;
};

// Union type for handling both API and upload attachments
// Thinking state type used in the application
export type ThinkingState = {
    messageId: string;
    thoughts: string[];
    currentThoughtIndex: number;
    isActive: boolean;
    isDone: boolean;
    startTime: number;
    endTime?: number;
    branchPath?: string[];
};
