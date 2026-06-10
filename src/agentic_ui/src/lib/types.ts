import type { LucideIcon } from "lucide-react";
import type { PlanSnapshot } from "@/lib/agui";
import type { RealtimeVoice, VoiceModeLanguage } from "@/lib/consts";


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
    type?: string;
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
    // Lifecycle type — "deep agent" / "langgraph agent" / "openai agent".
    // Used by the Skills tab to filter to agents that support per-user
    // skill selection (only deep agents do).
    type?: string;
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

export type ToolWithStatus = ToolMetadata & { enabled?: boolean };

// Profile panel — a documentation/support entry on the Help tab.
export type HelpCard = {
    title: string;
    desc: string;
    href?: string;
    external?: boolean;
};

// Profile panel — a single label/value row rendered inside InfoRowsCard.
export type InfoRow = {
    label: string;
    value: string;
    hint?: string;
};

// Skills tab sub-view. The tab opens on the hub (a row per area); each row
// navigates into a dedicated view, and a Back control returns to the hub.
export type SkillsSubView = "hub" | "global" | "mine" | "agents" | "create";


// One entry in the global (admin-curated) skills catalog. The agent uses
// `content` as the SKILL.md body; the UI shows `name` + `description` with
// click-to-expand for the body. `category` is the parent folder in the
// `<category>/<skill>/` global hierarchy — surfaced as a small label.
export type Skill = {
    name: string;
    description: string;
    content: string;
    category: string;
};


// One entry in the user's personal skill pool — either a reference to a
// global catalog skill (type="global") or a user-authored custom skill
// (type="custom"). `source_path` is opaque on the frontend; only the agents
// service interprets it. `category` mirrors the global hierarchy and is
// empty for customs.
export type UserSkill = {
    name: string;
    type: "global" | "custom";
    description: string;
    source_path: string;
    category: string;
};


// One file inside a skill folder. `path` is relative to the skill root and
// "/"-separated (e.g. "SKILL.md", "references/api.md"). `content` is UTF-8
// text when `encoding` is "utf-8" or base64 when "base64" (binary assets).
// `size` is the decoded byte length — present on reads, omitted on create.
export type SkillFile = {
    path: string;
    content: string;
    encoding: "utf-8" | "base64";
    size?: number;
};


// A node in a skill's folder tree, derived from a flat list of file paths.
// `path` is the full relative path to this node; folders have children.
export type SkillTreeNode = {
    name: string;
    path: string;
    isDir: boolean;
    children: SkillTreeNode[];
};


// User-pool entry joined with its file inventory. Returned by the detail
// endpoint when the user expands a card. `content` is the SKILL.md body
// (quick preview); `files` is the full on-disk tree.
export type UserSkillDetail = UserSkill & {
    content: string;
    files: SkillFile[];
};


// Form payload for creating a user-owned custom skill. The folder is described
// as a list of files; exactly one must be "SKILL.md".
export type CustomSkillCreatePayload = {
    name: string;
    description: string;
    files: SkillFile[];
};


// Per-(user, agent) skill selection. Map shape is { [agentId]: Set<skillName> }
// stored as plain object so it serialises cleanly through React state.
// The bridge endpoint returns a plain string[] per (user, agent); the hook
// hydrates this map by fetching per-agent on demand.
export type UserAgentSkillSelection = Record<string, string[]>;



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
    suggestionsEnabled?: boolean;
    voiceModeVoice?: RealtimeVoice;
    voiceModeLanguage?: VoiceModeLanguage;
};

export type VoiceModeStatus = "closed" | "connecting" | "listening" | "thinking" | "speaking" | "muted" | "error";

export type RealtimeVoiceSessionRequest = {
    agentId: string;
    conversationId?: string | null;
    sdp: string;
    voice?: RealtimeVoice;
    language?: VoiceModeLanguage;
};

export type RealtimeVoiceSessionResponse = {
    sdp: string;
    model: string;
    voice: string;
};

export type RealtimeVoiceConversationEventRequest = {
    conversationId: string;
    role: "user" | "assistant";
    transcript: string;
    itemId?: string | null;
    responseId?: string | null;
    rawEvent?: Record<string, any> | null;
};



// ------------------------------------------------------
// Conversation Schemas from Backend
// ------------------------------------------------------
// Raw shape returned by backend for conversations
export type ConversationSummary = {
    id: string;
    agent: Agent;
    forkedParentId?: string | null;
    forkedMessageId?: string | null;
    title?: string;
    isPrivate: boolean;
    isArchived?: boolean;
    archivedAt?: Date | null;
    isReported?: boolean;
    reportedAt?: Date | null;
    activeRunId?: string | null;
    isStreaming?: boolean;
    lastMessage?: string;
    created_at: string;
    updated_at: string;
};

// Backend conversation detail type from API response
export type ConversationDetail = {
    id: string;
    agent: Agent;
    forkedParentId?: string | null;
    forkedMessageId?: string | null;
    title?: string;
    isPrivate: boolean;
    isArchived?: boolean;
    archivedAt?: Date | null;
    isReported?: boolean;
    reportedAt?: Date | null;
    activeRunId?: string | null;
    isStreaming?: boolean;
    created_at: Date;
    updated_at: Date;
    messages: MessageOut[];
};

export type ConversationReportPayload = {
    reason: string;
    details?: string;
    messageId?: string | null;
};

export type ConversationShareMode = "full" | "branch" | "message";

export type ConversationShareResponse = {
    id: string;
    token: string;
    shareUrl: string;
    conversationId: string;
    messageId: string;
    shareMode: ConversationShareMode;
    title?: string | null;
    isActive: boolean;
    revokedAt?: Date | null;
    expiresAt?: Date | null;
    createdAt: Date;
};

export type ConversationShareStatus = "active" | "expired" | "revoked";

export type ConversationShareListItem = {
    id: string;
    token: string;
    shareUrl: string;
    conversationId: string;
    messageId?: string | null;
    shareMode: ConversationShareMode;
    title?: string | null;
    isActive: boolean;
    status: ConversationShareStatus;
    revokedAt?: Date | null;
    expiresAt?: Date | null;
    createdAt: Date;
};

export type SharedConversationDetail = {
    token: string;
    title?: string | null;
    shareMode: ConversationShareMode;
    agent: Agent;
    messages: MessageOut[];
    expiresAt?: Date | null;
    createdAt: Date;
};

export type WorkspaceSearchResultKind = "conversation" | "message" | "file" | "agent";

export type WorkspaceSearchResult = {
    kind: WorkspaceSearchResultKind;
    id: string;
    conversationId?: string | null;
    agentId?: string | null;
    title: string;
    subtitle?: string | null;
    snippet?: string | null;
    updatedAt?: string | Date | null;
};

// Backend message type from API response
export type MessageOut = {
    id: string;
    parentMessageId?: string | null;
    content?: string;
    sender: string;
    type: string;
    liked?: boolean;
    agentId?: string | null;
    agentName?: string | null;
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
    data?: string; // Base64 encoded data for images and public share downloads
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

export type InferenceRunStatus = "queued" | "running" | "cancelling" | "completed" | "cancelled" | "failed";

export type InferenceRun = {
    id: string;
    userId: string;
    conversationId: string;
    assistantMessageId: string;
    parentMessageId?: string | null;
    status: InferenceRunStatus | string;
    messagePath: string[];
    enabledTools?: ToolPreference[];
    content?: string | null;
    thinking?: string[] | null;
    rawEvents?: Record<string, any>[];
    plan?: Record<string, any> | null;
    subagents?: Record<string, any> | null;
    errorMessage?: string | null;
    startedAt: Date;
    completedAt?: Date | null;
    cancelRequestedAt?: Date | null;
    updatedAt: Date;
};

export type InferenceStartMode = "new" | "send" | "edit" | "retry" | "shared_continue";

export type InferenceStartRequest = {
    mode: InferenceStartMode;
    agentId?: string;
    isPrivate?: boolean;
    title?: string;
    sharedConversationToken?: string;
    conversationId?: string;
    parentMessageId?: string;
    targetMessageId?: string;
    messagePath?: string[];
    enabledTools?: ToolPreference[];
    message?: MessageIn;
};

export type InferenceStartResponse = {
    detail: ConversationDetail;
    summary: ConversationSummary;
    run: InferenceRun;
    message: MessageOut;
};

export type InferenceRunEvent = {
    type: "snapshot" | "update" | "terminal";
    run: InferenceRun;
    message?: MessageOut | null;
    summary?: ConversationSummary | null;
};

// Parameters required to download an attachment from the backend
export type DownloadAttachmentParams = {
    userId: string;
    conversationId: string;
    messageId: string;
    blobId: string;
    filename?: string;
};

export type DocxPreviewTokenResponse = {
    token: string;
    expiresIn: number;
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
