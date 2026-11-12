"""Mark every web page a search tool returns with a source id the agent can cite.

Plan 42: the agent cites a sentence with ``[src:ID]``, and the chat turns that
marker into an inline citation — but only for an id a tool really returned.
This middleware is where those ids come from. Around every tool call it:

1. runs the tool;
2. asks the extractor registry (:mod:`harness.sources.extractors`) for the
   result's sources — a tool without an extractor passes through untouched;
3. rewrites the ``ToolMessage`` the model sees, so each page carries its
   ``[src:ID]`` marker;
4. stamps the sources on the message (``response_metadata["mx_sources"]``),
   which the AG-UI normalizer turns into a ``SOURCES`` event right after the
   tool's result — the same route as ``ToolMetricsMiddleware``'s stamp, since
   the settled ToolMessage is the one thing of a deep agent's stream that
   reaches the normalizer;
5. on the async path, when the run has a user and a conversation, keeps the
   sources in ``conversation_sources`` — the registry a citation resolves
   against when a background task found the page (plan 42 §3.7).

Citations are an enhancement, never a dependency: every failure — an
unreadable result, a store that is down or slow — is logged with counts and the
tool name only (never a URL or snippet: they carry the user's search terms) and
the call returns its result as usual, uncited if need be.

**Placement.** ``DeepAgent._run_middleware`` puts it directly outside
``ToolErrorMiddleware`` (first is outermost), so a tool that raised reaches it
as an error ToolMessage and is left alone, and ``ToolMetricsMiddleware`` (outside
it) measures the result the model really reads. deepagents' own filesystem
middleware sits further out, so a result too large for the context is offloaded
*with* its markers.
"""
from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

import psycopg
from langchain.agents.middleware.types import AgentMiddleware, ToolCallRequest
from langchain_core.messages import ToolMessage
from langgraph.types import Command

from core.logging import get_logger
from harness.memory import get_memory_pool
from harness.sources import ConversationSourceStore, Source, extract_sources

logger = get_logger(__name__)

#: Key on ``ToolMessage.response_metadata`` the normalizer reads.
SOURCES_KEY = "mx_sources"

#: Longest the store write may hold up a tool result before it is given up.
STORE_TIMEOUT_SECONDS = 5.0


class SourcesMiddleware(AgentMiddleware):
    """Extract a tool result's sources, show the model their ids, stamp and keep them.

    ``user_id`` and ``conversation_id`` are the run's; without both, nothing is
    stored (a run outside a conversation still gets ids and the stamp).
    ``store`` defaults to the ``agent_runtime`` store, resolved at write time
    so building an agent never needs the pool.
    """

    def __init__(
        self,
        *,
        user_id: str | None = None,
        conversation_id: str | None = None,
        store: Any | None = None,
        is_mcp_tool: Callable[[str], bool] | None = None,
    ) -> None:
        super().__init__()
        self.user_id = user_id
        self.conversation_id = conversation_id
        self._store = store
        # Which tools the MCP gateway serves: they are read generically for
        # sources. Injected (utils.mcp_tools) rather than imported, which would
        # close an import cycle through the AG-UI normalizer.
        self._is_mcp_tool = is_mcp_tool or (lambda _name: False)

    def wrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], ToolMessage | Command],
    ) -> ToolMessage | Command:
        result = handler(request)  # an exception propagates as is (control flow, HITL)
        self._mark(request, result)
        return result

    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command]],
    ) -> ToolMessage | Command:
        result = await handler(request)
        sources = self._mark(request, result)
        if sources:
            await self._keep(sources)
        return result

    def _mark(self, request: ToolCallRequest, result: Any) -> list[Source]:
        """Rewrite and stamp ``result`` in place; the sources it holds (maybe none).

        Only a successful ``ToolMessage`` is read: an error result has no
        pages, and a ``Command`` is a state update, not a search result.
        """
        if not isinstance(result, ToolMessage) or result.status == "error":
            return []
        name = (getattr(request, "tool_call", None) or {}).get("name") or result.name
        # Any MCP tool is read too (a new search server cites with no code here).
        sources, content = extract_sources(name, result.content, mcp=self._is_mcp_tool(str(name)))
        if not sources:
            return []
        try:
            result.content = content
            result.response_metadata = {
                **(result.response_metadata or {}),
                SOURCES_KEY: [source.model_dump() for source in sources],
            }
        except (AttributeError, TypeError, ValueError) as exc:
            logger.warning("sources_stamp_skipped", "Could not mark sources on a tool result",
                           tool=str(name)[:100], error_type=type(exc).__name__)
            return []
        logger.info("sources_marked", "Marked a tool result's sources", tool=str(name)[:100], sources=len(sources))
        return sources

    def _resolve_store(self) -> Any:
        return self._store if self._store is not None else ConversationSourceStore(get_memory_pool())

    async def _keep(self, sources: list[Source]) -> None:
        """Store the sources for the conversation; a failure only costs the
        cross-run registry, never the call."""
        if not (self.user_id and self.conversation_id):
            return
        try:
            async with asyncio.timeout(STORE_TIMEOUT_SECONDS):
                await self._resolve_store().upsert_many(self.user_id, self.conversation_id, sources)
        except (psycopg.Error, RuntimeError, ValueError, OSError, TimeoutError) as exc:
            # RuntimeError: no pool wired (or a cipher without its key);
            # TimeoutError: the database is too slow to wait for.
            logger.warning("sources_store_failed", "Could not keep a tool result's sources",
                           sources=len(sources), error_type=type(exc).__name__)


__all__ = ["SOURCES_KEY", "SourcesMiddleware"]
