"""The async sub-agent middleware, wired to this process's own Agent Protocol router.

deepagents' ``AsyncSubAgentMiddleware`` reaches its server through the
``langgraph_sdk`` client, which it builds itself with a plain HTTP transport.
For us that server is this very service, and going out over the network would
be wrong twice over:

* **mTLS.** On Dennis every internal hop needs our client certificate, which
  the stock transport does not carry, so the call would fail its handshake.
* **State.** A task's active run is an ``asyncio`` task in *this* process
  (``harness.async_tasks.runner``); a request routed to another replica could
  not cancel or fold into it.

So :class:`AsyncTaskMiddleware` is the upstream middleware with one change: its
clients use an in-process ASGI transport onto the FastAPI app (registered by
``main`` through :func:`set_protocol_app`). The request still passes through
the full router — internal-caller gate, launch token, task-row authorisation,
Pydantic in and out — it just never leaves the process.

The five tools are built with deepagents' own (private) builders so their
names, schemas, descriptions and behaviour stay exactly upstream's; a contract
test pins the tool names.
"""
from __future__ import annotations

import asyncio
from typing import Any

import httpx
from deepagents.middleware.async_subagents import (
    ASYNC_TASK_TOOL_DESCRIPTION,
    AsyncSubAgent,
    AsyncSubAgentMiddleware,
    _build_cancel_tool,
    _build_check_tool,
    _build_list_tasks_tool,
    _build_start_tool,
    _build_update_tool,
    _ClientCache,
    _describe_async_subagent,
    _resolve_headers,
)
from langgraph_sdk.client import LangGraphClient, SyncLangGraphClient

#: The FastAPI app ``/ap`` is mounted on; set once by ``main``.
_protocol_app: Any | None = None

#: One ``/ap`` call (they are all quick bookkeeping; runs execute elsewhere).
_REQUEST_TIMEOUT = httpx.Timeout(30.0, connect=5.0)


def set_protocol_app(app: Any) -> None:
    """Register the app that serves ``/ap`` in this process."""
    global _protocol_app
    _protocol_app = app


async def _isolated_app(scope: Any, receive: Any, send: Any) -> None:
    """Serve one request in its own task.

    ``ASGITransport`` would otherwise run the app inside the *caller's* task, so
    the request middleware's context variables (request id, user, the log
    context) would leak back into the agent run that made the call. A task
    gets a copy of the context instead.

    Shielded: when the calling run is cancelled mid-call (a user stop, an
    interrupting update), the request still completes, so a task row and its
    run are never left half-written; only the answer is dropped.
    """
    await asyncio.shield(asyncio.create_task(_protocol_app(scope, receive, send)))


def protocol_client(base_url: str, headers: dict[str, str]) -> LangGraphClient:
    """A ``langgraph_sdk`` client whose requests are served by this process.

    Fails closed: with no app registered there is nothing to call, and the
    middleware turns the error into a tool result the model reads.
    """
    if _protocol_app is None:
        raise RuntimeError("The Agent Protocol app is not registered in this process.")
    transport = httpx.ASGITransport(app=_isolated_app, raise_app_exceptions=False)
    http = httpx.AsyncClient(base_url=base_url, transport=transport, headers=headers, timeout=_REQUEST_TIMEOUT)
    return LangGraphClient(http)


class _InProcessClients(_ClientCache):
    """deepagents' client cache, handing out in-process clients."""

    def get_async(self, name: str) -> LangGraphClient:
        spec = self._agents[name]
        key = self._cache_key(spec)
        if key not in self._async:
            self._async[key] = protocol_client(str(spec.get("url") or ""), _resolve_headers(spec))
        return self._async[key]

    def get_sync(self, name: str) -> SyncLangGraphClient:
        # Our agents always run on the async path (astream); a sync call would
        # need a network transport, which is exactly what this class avoids.
        raise ValueError(f"Async sub-agent {name!r} supports the async path only.")


class AsyncTaskMiddleware(AsyncSubAgentMiddleware):
    """``AsyncSubAgentMiddleware`` whose server is this process (see module doc)."""

    def __init__(self, *, async_subagents: list[AsyncSubAgent], system_prompt: str | None = None) -> None:
        super().__init__(async_subagents=async_subagents, system_prompt=system_prompt)
        agent_map: dict[str, AsyncSubAgent] = {spec["name"]: spec for spec in async_subagents}
        clients = _InProcessClients(agent_map)
        self._clients = clients
        launch_description = ASYNC_TASK_TOOL_DESCRIPTION.format(
            available_agents="\n".join(_describe_async_subagent(spec) for spec in async_subagents)
        )
        self.tools = [
            _build_start_tool(agent_map, clients, launch_description),
            _build_check_tool(clients),
            _build_update_tool(agent_map, clients),
            _build_cancel_tool(clients),
            _build_list_tasks_tool(clients),
        ]


__all__ = ["AsyncTaskMiddleware", "protocol_client", "set_protocol_app"]
