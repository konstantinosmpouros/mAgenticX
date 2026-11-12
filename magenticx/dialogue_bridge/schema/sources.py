"""Citation sources of a conversation (plan 42, inline citations).

A source is a page a search tool really returned in the conversation: the
agents service stores it per conversation (``agent_runtime.conversation_sources``)
and the chat resolves the ``[src:ID]`` markers in an answer against it. The
bridge only passes sources through, but it never trusts the upstream: every
source is validated again on the way out — ``http(s)`` URLs only, lengths
capped, control characters stripped — because the titles and snippets come
from arbitrary web pages and the URLs end up as links in the browser.

A source that fails validation is dropped on its own (``keep_valid_sources``):
one bad row must never hide the conversation's other citations.
"""
import re
from typing import Any
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

#: The contract's limits (plan 42 §3.8).
SOURCE_URL_MAX_CHARS = 2048
SOURCE_TITLE_MAX_CHARS = 300
SOURCE_SNIPPET_MAX_CHARS = 300
SOURCE_TOOL_MAX_CHARS = 100
#: The most sources one conversation answers with (newest first upstream).
MAX_CONVERSATION_SOURCES = 500

#: Six hex chars of the URL hash, eight when six clash in one tool result.
SOURCE_ID_PATTERN = r"^[0-9a-f]{6,8}$"

# C0/C1 control characters and DEL. Whitespace controls are collapsed into a
# space first, so a multi-line snippet stays readable instead of glued.
_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f-\x9f]")
_WHITESPACE_RUN = re.compile(r"\s+")


def _clean_text(value: Any, limit: int) -> str:
    """Collapse whitespace, strip control characters and cap the length."""
    text = value if isinstance(value, str) else ("" if value is None else str(value))
    text = _WHITESPACE_RUN.sub(" ", text)
    text = _CONTROL_CHARS.sub("", text).strip()
    return text[:limit]


class ConversationSource(BaseModel):
    """One citable source, as the chat renders it in a citation card."""
    model_config = ConfigDict(extra="ignore")

    id: str = Field(pattern=SOURCE_ID_PATTERN)
    url: str = Field(max_length=SOURCE_URL_MAX_CHARS)
    title: str = ""
    snippet: str = ""
    tool: str = ""

    @field_validator("url")
    @classmethod
    def _http_url_only(cls, value: str) -> str:
        """Reject anything but an absolute ``http(s)`` URL with a host.

        A ``javascript:`` or ``data:`` URL in a search result would otherwise
        become a clickable link; whitespace or control characters inside a URL
        are refused rather than repaired, since a repaired URL is not the page
        the tool returned.
        """
        if value != value.strip() or _CONTROL_CHARS.search(value) or any(c.isspace() for c in value):
            raise ValueError("url must not contain whitespace or control characters")
        parts = urlsplit(value)
        if parts.scheme.lower() not in ("http", "https") or not parts.hostname:
            raise ValueError("url must be an absolute http(s) URL")
        return value

    @field_validator("title", mode="before")
    @classmethod
    def _cap_title(cls, value: Any) -> str:
        return _clean_text(value, SOURCE_TITLE_MAX_CHARS)

    @field_validator("snippet", mode="before")
    @classmethod
    def _cap_snippet(cls, value: Any) -> str:
        return _clean_text(value, SOURCE_SNIPPET_MAX_CHARS)

    @field_validator("tool", mode="before")
    @classmethod
    def _cap_tool(cls, value: Any) -> str:
        return _clean_text(value, SOURCE_TOOL_MAX_CHARS)


def keep_valid_sources(items: Any, limit: int = MAX_CONVERSATION_SOURCES) -> list[ConversationSource]:
    """The items that validate as sources, in order, at most ``limit``, one per id.

    Anything that is not a list yields nothing. Used for the upstream answer
    and for the sources frozen into a share snapshot, so neither an old
    snapshot nor a misbehaving agents service can fail a whole response.
    """
    if not isinstance(items, list):
        return []
    kept: list[ConversationSource] = []
    seen: set[str] = set()
    for item in items:
        if len(kept) >= limit:
            break
        if isinstance(item, ConversationSource):
            source = item
        else:
            try:
                source = ConversationSource.model_validate(item)
            except ValidationError:
                continue
        if source.id in seen:
            continue
        seen.add(source.id)
        kept.append(source)
    return kept


class ConversationSourcesOut(BaseModel):
    """``GET /v1/conversations/{user_id}/{conversation_id}/sources``."""
    sources: list[ConversationSource] = Field(default_factory=list)

    @field_validator("sources", mode="before")
    @classmethod
    def _drop_invalid(cls, value: Any) -> list[ConversationSource]:
        return keep_valid_sources(value)
