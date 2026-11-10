"""The agent streams send an SSE comment while the agent is silent, so the bridge never times out a working run."""

from __future__ import annotations

import asyncio
import contextvars

import pytest

from harness.agui.keepalive import KEEPALIVE_FRAME, with_keepalive

pytestmark = pytest.mark.asyncio


async def _collect(stream):
    return [frame async for frame in stream]


async def test_frames_pass_through_in_order_without_keepalives_when_never_silent():
    async def stream():
        for frame in (b"data: 1\n\n", b"data: 2\n\n", b"data: 3\n\n"):
            yield frame

    assert await _collect(with_keepalive(stream(), interval=5)) == [b"data: 1\n\n", b"data: 2\n\n", b"data: 3\n\n"]


async def test_a_silence_sends_keepalives_until_the_next_frame():
    async def stream():
        yield b"data: 1\n\n"
        await asyncio.sleep(0.35)
        yield b"data: 2\n\n"

    frames = await _collect(with_keepalive(stream(), interval=0.1))
    assert frames[0] == b"data: 1\n\n" and frames[-1] == b"data: 2\n\n"
    assert 2 <= frames.count(KEEPALIVE_FRAME) <= 4
    assert set(frames[1:-1]) == {KEEPALIVE_FRAME}


async def test_the_end_is_not_delayed_by_the_interval():
    async def stream():
        yield b"data: last\n\n"

    loop = asyncio.get_running_loop()
    started = loop.time()
    assert await _collect(with_keepalive(stream(), interval=30)) == [b"data: last\n\n"]
    assert loop.time() - started < 1


async def test_the_keepalive_is_a_comment_the_bridge_parser_skips(agents_service):
    # The bridge's parser: an event without `data:` lines is dropped.
    assert KEEPALIVE_FRAME.startswith(b":") and KEEPALIVE_FRAME.endswith(b"\n\n")


async def test_an_error_in_the_stream_reaches_the_reader():
    async def stream():
        yield b"data: 1\n\n"
        raise RuntimeError("boom")

    frames = []
    with pytest.raises(RuntimeError, match="boom"):
        async for frame in with_keepalive(stream(), interval=5):
            frames.append(frame)
    assert frames == [b"data: 1\n\n"]


async def test_closing_the_reader_cancels_the_stream():
    cancelled = asyncio.Event()

    async def stream():
        try:
            yield b"data: 1\n\n"
            await asyncio.sleep(60)
            yield b"data: never\n\n"
        except asyncio.CancelledError:
            cancelled.set()
            raise

    wrapped = with_keepalive(stream(), interval=5)
    assert await wrapped.__anext__() == b"data: 1\n\n"
    await wrapped.aclose()
    await asyncio.wait_for(cancelled.wait(), timeout=2)


async def test_the_stream_runs_in_one_task_so_its_context_holds_across_frames():
    # The MCP session (anyio) and the logging context need every step of the
    # stream in the same task.
    var: contextvars.ContextVar[str] = contextvars.ContextVar("var", default="unset")
    seen = []

    async def stream():
        var.set("set-in-step-1")
        task = asyncio.current_task()
        yield b"data: 1\n\n"
        await asyncio.sleep(0.15)
        seen.append((var.get(), asyncio.current_task() is task))
        yield b"data: 2\n\n"

    await _collect(with_keepalive(stream(), interval=0.05))
    assert seen == [("set-in-step-1", True)]
