"""Request/response schemas for the dialogue_bridge.

One module per concept/router — auth, catalog, conversations, messages,
attachments, sharing, inference, voice, skills, memories, preferences,
usage, search, scheduled_tasks, agent_tools, user_agents, internal_memory —
on the shared building blocks in ``base``. Re-exported so callers keep the
stable ``from schema import ...`` import surface regardless of which module
a DTO lives in.
"""
from schema.agent_tools import (
    AgentToolRow,
    AgentToolsResponse,
    ToolToggleRequest,
)
from schema.attachments import (
    AttachmentIn,
    AttachmentOut,
    BlobOut,
    DocxPreviewTokenOut,
    ImageOut,
)
from schema.auth import (
    AccountListResponse,
    AccountSummary,
    AuthRequest,
    AuthResponse,
    SwitchAccountRequest,
    UserProfile,
)
from schema.base import (
    Senders,
    UTCDateTime,
)
from schema.catalog import (
    AgentFull,
    AgentPublic,
    ToolManifest,
)
from schema.conversations import (
    ConversationDetail,
    ConversationForkIn,
    ConversationIn,
    ConversationReportIn,
    ConversationSummary,
    ConversationTitleUpdate,
    CreateConversationResponse,
    SuggestionsOut,
    TitleOut,
    UpdateConversationResponse,
)
from schema.inference import (
    InferenceRunOut,
    InferenceRunResumeIn,
    InferenceStartPayload,
    InferenceStartResponse,
    ResumeActionDecisionIn,
)
from schema.internal_memory import (
    MemoryMessageMatch,
    MemorySearchRequest,
)
from schema.memories import (
    MemoryDetail,
    MemoryEntry,
)
from schema.messages import (
    MessageIn,
    MessageOut,
    MessageUpdate,
)
from schema.preferences import (
    CustomInstructions,
    PERSONALITY_IDS,
    UserPreferences,
)
from schema.scheduled_tasks import (
    ScheduleKind,
    ScheduledTaskCreate,
    ScheduledTaskOut,
    ScheduledTaskUpdate,
    TaskStatus,
    TaskTargetMode,
)
from schema.search import (
    WorkspaceSearchResult,
)
from schema.sharing import (
    ConversationPdfExportIn,
    ConversationShareIn,
    ConversationShareListItem,
    ConversationShareResponse,
    SharedConversationDetail,
)
from schema.skills import (
    CustomSkillCreateRequest,
    Skill,
    SkillFile,
    UserSkill,
    UserSkillDetail,
)
from schema.usage import (
    UsageAgentBreakdown,
    UsageDailyPoint,
    UsageSummary,
    UsageWindow,
)
from schema.user_agents import (
    AgentFile,
    CustomAgentDetail,
    CustomAgentValidation,
    CustomAgentWrite,
)
from schema.voice import (
    DictationResponse,
    ReadAloudPreviewRequest,
    RealtimeVoiceConversationEventIn,
    RealtimeVoiceEndIn,
    RealtimeVoiceEndOut,
    RealtimeVoiceSessionIn,
    RealtimeVoiceSessionOut,
)

__all__ = [
    "AccountListResponse",
    "AccountSummary",
    "AgentFile",
    "AgentFull",
    "AgentPublic",
    "AgentToolRow",
    "AgentToolsResponse",
    "AttachmentIn",
    "AttachmentOut",
    "AuthRequest",
    "AuthResponse",
    "BlobOut",
    "ConversationDetail",
    "ConversationForkIn",
    "ConversationIn",
    "ConversationPdfExportIn",
    "ConversationReportIn",
    "ConversationShareIn",
    "ConversationShareListItem",
    "ConversationShareResponse",
    "ConversationSummary",
    "ConversationTitleUpdate",
    "CreateConversationResponse",
    "CustomAgentDetail",
    "CustomAgentValidation",
    "CustomAgentWrite",
    "CustomInstructions",
    "CustomSkillCreateRequest",
    "DictationResponse",
    "DocxPreviewTokenOut",
    "ImageOut",
    "InferenceRunOut",
    "InferenceRunResumeIn",
    "InferenceStartPayload",
    "InferenceStartResponse",
    "MemoryDetail",
    "MemoryEntry",
    "MemoryMessageMatch",
    "MemorySearchRequest",
    "MessageIn",
    "MessageOut",
    "MessageUpdate",
    "PERSONALITY_IDS",
    "ReadAloudPreviewRequest",
    "RealtimeVoiceConversationEventIn",
    "RealtimeVoiceEndIn",
    "RealtimeVoiceEndOut",
    "RealtimeVoiceSessionIn",
    "RealtimeVoiceSessionOut",
    "ResumeActionDecisionIn",
    "ScheduleKind",
    "ScheduledTaskCreate",
    "ScheduledTaskOut",
    "ScheduledTaskUpdate",
    "Senders",
    "SharedConversationDetail",
    "Skill",
    "SkillFile",
    "SuggestionsOut",
    "SwitchAccountRequest",
    "TaskStatus",
    "TaskTargetMode",
    "TitleOut",
    "ToolManifest",
    "ToolToggleRequest",
    "UTCDateTime",
    "UpdateConversationResponse",
    "UsageAgentBreakdown",
    "UsageDailyPoint",
    "UsageSummary",
    "UsageWindow",
    "UserPreferences",
    "UserProfile",
    "UserSkill",
    "UserSkillDetail",
    "WorkspaceSearchResult",
]
