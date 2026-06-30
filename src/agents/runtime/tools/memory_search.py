"""Agent tool: semantic search over the user's past conversation messages.

Built **per run** (closes over the current run's `user_id` + `conversation_id`,
which `BaseAgent` reads from the request config into `self.context`), so it
needs no request-context lookup at call time and cannot leak across users —
each request gets its own agent instance and compiled graph.

The bridge owns `chat_db` and its pgvector message index, so this tool reaches
the data through the bridge's internal `/v1/internal/memory/search` endpoint
(internal proxy secret + mTLS), never the DB directly. The current conversation
is excluded so the tool surfaces *other* past chats the agent isn't already
holding in context.
"""
import httpx
from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

from core.proxy import internal_service_headers
from core.settings import settings
from core.tls import get_httpx_client_cert, get_httpx_verify
from observability import get_logger

logger = get_logger(__name__)


class _MemorySearchArgs(BaseModel):
    query: str = Field(
        description="What to look for in the user's past conversations — a topic, question, fact, decision, or phrase."
    )
    limit: int = Field(
        default=5,
        ge=1,
        le=20,
        description="Maximum number of past messages to return (default 5).",
    )


def _format_matches(matches: list[dict]) -> str:
    if not matches:
        return "No relevant past messages found."
    lines: list[str] = []
    for match in matches:
        who = "User" if match.get("sender") == "user" else "Assistant"
        title = match.get("conversationTitle") or "Untitled chat"
        created = (match.get("createdAt") or "")[:10]
        updated = (match.get("updatedAt") or "")[:10]
        content = (match.get("content") or "").strip()
        parts = [title, who]
        if created:
            dates = f"created {created}"
            if updated and updated != created:
                dates += f", updated {updated}"
            parts.append(dates)
        header = " · ".join(parts)
        lines.append(f"- [{header}] {content}")
    return "Relevant past messages from this user's earlier conversations:\n" + "\n".join(lines)


def build_memory_search_tool(*, user_id: str, conversation_id: str | None) -> StructuredTool:
    """Return a `search_past_conversations` tool bound to this run's user."""

    async def _search(query: str, limit: int = 5) -> str:
        payload = {
            "user_id": user_id,
            "query": query,
            "limit": limit,
            "exclude_conversation_id": conversation_id,
        }
        timeout = httpx.Timeout(
            settings.bridge.request_timeout_seconds,
            connect=settings.bridge.connect_timeout_seconds,
        )
        try:
            async with httpx.AsyncClient(
                timeout=timeout,
                verify=get_httpx_verify(),
                cert=get_httpx_client_cert(),
            ) as client:
                response = await client.post(
                    settings.bridge.memory_search_url,
                    json=payload,
                    headers=internal_service_headers(),
                )
                response.raise_for_status()
                matches = response.json()
        except httpx.HTTPError as exc:
            logger.warning(
                "memory_tool_search_failed",
                "search_past_conversations failed against the bridge",
                failure_reason=type(exc).__name__,
            )
            return "Memory search is temporarily unavailable right now."

        if not isinstance(matches, list):
            return "Memory search returned an unexpected response."
        return _format_matches(matches)

    return StructuredTool.from_function(
        coroutine=_search,
        name="search_past_conversations",
        description=(
            "Search THIS user's earlier conversations (across all of their chats) for messages "
            "relevant to a query, so you can recall and refer to things discussed before. Use it "
            "when the user references earlier context, asks what they told you previously, or when "
            "a past decision/preference/fact would help answer. Returns the most relevant past "
            "messages with the conversation they came from and who said them. It does not include "
            "the current conversation."
        ),
        args_schema=_MemorySearchArgs,
    )
