"""Shared schema building blocks: the Senders literal and the UTC-serializing datetime annotation used across every DTO module."""
from typing import Annotated, Literal
from pydantic import PlainSerializer
from datetime import datetime, timezone


Senders = Literal["user", "ai"]


def _serialize_utc(value: datetime) -> str:
    """Serialize a datetime as UTC ISO-8601 with a ``Z`` suffix.

    Stored timestamps are naive UTC (Postgres ``Etc/UTC`` + naive ``DateTime``
    columns). Without an explicit offset the browser's ``new Date(...)`` parses
    them as *local* time and renders them unconverted; stamping UTC lets the
    client show each timestamp in the viewing user's own timezone.
    """
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


UTCDateTime = Annotated[datetime, PlainSerializer(_serialize_utc, return_type=str, when_used="json")]
