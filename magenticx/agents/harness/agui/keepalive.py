"""SSE keepalive for the agent streams: a comment line while the agent is silent.

The bridge reads a run's stream with a read timeout (``HTTP_INFERENCE_READ_SECONDS``,
180 s) and fails the run when no byte arrives for that long. An agent can be
silent longer than that while it is still working: a reasoning model thinking
before a long tool call, a tool that takes minutes. The stream then sends
``: keepalive`` every ``KEEPALIVE_SECONDS`` of silence — an SSE comment, which
every SSE reader (the bridge's ``_parse_sse_bytes`` included) skips — so the
connection stays alive for as long as the agent works, and only a dead agent
times out.

The stream runs in ONE task of its own, feeding a queue the response reads: its
steps must not be spread over several tasks, since the MCP session (anyio
cancel scopes) and the context variables it sets belong to the task that
entered them.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import suppress

#: Seconds of silence before a keepalive, far under the bridge's read timeout.
KEEPALIVE_SECONDS = 15.0
#: The SSE comment sent meanwhile.
KEEPALIVE_FRAME = b": keepalive\n\n"
#: Frames buffered ahead of the reader (the agent waits beyond it, as before).
_BUFFER = 256


async def with_keepalive(
    stream: AsyncIterator[bytes], *, interval: float = KEEPALIVE_SECONDS
) -> AsyncIterator[bytes]:
    """``stream``'s frames, in order, with a keepalive after every ``interval`` of silence.

    The stream ends when ``stream`` does, and raises what it raised. Closing
    this generator (the client went away) cancels ``stream``'s task, which
    sees the ``CancelledError`` it would have seen without the wrapper.
    """
    queue: asyncio.Queue[bytes] = asyncio.Queue(maxsize=_BUFFER)

    async def pump() -> None:
        async for frame in stream:
            await queue.put(frame)

    producer = asyncio.ensure_future(pump())
    getter: asyncio.Future[bytes] | None = None
    try:
        while True:
            if getter is None:
                getter = asyncio.ensure_future(queue.get())
            done, _ = await asyncio.wait({getter, producer}, timeout=interval, return_when=asyncio.FIRST_COMPLETED)
            if getter in done:
                frame, getter = getter.result(), None
                yield frame
                continue
            if producer in done:
                # The stream ended: what it queued last still goes out, then its outcome.
                getter.cancel()
                getter = None
                while not queue.empty():
                    yield queue.get_nowait()
                producer.result()
                return
            yield KEEPALIVE_FRAME
    finally:
        if getter is not None:
            getter.cancel()
        if not producer.done():
            producer.cancel()
            with suppress(asyncio.CancelledError):
                await producer
