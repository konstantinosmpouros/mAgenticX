"""Time to first token for deep-agent model calls.

``UsageMetricsMiddleware`` times a model call from the outside: it knows when
the call started and when the reply settled, never when the first token came
back — the provider streams inside ``handler(request)``, out of its sight. The
only thing that sees each streamed chunk is a LangChain callback
(``on_llm_new_token``). So the measurement is split in two:

* the middleware opens a :func:`first_token_scope` around ``handler(request)``:
  a fresh, mutable :class:`CallRecord` held in a ``ContextVar``;
* :class:`FirstTokenCallback`, attached once to the deep agent run's config
  (LangChain carries it into every sub-agent), stamps the current record the
  first time a chunk with content or a tool-call fragment arrives.

Why a ``ContextVar`` and not a dict keyed by something: the middleware never
learns the callback's ``run_id``, and the callback never sees the middleware's
request. The context is the one thing both share — and it isolates concurrent
calls for free. Parallel sub-agents run as separate asyncio tasks, each with a
copy of the context, so each middleware call sets and reads its own record. A
callback dispatched on another task or thread (``asyncio.gather``, an executor)
runs in a *copy* of the caller's context, and a copy still points at the same
record object, which is why the record is a mutable object rather than a value
in the variable itself. The record also binds to the first chat-model run it
sees, so a token from any other run can never stamp it.

Why a plain (sync) handler with ``run_inline``: LangChain calls it inline on
both the sync and the async callback paths — no thread hop and no event loop
per token, which an ``AsyncCallbackHandler`` would cost on a sync stream.

A call that does not stream (no ``messages`` stream mode, a provider without
streaming) never fires ``on_llm_new_token`` and simply reports no TTFT.
"""
from __future__ import annotations

import time
from collections.abc import Iterator
from contextlib import contextmanager, suppress
from contextvars import ContextVar
from typing import Any
from uuid import UUID

from langchain_core.callbacks import BaseCallbackHandler

from core.logging import get_logger

logger = get_logger(__name__)


class CallRecord:
    """One model call's first-token stamp, owned by the middleware call that opened it."""

    __slots__ = ("first_token_at", "run_id")

    def __init__(self) -> None:
        self.run_id: UUID | None = None
        self.first_token_at: float | None = None  # time.monotonic()


_CURRENT_CALL: ContextVar[CallRecord | None] = ContextVar("mx_first_token_call", default=None)


@contextmanager
def first_token_scope() -> Iterator[CallRecord]:
    """Make a fresh :class:`CallRecord` the current one for the enclosed model call."""
    record = CallRecord()
    token = _CURRENT_CALL.set(record)
    try:
        yield record
    finally:
        # A reset from another context fails; the variable dies with that context anyway.
        with suppress(ValueError):
            _CURRENT_CALL.reset(token)


def is_first_token(token: Any, chunk: Any) -> bool:
    """Whether a streamed chunk carries output: text, a content block, or a tool-call fragment.

    Providers open a stream with an empty role-only chunk and close it with a
    usage-only one; neither is a token.
    """
    if isinstance(token, str) and token:
        return True
    message = getattr(chunk, "message", None)
    if message is None:
        return False
    if getattr(message, "tool_call_chunks", None):
        return True
    content = getattr(message, "content", None)
    return bool(content)


class FirstTokenCallback(BaseCallbackHandler):
    """Stamps the first streamed token on the current :class:`CallRecord`.

    Stateless: everything it writes lives on the record of the call in whose
    context it runs, so one instance can serve a whole run, sub-agents included.
    Never raises — telemetry must not fail a model call.
    """

    run_inline = True

    def on_chat_model_start(
        self, serialized: dict[str, Any], messages: list[list[Any]], *, run_id: UUID, **kwargs: Any
    ) -> None:
        record = _CURRENT_CALL.get()
        if record is not None and record.run_id is None:
            record.run_id = run_id

    def on_llm_new_token(self, token: str, *, chunk: Any = None, run_id: UUID, **kwargs: Any) -> None:
        record = _CURRENT_CALL.get()
        if record is None or record.first_token_at is not None:
            return
        if record.run_id is not None and record.run_id != run_id:
            return
        try:
            if is_first_token(token, chunk):
                record.run_id = run_id
                record.first_token_at = time.monotonic()
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("first_token_skipped", "Could not read a streamed chunk", error_type=type(exc).__name__)
