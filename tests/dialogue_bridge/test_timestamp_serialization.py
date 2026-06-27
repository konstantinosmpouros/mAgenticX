from __future__ import annotations

from datetime import datetime, timezone, timedelta

from pydantic import BaseModel

from schemas import UTCDateTime


class _M(BaseModel):
    ts: UTCDateTime
    maybe: UTCDateTime | None = None


def test_naive_datetime_serializes_as_utc_z():
    m = _M(ts=datetime(2026, 6, 27, 1, 33, 2))
    assert m.model_dump(mode="json")["ts"] == "2026-06-27T01:33:02Z"


def test_naive_datetime_keeps_microseconds():
    m = _M(ts=datetime(2026, 6, 27, 1, 33, 2, 123456))
    assert m.model_dump(mode="json")["ts"] == "2026-06-27T01:33:02.123456Z"


def test_offset_aware_datetime_normalized_to_utc_z():
    aware = datetime(2026, 6, 27, 4, 33, 2, tzinfo=timezone(timedelta(hours=3)))
    assert _M(ts=aware).model_dump(mode="json")["ts"] == "2026-06-27T01:33:02Z"


def test_none_stays_none():
    assert _M(ts=datetime(2026, 6, 27, 1, 33, 2)).model_dump(mode="json")["maybe"] is None


def test_python_mode_keeps_datetime_object():
    # when_used="json" → python-mode dumps keep the datetime for internal callers
    out = _M(ts=datetime(2026, 6, 27, 1, 33, 2)).model_dump(mode="python")["ts"]
    assert isinstance(out, datetime)
