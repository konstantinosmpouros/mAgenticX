from typing import Any, Callable, Dict, List, Literal, Optional, Type
from pydantic import BaseModel, Field
from dataclasses import dataclass


class Request(BaseModel):
    """Pydantic model for incoming requests: a list of user input dictionaries."""
    messages: List[Dict[str, Any]]
    config: Dict[str, Any]


class ResumeActionDecision(BaseModel):
    """One approve/reject decision for a single gated tool call in a batched
    HITL interrupt. The list order is index-aligned to the interrupt's
    ``action_requests`` (LangChain maps ``decisions[i]`` to the i-th hanging
    tool call positionally)."""
    decision: Literal["approve", "reject"]
    reason: Optional[str] = None


class AgentResumeRequest(BaseModel):
    """Resume payload for a LangGraph run paused on a HITL interrupt.

    The bridge forwards an approve/reject decision (plus an optional structured
    value or free-form reason) so the agents service can construct a
    ``Command(resume=...)`` against the saved checkpoint.

    ``decisions`` is the per-action list for a *batched* interrupt (the
    orchestrator gated multiple tool calls in one turn): one entry per
    ``action_request`` in order, enabling independent approve/reject. When
    omitted, the single ``decision`` is replicated across all hanging tool
    calls (legacy / single-action path).

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
    decisions: Optional[List[ResumeActionDecision]] = None


class InputFileIn(BaseModel):
    """One user-uploaded file to seed into a conversation's read-only input/."""
    filename: str
    mime: str = ""
    base64: str
    size: int = 0


class SeedInputFilesRequest(BaseModel):
    """Bridge → agents: persist these files into the conversation's input/ dir."""
    files: List[InputFileIn]


class EmbedRequest(BaseModel):
    """Bridge → agents: a batch of texts to embed. The bridge has no OpenAI key
    of its own, so it proxies embedding through this service (same pattern as
    realtime voice). Order is preserved: response.embeddings[i] ↔ texts[i]."""
    texts: List[str]


class EmbedResponse(BaseModel):
    """One embedding vector per input text, plus the model + dimensions used."""
    embeddings: List[List[float]]
    model: str
    dimensions: int


class SeedInputFilesResponse(BaseModel):
    """Virtual paths the agent can read (``/conversation/input/<name>``)."""
    written: List[str]


class OutputFileOut(BaseModel):
    """One agent-generated deliverable read back from ``/conversation/output/``.

    Returned to the bridge (base64) so it can persist the file as a generated
    attachment. ``path`` is the virtual path the agent presented, echoed back so
    the bridge can rejoin it with the ``present_artifact`` event metadata."""
    path: str
    filename: str
    mime: str = "application/octet-stream"
    size: int = 0
    base64: str


class ReadOutputFilesResponse(BaseModel):
    """Bridge ← agents: the requested deliverables plus any paths that could not
    be returned (absent, oversized, or off-mount) so the caller skips them."""
    files: List[OutputFileOut]
    missing: List[str] = []


class ReapConversationRequest(BaseModel):
    """Bridge → agents: reap a conversation's durable checkpoint threads and its
    per-(user, agent) filesystem dir on conversation delete. ``thread_ids`` are
    the distinct ``checkpoint_thread_id``s the bridge recorded for the
    conversation's runs (it owns that relational metadata)."""
    thread_ids: List[str] = []


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
    """One entry in the central skills registry (``runtime/skill_registry/registry/``).

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


class MemoryEntry(BaseModel):
    """One saved memory's metadata (no body) — a row in the Memory inspector list.

    Mirrors the `entries/<name>.yml` fields the `remember` tool writes, minus
    ``content``. ``source_conversation_id`` is the provenance pointer.
    """

    name: str
    summary: str = ""
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    source_conversation_id: Optional[str] = None


class MemoryDetail(MemoryEntry):
    """A saved memory with its full ``content`` — the inspector's click-to-preview."""

    content: str = ""


@dataclass(frozen=True)
class AgentDefinition:
    """A registered agent template. ``cls`` is set for Python-class agents,
    ``factory`` for declarative (YAML) agents; ``build()`` picks whichever is
    present, so callers never branch on the kind."""

    slug: str
    manifest: Dict[str, Any]
    cls: Optional[Type[Any]] = None
    factory: Optional[Callable[..., Any]] = None

    def build(self, config: Optional[Dict[str, Any]] = None) -> Any:
        """Instantiate the agent for a run — ``factory(config)`` (YAML) or
        ``cls(config=config)`` (Python class)."""
        if self.factory is not None:
            return self.factory(config)
        if self.cls is not None:
            return self.cls(config=config)
        raise ValueError(f"AgentDefinition {self.slug!r} has neither factory nor cls.")
