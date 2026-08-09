from pydantic import BaseModel, Field, ConfigDict, model_validator, AliasChoices, field_validator, computed_field, PlainSerializer
import base64
from typing import Annotated, Any, List, Optional, Literal
from datetime import datetime, timezone

from core.settings import settings

Senders = Literal["user", "ai"]


def _serialize_utc(value: datetime) -> str:
    """Serialize a datetime as UTC ISO-8601 with a ``Z`` suffix.

    Stored timestamps are naive UTC (Postgres ``Etc/UTC`` + naive ``DateTime``
    columns). Without an explicit offset the browser's ``new Date(...)`` parses
    them as *local* time and renders them unconverted; stamping UTC lets the
    client show each timestamp in the viewing user's own timezone.
    """
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


UTCDateTime = Annotated[datetime, PlainSerializer(_serialize_utc, return_type=str, when_used="json")]


#-------------------------------------------
# AUTHENTICATE USER DTO
#-------------------------------------------
class AuthRequest(BaseModel):
    """Schema for user authentication request."""
    username: str
    password: str

class UserProfile(BaseModel):
    """Public user profile returned to the client after authentication."""
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: str
    username: str
    email: Optional[str] = None
    displayName: Optional[str] = Field(None, validation_alias="display_name")
    fullName: Optional[str] = Field(None, validation_alias="full_name")
    avatarUrl: Optional[str] = Field(None, validation_alias="avatar_url")
    department: Optional[str] = None
    roleTitle: Optional[str] = Field(None, validation_alias="role_title")
    lastLoginAt: Optional[UTCDateTime] = Field(None, validation_alias="last_login_at")
    isActive: bool = Field(..., validation_alias="is_active")
    createdAt: UTCDateTime = Field(..., validation_alias="created_at")
    updatedAt: UTCDateTime = Field(..., validation_alias="updated_at")

class AuthResponse(BaseModel):
    """Schema for user authentication response."""
    authenticated: bool = False
    user_id: str | None = None
    user: UserProfile | None = None
    tokenTtl: Optional[int] = None



# -------------------------------------------
# DICTATION DTO
# -------------------------------------------
class DictationResponse(BaseModel):
    """Speech-to-text transcription payload returned to the UI."""
    text: str


#-------------------------------------------
# AGENTS DTO
#-------------------------------------------
class AgentFull(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: str
    slug: str
    name: str
    description: str
    icon: str
    version: Optional[str] = None
    type: str = "langgraph agent"
    is_active: bool
    created_at: UTCDateTime
    updated_at: UTCDateTime

class AgentPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: str
    name: str
    description: str
    icon: str
    version: Optional[str] = None
    type: str = "langgraph agent"
    isActive: bool = Field(..., validation_alias="is_active")


class WorkspaceSearchResult(BaseModel):
    """Flat search result consumed by the sidebar search panel."""
    kind: Literal["conversation", "message", "file", "agent"]
    id: str
    conversationId: Optional[str] = None
    agentId: Optional[str] = None
    title: str
    subtitle: Optional[str] = None
    snippet: Optional[str] = None
    updatedAt: Optional[UTCDateTime] = None


class MemorySearchRequest(BaseModel):
    """Internal (agents → bridge) request: semantic search over a user's past
    messages, backing the agent's `search_past_conversations` tool. `user_id`
    is trusted because only internal callers (the agents service, with the
    proxy secret) can reach this endpoint."""
    user_id: str
    query: str
    limit: int = 5
    # The current conversation, excluded so the tool surfaces *other* (old)
    # conversations the agent doesn't already have in context.
    exclude_conversation_id: Optional[str] = None


class MemoryMessageMatch(BaseModel):
    """One past message returned to the agent's memory-search tool.

    ``createdAt``/``updatedAt`` are the matched **message's** timestamps."""
    messageId: str
    conversationId: str
    conversationTitle: str
    sender: Literal["user", "ai"]
    content: str
    score: float
    createdAt: Optional[UTCDateTime] = None
    updatedAt: Optional[UTCDateTime] = None



# -------------------------------------------
# MCP TOOLS DTO
# -------------------------------------------
class ToolManifest(BaseModel):
    server_id: str = Field("", validation_alias="server_id")
    tool_name: str = Field(..., validation_alias="tool_name")
    description: str = ""
    parameter_count: int = Field(0, ge=0, validation_alias="parameter_count")


class Skill(BaseModel):
    """One entry in the global skills catalog.

    Mirrors :class:`agents.schemas.SkillManifest`. ``category`` is the
    parent folder under the global registry root, surfaced as a small label
    next to the skill name in the UI.
    """

    name: str
    description: str = ""
    content: str = ""
    category: str = ""


class UserSkill(BaseModel):
    """One entry in a user's personal skill pool (manifest row, no content).

    Mirrors :class:`agents.schemas.SkillManifestEntry`. ``type`` distinguishes
    references to globals (``"global"``) from user-owned custom skills
    (``"custom"``). ``category`` is the parent folder in the global
    hierarchy — empty string for custom skills.
    """

    name: str
    type: Literal["global", "custom"]
    description: str = ""
    source_path: str
    category: str = ""


class SkillFile(BaseModel):
    """One file inside a skill folder.

    ``path`` is relative to the skill root (``/``-separated); ``content`` is
    UTF-8 text or base64 per ``encoding``. ``size`` is the decoded byte length
    (populated on read, ignored on create). Mirrors :class:`agents.schemas.SkillFile`.
    """

    path: str
    content: str = ""
    encoding: Literal["utf-8", "base64"] = "utf-8"
    size: int = 0


class UserSkillDetail(BaseModel):
    """A user-pool entry joined with its file inventory — returned by
    ``GET /v1/users/{user_id}/skills/{name}``.

    ``content`` is the parsed SKILL.md body (quick preview); ``files`` is the
    full on-disk inventory."""

    name: str
    type: Literal["global", "custom"]
    description: str = ""
    source_path: str
    category: str = ""
    content: str = ""
    files: List[SkillFile] = Field(default_factory=list)


class MemoryEntry(BaseModel):
    """One saved memory's metadata (no body) — a row in the Memory inspector.

    Mirrors :class:`agents.schemas.MemoryEntry`. ``source_conversation_id`` is
    the provenance pointer (the conversation the memory was saved from).
    """

    name: str
    summary: str = ""
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    source_conversation_id: Optional[str] = None


class MemoryDetail(MemoryEntry):
    """A saved memory with its full ``content`` — the inspector's click-to-preview."""

    content: str = ""


class CustomSkillCreateRequest(BaseModel):
    """Request body for ``POST /v1/users/{user_id}/skills/custom``.

    A custom skill is a folder of files; one must be ``SKILL.md``. The list is
    bounded here as cheap DoS protection — the agents service enforces the
    authoritative per-file/total byte caps when it decodes and writes."""

    name: str
    description: str = ""
    files: List[SkillFile] = Field(default_factory=list, max_length=30)



# -------------------------------------------
# User preferences DTO
# -------------------------------------------
class ToolPreference(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    server_id: str = Field(
        "",
        validation_alias=AliasChoices("server_id", "serverId"),
        serialization_alias="serverId",
    )
    tool_name: str = Field(
        ...,
        validation_alias=AliasChoices("tool_name", "toolName"),
        serialization_alias="toolName",
    )

    @field_validator("server_id", "tool_name", mode="before")
    @classmethod
    def _coerce_and_strip(cls, v: str) -> str:
        if v is None:
            return ""
        if not isinstance(v, str):
            v = str(v)
        return v.strip()


class ToolsPreferences(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    disabled: list[ToolPreference] = Field(default_factory=list)

    @model_validator(mode="after")
    def _dedupe_disabled(self) -> "ToolsPreferences":
        """Normalize and deduplicate the disabled list by server/tool key."""
        cleaned: list[ToolPreference] = []
        seen: set[str] = set()

        for entry in self.disabled or []:
            tool_name = (entry.tool_name or "").strip()
            server_id = (entry.server_id or "").strip()
            if not tool_name:
                continue
            key = f"{server_id}::{tool_name}"
            if key in seen:
                continue
            seen.add(key)
            cleaned.append(
                ToolPreference(
                    server_id=server_id,
                    tool_name=tool_name,
                )
            )

        self.disabled = cleaned
        return self


# -------------------------------------------
# Per-agent tools DTOs (Agents tab) — proxied from the agents service, which
# already emits camelCase, so these mirror that shape 1:1.
# -------------------------------------------
class AgentToolRow(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    key: str
    name: str
    description: str = ""
    source: str  # "native" | "mcp"
    disabled: bool


class AgentToolsResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    agentSlug: str
    tools: list[AgentToolRow] = Field(default_factory=list)


class ToolToggleRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    toolKey: str
    disabled: bool


# Personality presets recognised by the agents service (its registry lives in
# agents `runtime/personalization.py`). Kept in lockstep manually; the agents
# side is fail-closed, so an id it doesn't know collapses to "default" there
# instead of erroring — drift degrades gracefully.
PERSONALITY_IDS = frozenset(
    {"default", "professional", "friendly", "candid", "quirky", "efficient", "cynical", "nerdy"}
)


class CustomInstructions(BaseModel):
    """User-authored custom instructions (Settings → Personalization).

    Injected into deep-agent system prompts while ``enabled`` is true. Length
    caps mirror the agents-side re-validation (defense in depth); control
    characters are stripped here so the stored document is already clean.
    """
    model_config = ConfigDict(populate_by_name=True)

    enabled: bool = False
    nickname: str = Field(default="", max_length=100)
    occupation: str = Field(default="", max_length=150)
    traits: str = Field(default="", max_length=1500)
    about: str = Field(default="", max_length=1500)

    @field_validator("nickname", "occupation", "traits", "about", mode="before")
    @classmethod
    def _sanitize_text(cls, value: Any) -> str:
        """Coerce to a clean string: drop control chars (newlines/tabs survive —
        the long fields are legitimately multi-line) and trim edges. Length is
        enforced by the field caps afterwards, rejecting oversize payloads."""
        if not isinstance(value, str):
            return ""
        return "".join(ch for ch in value if ch in "\n\t" or ord(ch) >= 32).strip()


class UserPreferences(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    tools: ToolsPreferences = Field(default_factory=ToolsPreferences)
    prefersAgenticChat: bool = Field(
        default=False,
        validation_alias=AliasChoices("prefers_agentic_chat", "prefersAgenticChat"),
        serialization_alias="prefersAgenticChat",
    )
    suggestionsEnabled: bool = Field(
        default=True,
        validation_alias=AliasChoices("suggestions_enabled", "suggestionsEnabled"),
        serialization_alias="suggestionsEnabled",
    )
    showMessageTokenUsage: bool = Field(
        default=False,
        validation_alias=AliasChoices("show_message_token_usage", "showMessageTokenUsage"),
        serialization_alias="showMessageTokenUsage",
    )
    searchPastConvs: bool = Field(
        default=False,
        validation_alias=AliasChoices("search_past_convs", "searchPastConvs"),
        serialization_alias="searchPastConvs",
    )
    useMemory: bool = Field(
        default=True,
        validation_alias=AliasChoices("use_memory", "useMemory"),
        serialization_alias="useMemory",
    )
    personality: str = Field(default="default")
    customInstructions: CustomInstructions = Field(
        default_factory=CustomInstructions,
        validation_alias=AliasChoices("custom_instructions", "customInstructions"),
        serialization_alias="customInstructions",
    )
    voiceModeVoice: str = Field(
        default="alloy",
        validation_alias=AliasChoices("voice_mode_voice", "voiceModeVoice"),
        serialization_alias="voiceModeVoice",
    )
    voiceModeLanguage: str = Field(
        default="english",
        validation_alias=AliasChoices("voice_mode_language", "voiceModeLanguage"),
        serialization_alias="voiceModeLanguage",
    )

    @field_validator("personality", mode="before")
    @classmethod
    def _normalize_personality(cls, value: Any) -> str:
        """Fail-closed preset validation: anything outside the registry —
        malformed input or a preset removed in a newer deploy — collapses to
        "default" (same stance as voice normalization) instead of erroring."""
        candidate = value.strip().lower() if isinstance(value, str) else ""
        return candidate if candidate in PERSONALITY_IDS else "default"


class ReadAloudPreviewRequest(BaseModel):
    """Payload for previewing a read-aloud voice from profile settings."""
    voice: str = Field(default="alloy", min_length=1)
    text: str = Field(default="Hey! I am your AI speaker.", min_length=1, max_length=120)



#-------------------------------------------
# USAGE SUMMARY DTO (Settings → Usage tab)
#-------------------------------------------
class UsageWindow(BaseModel):
    """Token/message aggregates over one time window (or all time)."""
    inputTokens: int = 0
    outputTokens: int = 0
    totalTokens: int = 0
    aiMessages: int = 0


class UsageAgentBreakdown(UsageWindow):
    """One agent's share of the user's usage (keyed by denormalized name)."""
    agentName: str


class UsageDailyPoint(UsageWindow):
    """One UTC day of usage for the activity chart. `date` is YYYY-MM-DD."""
    date: str


class UsageSummary(BaseModel):
    """Workspace-wide usage rollup for one user: all-time totals, recency
    windows, a capped per-agent ranking, and a sparse 30-day daily series
    (days with no activity are omitted; the client fills the gaps)."""
    totals: UsageWindow
    conversations: int = 0
    today: UsageWindow
    last7Days: UsageWindow
    last30Days: UsageWindow
    perAgent: List[UsageAgentBreakdown] = Field(default_factory=list)
    daily: List[UsageDailyPoint] = Field(default_factory=list)



#-------------------------------------------
# CONVERSATION EXPORT DTO
#-------------------------------------------
class ConversationSummary(BaseModel):
    """
    Conversation DTO with partial info of a conversation.
    Used for export and presentation in the UI sidebar (conversation history).
    """
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: str
    agent: AgentPublic = Field(..., validation_alias="agent")
    forkedParentId: Optional[str] = Field(None, validation_alias="forked_parent_id")
    forkedMessageId: Optional[str] = Field(None, validation_alias="forked_message_id")
    title: Optional[str] = Field(None, validation_alias="title")
    isPrivate: bool = Field(..., validation_alias="is_private")
    isArchived: bool = Field(False, validation_alias="is_archived")
    archivedAt: Optional[UTCDateTime] = Field(None, validation_alias="archived_at")
    isReported: bool = Field(False, validation_alias="is_reported")
    reportedAt: Optional[UTCDateTime] = Field(None, validation_alias="reported_at")
    activeRunId: Optional[str] = Field(None, validation_alias="active_assistant_message_id")
    lastMessage: Optional[str] = Field(None, validation_alias="last_message_preview")
    created_at: UTCDateTime = Field(..., validation_alias="created_at")
    updated_at: UTCDateTime = Field(..., validation_alias="updated_at")

    @computed_field
    @property
    def isStreaming(self) -> bool:
        return bool(self.activeRunId)

class BlobOut(BaseModel):
    """Schema to expose a Blob"""
    model_config = ConfigDict(from_attributes=True)
    data: bytes  # Pydantic v2 will base64 this if ever serialized, but we won't expose it directly.

class AttachmentOut(BaseModel):
    """Schema to expose all the info for an Attachment"""
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: str
    name: str = Field(..., validation_alias="file_name")
    mime: str = Field(..., validation_alias="mime_type")
    size: Optional[int] = Field(None, validation_alias="size_bytes")
    timestamp: UTCDateTime = Field(..., validation_alias="created_at")
    # Provenance + agent-supplied display metadata. "upload" (default) for
    # user-attached files, "generated" for a present_artifact deliverable;
    # title/summary are populated for generated artifacts only.
    origin: str = Field("upload", validation_alias="origin")
    title: Optional[str] = Field(None, validation_alias="title")
    summary: Optional[str] = Field(None, validation_alias="summary")

    # keep ORM relation for computation but don't serialize it
    blob: Optional[BlobOut] = Field(None, validation_alias="blob", exclude=True)
    blobId: Optional[str] = Field(None, validation_alias="blob_id")

    # Only for the raw base64 data (image)
    data: Optional[str] = None

    @model_validator(mode="after")
    def _inject_image_b64(self):
        if self.mime and self.mime.startswith("image/") and self.blob and self.blob.data:
            self.data = base64.b64encode(self.blob.data).decode("ascii")
            self.blob = None
        return self

class MessageOut(BaseModel):
    """Schema to expose all the info for a Message"""
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: str
    parentMessageId: Optional[str] = Field(None, validation_alias="parent_message_id")
    content: Optional[str] = None
    sender: Senders
    liked: Optional[bool] = Field(None, validation_alias="liked")
    agentId: Optional[str] = Field(None, validation_alias="agent_id")
    agentName: Optional[str] = Field(None, validation_alias="agent_name")
    created_at: UTCDateTime = Field(..., validation_alias="created_at")
    updated_at: UTCDateTime = Field(..., validation_alias="updated_at")
    attachments: List[AttachmentOut] = Field(default_factory=list)
    thinking: Optional[List[str]] = Field(None, validation_alias="reasoning_steps")
    thinkingTime: Optional[int] = Field(None, validation_alias="reasoning_time_seconds")
    inputTokens: Optional[int] = Field(None, validation_alias="input_tokens")
    outputTokens: Optional[int] = Field(None, validation_alias="output_tokens")
    error: Optional[bool] = Field(None, validation_alias="is_error")
    errorMessage: Optional[str] = Field(None, validation_alias="error_message")
    # Final run lifecycle status of an assistant message (completed/cancelled/
    # failed) — the client's Done sentinel renders its flavor from this.
    streamingStatus: Optional[str] = Field(None, validation_alias="streaming_status")
    rawEvents: List[dict] = Field(default_factory=list, validation_alias="raw_events")

    @field_validator("rawEvents", mode="before")
    @classmethod
    def _coerce_raw_events(cls, v):
        return v if v is not None else []

class ConversationDetail(BaseModel):
    """
    Conversation DTO with all the info of a conversation.
    Used for export and presentation in the UI.
    """
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: str
    agent: AgentPublic = Field(..., validation_alias="agent")
    forkedParentId: Optional[str] = Field(None, validation_alias="forked_parent_id")
    forkedMessageId: Optional[str] = Field(None, validation_alias="forked_message_id")
    title: Optional[str] = Field(None, validation_alias="title")
    isPrivate: bool = Field(..., validation_alias="is_private")
    isArchived: bool = Field(False, validation_alias="is_archived")
    archivedAt: Optional[UTCDateTime] = Field(None, validation_alias="archived_at")
    isReported: bool = Field(False, validation_alias="is_reported")
    reportedAt: Optional[UTCDateTime] = Field(None, validation_alias="reported_at")
    activeRunId: Optional[str] = Field(None, validation_alias="active_assistant_message_id")
    created_at: UTCDateTime = Field(..., validation_alias="created_at")
    updated_at: UTCDateTime = Field(..., validation_alias="updated_at")
    messages: List[MessageOut] = Field(default_factory=list)

    @computed_field
    @property
    def isStreaming(self) -> bool:
        return bool(self.activeRunId)



#-------------------------------------------
# CONVERSATION CREATE DTO
#-------------------------------------------
class AttachmentIn(BaseModel):
    """
    For uploads: we accept base64 payloads.
    Only images will ever be sent back base64-encoded by the API.
    """
    name: str
    mime: str
    dataB64: str
    size: Optional[int] = None  # if missing, will be computed from decoded bytes

    @field_validator("name", "mime", "dataB64", mode="before")
    @classmethod
    def _strip_attachment_fields(cls, value):
        if isinstance(value, str):
            return value.strip()
        return value

    @model_validator(mode="after")
    def _validate_attachment(self):
        # Basic presence checks
        if not self.name:
            raise ValueError("Attachment name is required.")
        if not self.mime:
            raise ValueError(f"Attachment '{self.name}' is missing a MIME type.")
        if not self.dataB64:
            raise ValueError(f"Attachment '{self.name}' is missing data.")

        # Validate base64 and decode to get raw bytes for size validation and potential re-encoding (for images).
        try:
            raw = base64.b64decode(self.dataB64, validate=True)
        except Exception as exc:
            raise ValueError(f"Attachment '{self.name}' is not valid base64.") from exc

        # Validate size constraints
        raw_size = len(raw)
        if raw_size <= 0:
            raise ValueError(f"Attachment '{self.name}' is empty.")
        if raw_size > settings.attachments.max_size_bytes:
            raise ValueError(f"Attachment '{self.name}' exceeds the {settings.attachments.max_size_bytes // (1024 * 1024)} MB limit.")
        if self.size is not None and self.size != raw_size:
            raise ValueError(f"Attachment '{self.name}' size metadata does not match payload size.")

        self.size = raw_size
        return self

class MessageIn(BaseModel):
    """
    Create a message (user/agent) with optional attachments.
    Either content or attachments must be provided.
    """
    parentMessageId: Optional[str] = None
    sender: Senders
    content: Optional[str] = None
    attachments: List[AttachmentIn] = Field(default_factory=list)

    # Optional metadata (your schema already supports on MessageTable)
    thinking: Optional[List[str]] = None
    thinkingTime: Optional[int] = None
    error: Optional[bool] = None
    errorMessage: Optional[str] = None
    rawEvents: List[dict] = Field(default_factory=list)

    @model_validator(mode="after")
    def _require_content_or_attachment(self):
        # Allow empty AI placeholders so the UI can allocate an id before streaming.
        if self.sender == "ai" and not self.content and not self.attachments:
            return self
        if not self.content and not self.attachments:
            raise ValueError("Either 'content' or at least one attachment is required.")
        if len(self.attachments) > settings.attachments.max_per_message:
            raise ValueError(f"No more than {settings.attachments.max_per_message} attachments are allowed per message.")
        total_bytes = sum(item.size or 0 for item in self.attachments)
        if total_bytes > settings.attachments.max_total_bytes:
            raise ValueError(
                f"Total attachment payload exceeds the {settings.attachments.max_total_bytes // (1024 * 1024)} MB limit."
            )
        return self

class ConversationIn(BaseModel):
    """Create a conversation and persist the very first message."""
    agentId: str = Field(..., description="Target agent id")
    isPrivate: bool = Field(False, description="Optional privacy flag")
    title: Optional[str] = Field(None, description="Optional custom title")
    firstMessage: MessageIn

class ConversationForkIn(BaseModel):
    """Fork a conversation branch ending at a selected AI message."""
    messageId: str

class ConversationShareIn(BaseModel):
    """Create a read-only share snapshot ending at a selected AI message."""
    messageId: str
    mode: Literal["full", "branch", "message"] = "branch"
    branchPath: Optional[list[str]] = None
    expiresAt: Optional[UTCDateTime] = None

    @field_validator("branchPath", mode="before")
    @classmethod
    def _normalize_branch_path(cls, value):
        if value is None:
            return None
        if not isinstance(value, list):
            return None
        normalized = [str(item).strip() for item in value if str(item).strip()]
        return normalized or None

    @model_validator(mode="after")
    def _validate_expiration(self):
        if self.expiresAt is None:
            return self
        expires_at = self.expiresAt.replace(tzinfo=None)
        if expires_at <= datetime.utcnow():
            raise ValueError("Share expiration must be in the future.")
        self.expiresAt = expires_at
        return self

class ConversationPdfExportIn(BaseModel):
    """Export a conversation scope as a transient PDF attachment."""
    messageId: str
    mode: Literal["full", "branch", "message"] = "full"
    branchPath: Optional[list[str]] = None

    @field_validator("branchPath", mode="before")
    @classmethod
    def _normalize_branch_path(cls, value):
        if value is None:
            return None
        if not isinstance(value, list):
            return None
        normalized = [str(item).strip() for item in value if str(item).strip()]
        return normalized or None

class ConversationShareResponse(BaseModel):
    """Owner response for a created share link."""
    id: str
    token: str
    shareUrl: str
    conversationId: str
    messageId: str
    shareMode: Literal["full", "branch", "message"] = "branch"
    title: Optional[str] = None
    isActive: bool = True
    revokedAt: Optional[UTCDateTime] = None
    expiresAt: Optional[UTCDateTime] = None
    createdAt: UTCDateTime

class ConversationShareListItem(BaseModel):
    """Owner-facing shared conversation link record."""
    id: str
    token: str
    shareUrl: str
    conversationId: str
    messageId: Optional[str] = None
    shareMode: Literal["full", "branch", "message"] = "branch"
    title: Optional[str] = None
    isActive: bool
    status: Literal["active", "expired", "revoked"]
    revokedAt: Optional[UTCDateTime] = None
    expiresAt: Optional[UTCDateTime] = None
    createdAt: UTCDateTime

class SharedConversationDetail(BaseModel):
    """Public read-only shared conversation snapshot."""
    token: str
    title: Optional[str] = None
    shareMode: Literal["full", "branch", "message"] = "branch"
    agent: AgentPublic
    messages: List[MessageOut] = Field(default_factory=list)
    expiresAt: Optional[UTCDateTime] = None
    createdAt: UTCDateTime

class CreateConversationResponse(BaseModel):
    """Response when creating a conversation: summary + full detail."""
    detail: ConversationDetail
    summary: ConversationSummary


class RealtimeVoiceSessionIn(BaseModel):
    """Browser SDP offer plus conversation context for a realtime voice session."""
    agentId: str
    conversationId: Optional[str] = None
    sdp: str = Field(..., min_length=1)
    voice: Optional[str] = None
    language: Optional[str] = None


class RealtimeVoiceSessionOut(BaseModel):
    """SDP answer and conversation context for a realtime voice session."""
    sdp: str
    model: str
    voice: str


class RealtimeVoiceConversationEventIn(BaseModel):
    """Persist a completed realtime voice transcript turn into the conversation."""
    conversationId: str
    role: Literal["user", "assistant"]
    transcript: str = Field(..., min_length=1)
    itemId: Optional[str] = None
    responseId: Optional[str] = None
    rawEvent: Optional[dict] = None


class RealtimeVoiceEndIn(BaseModel):
    conversationId: str


class RealtimeVoiceEndOut(BaseModel):
    summary: ConversationSummary



#-------------------------------------------
# INFERENCE RUN DTO
#-------------------------------------------
class InferenceStartPayload(BaseModel):
    """Backend-owned inference start request for new/send/edit/retry flows."""
    mode: Literal["new", "send", "edit", "retry", "shared_continue"]
    agentId: Optional[str] = None
    isPrivate: bool = False
    title: Optional[str] = None
    sharedConversationToken: Optional[str] = None
    conversationId: Optional[str] = None
    parentMessageId: Optional[str] = None
    targetMessageId: Optional[str] = None
    messagePath: list[str] | None = None
    enabledTools: list[ToolPreference] | None = Field(default=None, validation_alias="enabledTools")
    message: Optional[MessageIn] = None


class InferenceRunOut(BaseModel):
    """Backend-owned inference run visible to the frontend run manager.

    After the inference_runs-table collapse this is built explicitly by
    :func:`utils.inference_runs.build_run_out_from_message` from a
    :class:`MessageTable` row — there is no longer a separate ORM model to
    validate from. ``id`` and ``assistantMessageId`` are both the message ID.
    """
    model_config = ConfigDict(populate_by_name=True)

    id: str
    userId: str
    conversationId: str
    assistantMessageId: str
    parentMessageId: Optional[str] = None
    status: str
    scheduledTaskId: Optional[str] = None
    messagePath: list[str] = Field(default_factory=list)
    enabledTools: list[dict] = Field(default_factory=list)
    content: Optional[str] = None
    thinking: Optional[list[str]] = None
    rawEvents: list[dict] = Field(default_factory=list)
    inputTokens: Optional[int] = None
    outputTokens: Optional[int] = None
    errorMessage: Optional[str] = None
    startedAt: UTCDateTime
    completedAt: Optional[UTCDateTime] = None
    cancelRequestedAt: Optional[UTCDateTime] = None
    updatedAt: UTCDateTime

    @field_validator("messagePath", "enabledTools", "rawEvents", mode="before")
    @classmethod
    def _coerce_json_lists(cls, value):
        return value if isinstance(value, list) else []


class InferenceStartResponse(BaseModel):
    detail: ConversationDetail
    summary: ConversationSummary
    run: InferenceRunOut
    message: MessageOut


class ResumeActionDecisionIn(BaseModel):
    """One approve/reject decision for a single gated tool call in a batched
    HITL interrupt. Index-aligned to the interrupt's ``action_requests`` order;
    forwarded verbatim to the agents ``/resume`` endpoint."""
    decision: Literal["approve", "reject"]
    reason: Optional[str] = None


class InferenceRunResumeIn(BaseModel):
    """Frontend → bridge payload for resuming a HITL-paused inference run.

    The bridge forwards this to the agents service's ``/resume`` endpoint
    which constructs a ``Command(resume=...)`` against the saved checkpoint.
    ``threadId`` is informational — the bridge always uses the conversation
    id as the LangGraph thread, so the field is accepted for symmetry with
    the agents-service shape but not relied upon.

    ``decisions`` is the per-action list for a *batched* interrupt (multiple
    gated tool calls in one turn): one entry per ``action_request`` in order,
    so the user can approve some and reject others. When omitted the single
    ``decision`` is replicated across all hanging tool calls (single-action /
    legacy path).

    ``interruptId`` is the LangGraph interrupt's unique id from the
    ``HITL_INTERRUPT`` event the user acted on; the agents service uses it
    to verify the request resolves the right pending interrupt when multiple
    HITLs fire in sequence on the same conversation.
    """
    model_config = ConfigDict(populate_by_name=True)

    interruptId: Optional[str] = None
    threadId: Optional[str] = None
    decision: Literal["approve", "reject"]
    reason: Optional[str] = None
    value: Optional[Any] = None
    decisions: Optional[List[ResumeActionDecisionIn]] = None


#-------------------------------------------
# SCHEDULED TASKS DTO
#-------------------------------------------
ScheduleKind = Literal["one_off", "interval", "cron"]
TaskTargetMode = Literal["fresh", "bound"]
TaskStatus = Literal["active", "paused", "completed", "failed"]


def _to_naive_utc(value: datetime) -> datetime:
    """Normalize an inbound datetime to naive-UTC (the storage convention).

    Offset-aware input is converted to UTC then stripped; naive input is assumed
    to already be UTC (the client sends UTC ISO strings).
    """
    if value.tzinfo is not None:
        return value.astimezone(timezone.utc).replace(tzinfo=None)
    return value


def _validate_timezone(tz: str) -> None:
    """Reject an unknown IANA tz. Lenient where the tz database is unavailable
    (e.g. a bare Windows host with no ``tzdata``) so validation never depends on
    the host's zoneinfo — prod/containers carry ``tzdata`` and reject bad zones."""
    try:
        from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
    except ImportError:
        return
    try:
        ZoneInfo(tz)
    except ZoneInfoNotFoundError as exc:
        raise ValueError(f"Unknown timezone: {tz!r}.") from exc
    except Exception:
        return


def _validate_cron(expr: str) -> None:
    try:
        from croniter import croniter
    except ImportError:
        return
    if not croniter.is_valid(expr):
        raise ValueError(f"Invalid cron expression: {expr!r}.")


def _normalize_schedule(
    kind: ScheduleKind,
    run_at: Optional[datetime],
    interval_seconds: Optional[int],
    cron_expr: Optional[str],
    timezone_value: Optional[str],
    *,
    now: datetime,
) -> tuple[Optional[datetime], Optional[str], Optional[str]]:
    """Validate + normalize the per-kind schedule fields, returning the cleaned
    (run_at, cron_expr, timezone). Shared by create and edit so both enforce the
    same rules (future runAt, min interval, valid cron/tz)."""
    if kind == "one_off":
        if run_at is None:
            raise ValueError("runAt is required for a one_off task.")
        run_at = _to_naive_utc(run_at)
        if run_at <= now:
            raise ValueError("runAt must be in the future.")
    elif kind == "interval":
        if interval_seconds is None:
            raise ValueError("intervalSeconds is required for an interval task.")
        if interval_seconds < settings.scheduler.min_interval_seconds:
            raise ValueError(f"intervalSeconds must be at least {settings.scheduler.min_interval_seconds}.")
    else:  # cron
        if not (cron_expr or "").strip():
            raise ValueError("cronExpr is required for a cron task.")
        cron_expr = cron_expr.strip()
        _validate_cron(cron_expr)
        if timezone_value:
            timezone_value = timezone_value.strip()
            _validate_timezone(timezone_value)
        else:
            timezone_value = "UTC"
    return run_at, cron_expr, timezone_value


class ScheduledTaskCreate(BaseModel):
    """Create a scheduled task. Exactly one schedule field must match the kind:
    ``one_off`` → ``runAt``; ``interval`` → ``intervalSeconds``; ``cron`` → ``cronExpr``."""
    agentId: str
    prompt: str
    title: Optional[str] = None
    targetMode: TaskTargetMode = "fresh"
    scheduleKind: ScheduleKind
    runAt: Optional[datetime] = None
    intervalSeconds: Optional[int] = None
    cronExpr: Optional[str] = None
    timezone: Optional[str] = None
    enabledTools: Optional[List[ToolPreference]] = None
    isPrivate: bool = False
    maxRuns: Optional[int] = Field(None, ge=1)
    expiresAt: Optional[datetime] = None

    @model_validator(mode="after")
    def _validate(self) -> "ScheduledTaskCreate":
        self.prompt = (self.prompt or "").strip()
        if not self.prompt:
            raise ValueError("prompt is required.")
        if len(self.prompt) > 8000:
            raise ValueError("prompt must be 8000 characters or fewer.")
        if self.title is not None:
            self.title = self.title.strip()[:200] or None
        if not (self.agentId or "").strip():
            raise ValueError("agentId is required.")
        self.agentId = self.agentId.strip()

        now = datetime.now(timezone.utc).replace(tzinfo=None)
        self.runAt, self.cronExpr, self.timezone = _normalize_schedule(
            self.scheduleKind, self.runAt, self.intervalSeconds, self.cronExpr, self.timezone, now=now
        )

        if self.expiresAt is not None:
            self.expiresAt = _to_naive_utc(self.expiresAt)
            if self.expiresAt <= now:
                raise ValueError("expiresAt must be in the future.")
        return self


class ScheduledTaskUpdate(BaseModel):
    """Partial update — any field may be omitted to leave it unchanged. Pause/resume
    is via ``status``. To change the cadence, send ``scheduleKind`` plus its matching
    field (``runAt``/``intervalSeconds``/``cronExpr``); the util recomputes ``next_run_at``."""
    title: Optional[str] = None
    prompt: Optional[str] = None
    status: Optional[Literal["active", "paused"]] = None
    enabledTools: Optional[List[ToolPreference]] = None
    agentId: Optional[str] = None
    targetMode: Optional[TaskTargetMode] = None
    isPrivate: Optional[bool] = None
    maxRuns: Optional[int] = Field(None, ge=1)
    expiresAt: Optional[datetime] = None
    scheduleKind: Optional[ScheduleKind] = None
    runAt: Optional[datetime] = None
    intervalSeconds: Optional[int] = None
    cronExpr: Optional[str] = None
    timezone: Optional[str] = None

    @model_validator(mode="after")
    def _normalize(self) -> "ScheduledTaskUpdate":
        if self.prompt is not None:
            self.prompt = self.prompt.strip()
            if not self.prompt:
                raise ValueError("prompt cannot be empty.")
            if len(self.prompt) > 8000:
                raise ValueError("prompt must be 8000 characters or fewer.")
        if self.title is not None:
            self.title = self.title.strip()[:200] or None
        if self.agentId is not None:
            self.agentId = self.agentId.strip()
            if not self.agentId:
                raise ValueError("agentId cannot be empty.")
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        if self.scheduleKind is not None:
            self.runAt, self.cronExpr, self.timezone = _normalize_schedule(
                self.scheduleKind, self.runAt, self.intervalSeconds, self.cronExpr, self.timezone, now=now
            )
        if self.expiresAt is not None:
            self.expiresAt = _to_naive_utc(self.expiresAt)
            if self.expiresAt <= now:
                raise ValueError("expiresAt must be in the future.")
        return self


class ScheduledTaskOut(BaseModel):
    """A scheduled task as the frontend management panel sees it.

    ``liveStatus`` and ``lastRunConversationId`` are derived (the util sets them
    after ``model_validate`` from a lookup of ``last_run_message_id``) — they are
    not ORM columns, so they default to None when validated straight from a row.
    """
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: str
    agentId: Optional[str] = Field(None, validation_alias="agent_id")
    agentName: Optional[str] = Field(None, validation_alias="agent_name")
    agentSlug: Optional[str] = Field(None, validation_alias="agent_slug")
    conversationId: Optional[str] = Field(None, validation_alias="conversation_id")
    title: Optional[str] = None
    prompt: str
    enabledTools: List[dict] = Field(default_factory=list, validation_alias="enabled_tools")
    isPrivate: bool = Field(False, validation_alias="is_private")
    targetMode: str = Field("fresh", validation_alias="target_mode")
    scheduleKind: str = Field(..., validation_alias="schedule_kind")
    scheduleSpec: dict = Field(default_factory=dict, validation_alias="schedule_spec")
    timezone: Optional[str] = None
    status: str
    nextRunAt: Optional[UTCDateTime] = Field(None, validation_alias="next_run_at")
    lastRunAt: Optional[UTCDateTime] = Field(None, validation_alias="last_run_at")
    lastRunStatus: Optional[str] = Field(None, validation_alias="last_run_status")
    lastRunMessageId: Optional[str] = Field(None, validation_alias="last_run_message_id")
    lastError: Optional[str] = Field(None, validation_alias="last_error")
    runCount: int = Field(0, validation_alias="run_count")
    maxRuns: Optional[int] = Field(None, validation_alias="max_runs")
    expiresAt: Optional[UTCDateTime] = Field(None, validation_alias="expires_at")
    createdAt: UTCDateTime = Field(..., validation_alias="created_at")
    updatedAt: UTCDateTime = Field(..., validation_alias="updated_at")

    # Derived, set by the util after model_validate (not ORM columns).
    liveStatus: Optional[str] = None
    lastRunConversationId: Optional[str] = None

    @field_validator("enabledTools", mode="before")
    @classmethod
    def _coerce_tools(cls, value):
        return value if isinstance(value, list) else []

    @field_validator("scheduleSpec", mode="before")
    @classmethod
    def _coerce_spec(cls, value):
        return value if isinstance(value, dict) else {}


#-------------------------------------------
# CONVERSATION UPDATE DTO
#-------------------------------------------
class UpdateConversationResponse(BaseModel):
    message: MessageOut
    summary: ConversationSummary


class MessageUpdate(BaseModel):
    """
    Update an existing message (used for streaming AI placeholders).
    Content is required because this call finalises a previously empty message.
    """
    content: Optional[str] = None
    thinking: Optional[List[str]] = None
    thinkingTime: Optional[int] = None
    error: Optional[bool] = None
    errorMessage: Optional[str] = None
    rawEvents: List[dict] = Field(default_factory=list)

    @model_validator(mode="after")
    def _require_content(self):
        if self.content is None:
            raise ValueError("Message content is required to update the message.")
        return self



#-------------------------------------------
# DOCX PREVIEW TOKEN DTO
#-------------------------------------------
class DocxPreviewTokenOut(BaseModel):
    token: str
    expiresIn: int


#-------------------------------------------
# IMAGES RETRIEVAL DTO
#-------------------------------------------
class ImageOut(BaseModel):
    """Schema to expose all the info for an Image"""
    blobId: str = Field(..., validation_alias="blob_id")
    attachmentId: str = Field(..., validation_alias="attachment_id")
    fileName: str = Field(..., validation_alias="file_name")
    mime: str = Field(..., validation_alias="mime_type")
    createdAt: UTCDateTime = Field(..., validation_alias="created_at")
    dataB64: str



#-------------------------------------------
# TITLE DTO
#-------------------------------------------
class TitleOut(BaseModel):
    titles: List[str]


class SuggestionsOut(BaseModel):
    suggestions: List[str]


class ConversationTitleUpdate(BaseModel):
    """Payload to update the title of an existing conversation."""
    title: str

    @model_validator(mode="after")
    def _normalize_and_validate(self):
        resolved = (self.title or "").strip()
        if not resolved:
            raise ValueError("Title cannot be empty.")
        # Keep titles reasonably short for sidebar rendering.
        if len(resolved) > 200:
            resolved = resolved[:200].rstrip()
        self.title = resolved
        return self


class ConversationReportIn(BaseModel):
    """Payload to create a conversation report with an optional specific message target."""
    reason: str
    details: Optional[str] = None
    messageId: Optional[str] = Field(None, validation_alias="messageId")

    @model_validator(mode="after")
    def _normalize_and_validate(self):
        resolved_reason = (self.reason or "").strip()
        if not resolved_reason:
            raise ValueError("Reason is required.")
        if len(resolved_reason) > 120:
            resolved_reason = resolved_reason[:120].rstrip()

        resolved_details = (self.details or "").strip() or None
        if resolved_details and len(resolved_details) > 2000:
            resolved_details = resolved_details[:2000].rstrip()

        resolved_message_id = (self.messageId or "").strip() or None

        self.reason = resolved_reason
        self.details = resolved_details
        self.messageId = resolved_message_id
        return self


__all__ = [
    "AuthRequest",
    "UserProfile",
    "AuthResponse",
    "DictationResponse",
    "AgentFull",
    "AgentPublic",
    "ToolManifest",
    "Skill",
    "ToolPreference",
    "ToolsPreferences",
    "UserPreferences",
    "ConversationSummary",
    "BlobOut",
    "AttachmentOut",
    "MessageOut",
    "ConversationDetail",
    "AttachmentIn",
    "MessageIn",
    "ConversationIn",
    "ConversationForkIn",
    "ConversationShareIn",
    "ConversationPdfExportIn",
    "ConversationShareResponse",
    "ConversationShareListItem",
    "SharedConversationDetail",
    "CreateConversationResponse",
    "RealtimeVoiceSessionIn",
    "RealtimeVoiceSessionOut",
    "RealtimeVoiceConversationEventIn",
    "RealtimeVoiceEndIn",
    "RealtimeVoiceEndOut",
    "InferenceStartPayload",
    "InferenceStartResponse",
    "InferenceRunOut",
    "InferenceRunResumeIn",
    "ScheduledTaskCreate",
    "ScheduledTaskUpdate",
    "ScheduledTaskOut",
    "UpdateConversationResponse",
    "MessageUpdate",
    "ImageOut",
    "TitleOut",
    "SuggestionsOut",
    "ConversationTitleUpdate",
    "ConversationReportIn",
]
