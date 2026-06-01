"""Unit tests for the Redis-backed inference event log.

These tests exercise :class:`utils.event_log.RedisEventLog` against an
in-process fakeredis instance, covering the three behaviours we rely on for
the WebSocket-based inference streaming:

1. Sequence IDs returned by ``append()`` are monotonic strings — clients can
   compare them lexically and resume from the last-seen value.
2. ``read_since()`` replays the full backlog when no cursor is given and
   resumes from the cursor when one is supplied.
3. ``read_since()`` terminates exactly when a terminal-status event is seen.
4. ``mark_terminal()`` sets a TTL on the stream key.
"""

from __future__ import annotations

import pytest_asyncio

from fakeredis import aioredis as fake_aioredis

from utils.event_log import RedisEventLog, _stream_key


TERMINAL = {"completed", "cancelled", "failed"}


@pytest_asyncio.fixture
async def fake_redis():
    client = fake_aioredis.FakeRedis(decode_responses=True)
    try:
        yield client
    finally:
        await client.aclose()


@pytest_asyncio.fixture
async def event_log(fake_redis):
    log = RedisEventLog()
    log._client = fake_redis
    try:
        yield log
    finally:
        log._client = None


async def test_append_returns_monotonic_sequence_ids(event_log):
    a = await event_log.append("run-1", {"type": "update", "n": 1})
    b = await event_log.append("run-1", {"type": "update", "n": 2})
    c = await event_log.append("run-1", {"type": "update", "n": 3})
    assert isinstance(a, str) and isinstance(b, str) and isinstance(c, str)
    assert a < b < c


async def test_read_since_replays_full_backlog_when_no_cursor(event_log):
    await event_log.append("run-1", {"type": "update", "n": 1})
    await event_log.append("run-1", {"type": "update", "n": 2})
    await event_log.append("run-1", {"type": "update", "n": 3, "run": {"status": "completed"}})

    received: list[dict] = []
    async for _entry_id, payload in event_log.read_since(
        "run-1", since=None, terminal_statuses=TERMINAL
    ):
        received.append(payload)

    assert [event["n"] for event in received] == [1, 2, 3]


async def test_read_since_resumes_from_cursor(event_log):
    seq1 = await event_log.append("run-1", {"type": "update", "n": 1})
    await event_log.append("run-1", {"type": "update", "n": 2})
    await event_log.append("run-1", {"type": "update", "n": 3, "run": {"status": "completed"}})

    received: list[dict] = []
    async for _entry_id, payload in event_log.read_since(
        "run-1", since=seq1, terminal_statuses=TERMINAL
    ):
        received.append(payload)

    # `since` is exclusive — seq1 was already seen by the prior client; only the
    # events after it should be replayed.
    assert [event["n"] for event in received] == [2, 3]


async def test_read_since_stops_at_first_terminal_event(event_log):
    await event_log.append("run-1", {"type": "update", "n": 1})
    await event_log.append("run-1", {"type": "terminal", "run": {"status": "cancelled"}})
    # An extra appended event after the terminal must NOT be delivered.
    await event_log.append("run-1", {"type": "update", "n": 3})

    received: list[dict] = []
    async for _entry_id, payload in event_log.read_since(
        "run-1", since=None, terminal_statuses=TERMINAL
    ):
        received.append(payload)

    assert len(received) == 2
    assert received[-1]["run"]["status"] == "cancelled"


async def test_streams_are_per_run_isolated(event_log):
    await event_log.append("run-A", {"type": "update", "n": 1, "run": {"status": "completed"}})
    await event_log.append("run-B", {"type": "update", "n": 99, "run": {"status": "completed"}})

    received_a: list[dict] = []
    async for _entry_id, payload in event_log.read_since(
        "run-A", since=None, terminal_statuses=TERMINAL
    ):
        received_a.append(payload)

    received_b: list[dict] = []
    async for _entry_id, payload in event_log.read_since(
        "run-B", since=None, terminal_statuses=TERMINAL
    ):
        received_b.append(payload)

    assert [event["n"] for event in received_a] == [1]
    assert [event["n"] for event in received_b] == [99]


async def test_mark_terminal_sets_ttl_on_stream_key(event_log, fake_redis):
    await event_log.append("run-1", {"type": "update", "n": 1})
    await event_log.mark_terminal("run-1")
    ttl = await fake_redis.ttl(_stream_key("run-1"))
    # TTL is the configured terminal_ttl_seconds (default 3600); anything > 0
    # and ≤ 3600 confirms the EXPIRE landed.
    assert 0 < ttl <= 3600
