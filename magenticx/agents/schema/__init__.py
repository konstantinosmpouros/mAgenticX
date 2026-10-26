"""Request/response schemas for the agents service.

One module per concept/router — inference, embeddings, generation, voice,
catalog, commands, skills, user_agents, memories, agent_tools, conversation_files. Re-exported so callers
keep the stable ``from schema import ...`` import surface regardless of which
module a DTO lives in.
"""
from schema.account import PurgeThreadsRequest, PurgeThreadsResponse, PurgeUserResponse
from schema.agent_tools import AgentToolRow, AgentToolsResponse
from schema.catalog import AgentDefinition, AgentManifest, AgentModelOption, BuiltinToolInfo, ToolManifest
from schema.commands import CommandListResponse, CommandOut
from schema.conversation_files import (
    CopyConversationFilesRequest,
    CopyConversationFilesResponse,
    OutputFileOut,
    ReadOutputFilesResponse,
    ReapConversationRequest,
)
from schema.embeddings import EmbedRequest, EmbedResponse
from schema.generation import (
    ConversationSuggestions,
    ConversationTitle,
    SuggestionsRequest,
    TitleRequest,
)
from schema.inference import (
    AgentResumeRequest,
    CompactionUsageOut,
    CompactRequest,
    CompactResponse,
    Request,
    ResumeActionDecision,
    UndoCompactionRequest,
    UndoCompactionResponse,
)
from schema.memories import MemoryDetail, MemoryEntry
from schema.skills import (
    CatalogueSearchPage,
    CatalogueSkill,
    CustomSkillCreate,
    RemoteProvenance,
    RemoteSourceStatus,
    SkillFile,
    SkillManifestEntry,
    UserSkillDetail,
)
from schema.user_agents import (
    AgentFile,
    AgentIssue,
    CustomAgentImport,
    CustomAgentImportResult,
    CustomAgentValidation,
    CustomAgentWrite,
    UserAgentDetail,
    UserAgentSummary,
)
from schema.voice import (
    ReadAloudRequest,
    RealtimeSessionRequest,
    RealtimeSessionResponse,
    TranscriptionResponse,
)

__all__ = [
    "CommandListResponse",
    "CommandOut",
    "PurgeThreadsRequest",
    "PurgeThreadsResponse",
    "PurgeUserResponse",
    "AgentDefinition",
    "AgentFile",
    "AgentIssue",
    "AgentModelOption",
    "BuiltinToolInfo",
    "CustomAgentImport",
    "CustomAgentImportResult",
    "AgentManifest",
    "AgentResumeRequest",
    "AgentToolRow",
    "AgentToolsResponse",
    "CatalogueSearchPage",
    "CatalogueSkill",
    "CompactionUsageOut",
    "CompactRequest",
    "CompactResponse",
    "ConversationSuggestions",
    "CopyConversationFilesRequest",
    "CopyConversationFilesResponse",
    "ConversationTitle",
    "CustomAgentValidation",
    "CustomAgentWrite",
    "CustomSkillCreate",
    "EmbedRequest",
    "EmbedResponse",
    "MemoryDetail",
    "MemoryEntry",
    "OutputFileOut",
    "ReadAloudRequest",
    "ReadOutputFilesResponse",
    "RealtimeSessionRequest",
    "RealtimeSessionResponse",
    "ReapConversationRequest",
    "RemoteProvenance",
    "RemoteSourceStatus",
    "Request",
    "ResumeActionDecision",
    "SkillFile",
    "SkillManifestEntry",
    "SuggestionsRequest",
    "TitleRequest",
    "ToolManifest",
    "TranscriptionResponse",
    "UndoCompactionRequest",
    "UndoCompactionResponse",
    "UserAgentDetail",
    "UserAgentSummary",
    "UserSkillDetail",
]
