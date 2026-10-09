"""Request/response schemas for the agents service.

One module per concept/router — inference, embeddings, generation, voice,
catalog, skills, user_agents, memories, agent_tools. Re-exported so callers
keep the stable ``from schema import ...`` import surface regardless of which
module a DTO lives in.
"""
from schema.account import PurgeThreadsRequest, PurgeThreadsResponse, PurgeUserResponse
from schema.agent_tools import AgentToolRow, AgentToolsResponse
from schema.catalog import AgentDefinition, AgentManifest, ToolManifest
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
    InputFileIn,
    OutputFileOut,
    ReadOutputFilesResponse,
    ReapConversationRequest,
    Request,
    ResumeActionDecision,
    SeedInputFilesRequest,
    SeedInputFilesResponse,
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
    "PurgeThreadsRequest",
    "PurgeThreadsResponse",
    "PurgeUserResponse",
    "AgentDefinition",
    "AgentFile",
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
    "ConversationTitle",
    "CustomAgentValidation",
    "CustomAgentWrite",
    "CustomSkillCreate",
    "EmbedRequest",
    "EmbedResponse",
    "InputFileIn",
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
    "SeedInputFilesRequest",
    "SeedInputFilesResponse",
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
