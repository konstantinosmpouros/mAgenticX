"""Shared schema building blocks: the Senders and EffortLevel literals and the UTC-serializing datetime annotation used across every DTO module."""
from typing import Annotated, Literal
from pydantic import PlainSerializer
from datetime import datetime, timezone


Senders = Literal["user", "ai"]

# How hard a reasoning model thinks on one turn, picked per message in the
# composer. The agents service owns which levels a model accepts (and maps them
# onto the provider's knob); the bridge only validates the word and carries it.
EffortLevel = Literal["minimal", "low", "medium", "high", "xhigh"]


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
