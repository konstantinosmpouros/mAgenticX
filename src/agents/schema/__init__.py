"""Request/response schemas for the agents service.

One module per concept/router — inference, embeddings, generation, voice,
catalog, skills, user_agents, memories, agent_tools. Re-exported so callers
keep the stable ``from schema import ...`` import surface regardless of which
module a DTO lives in.
"""
from schema.agent_tools import AgentToolRow, AgentToolsResponse, ToolToggleRequest
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
    InputFileIn,
    OutputFileOut,
    ReadOutputFilesResponse,
    ReapConversationRequest,
    Request,
    ResumeActionDecision,
    SeedInputFilesRequest,
    SeedInputFilesResponse,
)
from schema.memories import MemoryDetail, MemoryEntry
from schema.skills import (
    CustomSkillCreate,
    GlobalManifest,
    SkillFile,
    SkillManifest,
    SkillManifestEntry,
    UserManifest,
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
    "AgentDefinition",
    "AgentFile",
    "AgentManifest",
    "AgentResumeRequest",
    "AgentToolRow",
    "AgentToolsResponse",
    "ConversationSuggestions",
    "ConversationTitle",
    "CustomAgentValidation",
    "CustomAgentWrite",
    "CustomSkillCreate",
    "EmbedRequest",
    "EmbedResponse",
    "GlobalManifest",
    "InputFileIn",
    "MemoryDetail",
    "MemoryEntry",
    "OutputFileOut",
    "ReadAloudRequest",
    "ReadOutputFilesResponse",
    "ReapConversationRequest",
    "RealtimeSessionRequest",
    "RealtimeSessionResponse",
    "Request",
    "ResumeActionDecision",
    "SeedInputFilesRequest",
    "SeedInputFilesResponse",
    "SkillFile",
    "SkillManifest",
    "SkillManifestEntry",
    "SuggestionsRequest",
    "TitleRequest",
    "ToolManifest",
    "ToolToggleRequest",
    "TranscriptionResponse",
    "UserAgentDetail",
    "UserAgentSummary",
    "UserManifest",
    "UserSkillDetail",
]
