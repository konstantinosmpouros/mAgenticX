from typing import Any, Dict, List, Literal, Optional, Type
from pydantic import BaseModel, Field
from dataclasses import dataclass


class Request(BaseModel):
    """Pydantic model for incoming requests: a list of user input dictionaries."""
    messages: List[Dict[str, Any]]
    config: Dict[str, Any]


class AgentResumeRequest(BaseModel):
    """Resume payload for a LangGraph run paused on a HITL interrupt.

    The bridge forwards an approve/reject decision (plus an optional structured
    value or free-form reason) so the agents service can construct a
    ``Command(resume=...)`` against the saved checkpoint.

    ``interrupt_id`` is the LangGraph interrupt's unique id from the
    ``HITL_INTERRUPT`` event the user acted on. When supplied the agents
    service verifies it matches the checkpoint's currently-pending interrupt
    so a stale click (e.g. the user clicked the second card while the first
    was still in flight) can be 409'd instead of resolving the wrong one.
    """
    config: Dict[str, Any]
    thread_id: str
    decision: Literal["approve", "reject"]
    reason: Optional[str] = None
    value: Optional[Any] = None
    interrupt_id: Optional[str] = None


class TitleRequest(BaseModel):
    """Structured payload for generating a conversation title from the first user message."""
    user_input: List[Dict[str, Any]]



class ConversationTitle(BaseModel):
    """Structured LLM response carrying multiple generated title candidates."""
    titles: List[str]


class SuggestionsRequest(BaseModel):
    """Structured payload for generating personalized new-chat suggestions."""
    user_input: List[Dict[str, Any]]


class ConversationSuggestions(BaseModel):
    """Structured LLM response carrying generated new-chat suggestions."""
    suggestions: List[str]


class ReadAloudRequest(BaseModel):
    """Structured payload for generating spoken audio from AI response text."""
    text: str
    voice: Optional[str] = Field(default=None, min_length=1)


class TranscriptionResponse(BaseModel):
    text: str


class RealtimeSessionRequest(BaseModel):
    """SDP offer and session configuration for OpenAI Realtime WebRTC."""
    sdp: str = Field(..., min_length=1)
    model: Optional[str] = Field(default=None, min_length=1)
    voice: Optional[str] = Field(default=None, min_length=1)
    instructions: str = Field(default="", max_length=20000)
    metadata: Dict[str, Any] = Field(default_factory=dict)


class RealtimeSessionResponse(BaseModel):
    sdp: str
    model: str
    voice: str


class AgentManifest(BaseModel):
    id: str
    slug: str
    name: str
    version: Optional[str] = None
    type: str
    description: str
    icon: str


class ToolManifest(BaseModel):
    server_id: str = ""
    tool_name: str
    description: str = ""
    parameter_count: int = 0


class SkillManifest(BaseModel):
    """One entry in the central skills registry (``src/agents/skills_registry/``).

    ``content`` is the markdown body that follows the frontmatter — agents
    pull this in via the deepagents ``SkillsMiddleware`` when the user has
    enabled the skill for that (user, agent) pair.

    ``category`` is the parent folder under the global registry root. It
    surfaces in the UI as a small label next to the skill name so users can
    place a skill in context while searching.
    """

    name: str
    description: str = ""
    content: str = ""
    category: str = ""


class SkillManifestEntry(BaseModel):
    """One row in the on-disk manifest.json — global or per-user.

    ``source_path`` is relative to the skills_registry root the agents
    service joins it against. Globals: ``global/<category>/<name>``.
    Customs: ``users/<user_id>/custom/<name>`` (no category folder; custom
    skills are flat under each user's custom dir).

    ``category`` is the parent folder name in the global hierarchy — empty
    for custom skills.
    """

    name: str
    type: Literal["global", "custom"]
    description: str = ""
    source_path: str
    category: str = ""


class GlobalManifest(BaseModel):
    """The on-disk ``$SKILLS_REGISTRY_GLOBAL_ROOT/manifest.json`` schema."""

    version: int = 1
    skills: List[SkillManifestEntry] = Field(default_factory=list)


class UserManifest(BaseModel):
    """The on-disk per-user manifest schema at
    ``$SKILLS_REGISTRY_USERS_ROOT/<user_id>/manifest.json``."""

    version: int = 1
    skills: List[SkillManifestEntry] = Field(default_factory=list)


class SkillFile(BaseModel):
    """One file inside a skill folder.

    ``path`` is relative to the skill root and ``/``-separated (e.g.
    ``SKILL.md`` or ``references/api.md``). ``content`` is UTF-8 text when
    ``encoding == "utf-8"`` or standard base64 when ``encoding == "base64"``
    (used for binary assets like images). ``size`` is the decoded byte length —
    populated on read, ignored on create.
    """

    path: str
    content: str = ""
    encoding: Literal["utf-8", "base64"] = "utf-8"
    size: int = 0


class CustomSkillCreate(BaseModel):
    """Request body for ``POST /users/{user_id}/skills/custom``.

    A custom skill is a folder of files. Exactly one file must be named
    ``SKILL.md`` — its body is wrapped with canonical frontmatter assembled
    server-side from ``name`` + ``description`` so the agent reads a consistent
    SKILL.md regardless of how the skill was authored. Every other file is
    written verbatim (UTF-8 text or base64-decoded binary).
    """

    name: str
    description: str = ""
    files: List[SkillFile] = Field(default_factory=list)


class UserSkillDetail(BaseModel):
    """Returned by ``GET /users/{user_id}/skills/{name}`` — manifest row joined
    with the skill's file inventory.

    ``content`` is the parsed SKILL.md body (frontmatter stripped) kept as a
    convenience for a quick preview; ``files`` is the full on-disk inventory.
    """

    name: str
    type: Literal["global", "custom"]
    description: str = ""
    source_path: str
    category: str = ""
    content: str = ""
    files: List[SkillFile] = Field(default_factory=list)


@dataclass(frozen=True)
class AgentDefinition:
    slug: str
    cls: Type[Any]
    manifest: Dict[str, Any]
