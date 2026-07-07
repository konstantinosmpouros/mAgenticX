import type { LucideIcon } from "lucide-react";
import type { PlanSnapshot } from "@/features/inference/agui";
import type { RealtimeVoice, VoiceModeLanguage } from "@/shared/lib/consts";

// Wire-response contracts whose TypeScript shape is INFERRED from the Zod
// schemas in `schemas.ts` (the single source of truth for these). Re-exported
// here so the rest of the app keeps importing every type from `@/shared/lib/types`,
// while the runtime validator and the compile-time type can never drift apart.
import type {
  Skill,
  UserSkill,
  SkillFile,
  UserSkillDetail,
  MemorySummary,
  MemoryDetail,
  ToolMetadata,
  DocxPreviewTokenResponse,
  RealtimeVoiceSessionResponse,
  WorkspaceSearchResult,
  WorkspaceSearchResultKind,
} from "./schemas";

export type {
  Skill,
  UserSkill,
  SkillFile,
  UserSkillDetail,
  MemorySummary,
  MemoryDetail,
  ToolMetadata,
  DocxPreviewTokenResponse,
  RealtimeVoiceSessionResponse,
  WorkspaceSearchResult,
  WorkspaceSearchResultKind,
};


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
// `ToolMetadata` is inferred from `ToolMetadataSchema` (see re-export above).
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


// `Skill`, `UserSkill`, `SkillFile`, `UserSkillDetail` are inferred from their
// Zod schemas (see re-export above).


// A node in a skill's folder tree, derived from a flat list of file paths.
// `path` is the full relative path to this node; folders have children.
export type SkillTreeNode = {
    name: string;
    path: string;
    isDir: boolean;
    children: SkillTreeNode[];
};


// Form payload for creating a user-owned custom skill. The folder is described
// as a list of files; exactly one must be "SKILL.md".
export type CustomSkillCreatePayload = {
    name: string;
    description: string;
    files: SkillFile[];
};


// `MemorySummary` and `MemoryDetail` are inferred from their Zod schemas
// (see re-export above).


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
    showMessageTokenUsage?: boolean;
    searchPastConvs?: boolean;
    useMemory?: boolean;
    voiceModeVoice?: RealtimeVoice;
    voiceModeLanguage?: VoiceModeLanguage;
};

// Aggregate token usage for one conversation's active branch (AI messages only),
// computed client-side from message.inputTokens/outputTokens.
export type ConversationUsage = {
    totalInput: number;
    totalOutput: number;
    totalTokens: number;
    aiMessageCount: number;
    avgInput: number;
    avgOutput: number;
};

export type VoiceModeStatus = "closed" | "connecting" | "listening" | "thinking" | "speaking" | "muted" | "error";

export type RealtimeVoiceSessionRequest = {
    agentId: string;
    conversationId?: string | null;
    sdp: string;
    voice?: RealtimeVoice;
    language?: VoiceModeLanguage;
};

// `RealtimeVoiceSessionResponse` is inferred from its Zod schema
// (see re-export above).

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

// `WorkspaceSearchResultKind` and `WorkspaceSearchResult` are inferred from
// their Zod schemas (see re-export above).

// Backend message type from API response
export type MessageOut = {
    id: string;
    parentMessageId?: string | null;
    content?: string;
    sender: string;
    liked?: boolean;
    agentId?: string | null;
    agentName?: string | null;
    created_at: Date;
    updated_at: Date;
    attachments: AttachmentOut[];
    thinking?: string[];
    thinkingTime?: number;
    inputTokens?: number;
    outputTokens?: number;
    error?: boolean;
    errorMessage?: string;
    streamingStatus?: string | null;
    rawEvents?: Record<string, any>[];  // defaults to [] on the backend
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
    parentMessageId?: string | null;
    content?: string;
    attachments?: AttachmentIn[];
    thinking?: string[];
    thinkingTime?: number;
    error?: boolean;
    errorMessage?: string;
    rawEvents?: Record<string, any>[];  // defaults to [] on the backend
};

// Message update payload (used to finalise AI placeholders)
export type MessageUpdate = {
    content: string;
    thinking?: string[];
    thinkingTime?: number;
    error?: boolean;
    errorMessage?: string;
    rawEvents?: Record<string, any>[];  // defaults to [] on the backend
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
    // Set when this run was produced by a scheduled-task fire (lets the UI tie a
    // live run back to its task for the "running" badge).
    scheduledTaskId?: string | null;
    messagePath: string[];
    enabledTools?: ToolPreference[];
    content?: string | null;
    thinking?: string[] | null;
    rawEvents?: Record<string, any>[];
    inputTokens?: number | null;
    outputTokens?: number | null;
    pendingInterrupts?: number;
    errorMessage?: string | null;
    startedAt: Date;
    completedAt?: Date | null;
    cancelRequestedAt?: Date | null;
    updatedAt: Date;
    timeline?: RunTimeline;
};

// ------------------------------------------------------
// Run timeline — derived client-side from the raw AG-UI event log.
// The same reducer (lib/timeline.ts) folds live WS frames incrementally and
// replays persisted message.rawEvents on hydration, so live and hydrated
// views cannot drift. Never persisted anywhere.
// ------------------------------------------------------
export type ToolExecutionState = "input-streaming" | "input-available" | "output-available" | "output-error";

export type TimelineThought = {
    kind: "thought";
    id: string;
    text: string;
};

// One action's resolved outcome inside a batched HITL interrupt. Index-aligned
// to the interrupt's action_requests order.
export type TimelineHitlActionOutcome = {
    status: "approved" | "rejected";
    reason?: string | null;
};

// Parsed, human-readable view of a LangChain HITL interrupt payload, produced
// by parseHitlInterrupt in runtime/hitl.ts. `raw` always carries the full
// payload; the other fields are best-effort because interrupt shapes vary.
export type ParsedHitlAction = {
    toolName?: string;
    description?: string;
    argsText?: string;
};

export type ParsedHitlRequest = ParsedHitlAction & {
    // Every action_request in the (possibly batched) interrupt, in order. The
    // top-level toolName/description/argsText mirror actions[0] for callers that
    // only need the first (back-compat). requestCount === actions.length.
    actions: ParsedHitlAction[];
    requestCount: number;
    raw: string;
};

export type TimelineHitlApproval = {
    kind: "hitl";
    id: string;
    threadId: string;
    content: unknown;
    status: "pending" | "approved" | "rejected";
    reason?: string | null;
    subagentId?: string;
    // Which action_request this binding represents, when the interrupt gated
    // multiple tool calls in one turn (per-tool approval chips). Undefined for
    // a single-action interrupt.
    actionIndex?: number;
    // Per-action resolved outcomes (set on BRIDGE_HITL_RESOLVED for a batch);
    // index-aligned to action_requests. Drives per-tool chip status.
    decisions?: TimelineHitlActionOutcome[];
};

export type TimelineToolExecution = {
    kind: "tool";
    id: string;
    name: string;
    argsText: string;
    result?: string;
    resultTruncated?: boolean;
    state: ToolExecutionState;
    approval?: TimelineHitlApproval;
    startedAt?: number;
    endedAt?: number;
};

export type ThinkingBlockItem = TimelineThought | TimelineToolExecution | TimelineHitlApproval;

export type ThinkingBlock = {
    kind: "thinking";
    id: string;
    items: ThinkingBlockItem[];
    startedAt?: number;
    endedAt?: number;
};

export type ContentBlock = {
    kind: "content";
    id: string;
    text: string;
};

export type SubagentBlock = {
    kind: "subagent";
    id: string;
    taskId: string;
    type?: string;
    label?: string;
    description?: string;
    prompt?: string;
    namespace?: string;
    blocks: (ThinkingBlock | ContentBlock)[];
};

export type TimelineBlock = ThinkingBlock | ContentBlock | SubagentBlock;

export type TimelineTerminalStatus = "completed" | "cancelled" | "failed";

// Internal reducer bookkeeping. Carried on the timeline so the fold can
// resume incrementally across WS frames; rendering code must not read it.
// Approved HITL tools re-execute under a fresh toolCallId on resume; this
// marks the stalled item the next matching TOOL_CALL_START must merge into.
export type PendingToolRetool = { block: number; item: number; name: string };

export type TimelineFoldIndexes = {
    openThinkingIndex: number | null;
    openContentIndex: number | null;
    subagentIndexByKey: Record<string, number>;
    taskIdRemap: Record<string, string>;
    namespaceToKey: Record<string, string>;
    toolPaths: Record<string, { block: number; item: number }>;
    pendingRetool: PendingToolRetool | null;
    blockCounter: number;
    itemCounter: number;
    subFolds: Record<string, SubagentFoldIndexes>;
};

export type SubagentFoldIndexes = {
    openThinkingIndex: number | null;
    openContentIndex: number | null;
    toolPaths: Record<string, { block: number; item: number }>;
    pendingRetool: PendingToolRetool | null;
};

export type RunTimeline = {
    blocks: TimelineBlock[];
    plan: PlanSnapshot | null;
    interrupts: TimelineHitlApproval[];
    subagentCount: number;
    terminal: boolean;
    terminalStatus?: TimelineTerminalStatus;
    lastSeq: number;
    fold: TimelineFoldIndexes;
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

// ------------------------------------------------------
// Scheduled Tasks — recurring/one-off agent jobs that fire headlessly.
// ------------------------------------------------------
export type ScheduleKind = "one_off" | "interval" | "cron";
export type TaskTargetMode = "fresh" | "bound";
export type ScheduledTaskStatus = "active" | "paused" | "completed" | "failed";

export type ScheduledTask = {
    id: string;
    agentId?: string | null;
    agentName?: string | null;
    agentSlug?: string | null;
    conversationId?: string | null;
    title?: string | null;
    prompt: string;
    enabledTools: ToolPreference[];
    isPrivate: boolean;
    targetMode: TaskTargetMode | string;
    scheduleKind: ScheduleKind | string;
    scheduleSpec: Record<string, any>;
    timezone?: string | null;
    status: ScheduledTaskStatus | string;
    nextRunAt?: Date | null;
    lastRunAt?: Date | null;
    lastRunStatus?: string | null;
    lastRunMessageId?: string | null;
    lastError?: string | null;
    runCount: number;
    maxRuns?: number | null;
    expiresAt?: Date | null;
    createdAt: Date;
    updatedAt: Date;
    // Derived server-side from the latest fire's message — the authoritative live
    // status of the most recent run, and the conversation to open for its result.
    liveStatus?: InferenceRunStatus | string | null;
    lastRunConversationId?: string | null;
};

export type ScheduledTaskCreatePayload = {
    agentId: string;
    prompt: string;
    title?: string;
    targetMode: TaskTargetMode;
    scheduleKind: ScheduleKind;
    runAt?: string;          // ISO-8601 UTC (one_off)
    intervalSeconds?: number; // interval
    cronExpr?: string;        // cron
    timezone?: string;        // IANA tz (cron)
    enabledTools?: ToolPreference[];
    isPrivate?: boolean;
    maxRuns?: number;
    expiresAt?: string;       // ISO-8601 UTC
};

export type ScheduledTaskUpdatePayload = {
    title?: string;
    prompt?: string;
    status?: "active" | "paused";
    enabledTools?: ToolPreference[];
    agentId?: string;
    targetMode?: TaskTargetMode;
    isPrivate?: boolean;
    maxRuns?: number;
    expiresAt?: string;       // ISO-8601 UTC
    scheduleKind?: ScheduleKind;
    runAt?: string;          // ISO-8601 UTC (one_off)
    intervalSeconds?: number; // interval
    cronExpr?: string;        // cron
    timezone?: string;        // IANA tz (cron)
};

// Wire frames from the inference run stream. "snapshot" carries the full
// state (terminal runs: DB-built run+message; in-flight runs: run.rawEvents
// holds the coalesced log so far). "events" carries the new seq-stamped AG-UI
// events of one upstream chunk plus run meta. "update" is client-local only —
// REST responses (cancel/resume) merged through the same code path.
export type InferenceRunEvent = {
    type: "snapshot" | "update" | "terminal" | "events";
    run: InferenceRun;
    message?: MessageOut | null;
    summary?: ConversationSummary | null;
    events?: Record<string, any>[];
};

// Parameters required to download an attachment from the backend
export type DownloadAttachmentParams = {
    userId: string;
    conversationId: string;
    messageId: string;
    blobId: string;
    filename?: string;
};

// `DocxPreviewTokenResponse` is inferred from its Zod schema (see re-export above).



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
