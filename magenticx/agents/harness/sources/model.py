"""``Source`` — one citable web page, as every layer of plan 42 carries it.

Search results are untrusted input: a page's title or snippet can hold control
characters, bidi overrides, markup or a prompt injection, and its URL can be a
``javascript:`` link. This schema is where that is contained, once, for the
tool-result stamp, the ``SOURCES`` event, the store and the endpoints alike:

* ``url`` — ``http(s)`` only, with a host, no credentials, no whitespace, at
  most 2048 characters; ``utm_*`` parameters are removed (tracking);
* ``title`` / ``snippet`` — control and bidi characters dropped, whitespace
  collapsed, cut to 300 characters (an ellipsis marks the cut);
* ``tool`` — the tool name, cut to 100;
* ``id`` — 6 to 8 lowercase hex characters (:mod:`harness.sources.ids`).

A value that cannot be made safe (a bad URL) fails validation, and the caller
drops that source; a value that is merely long is shortened.
"""
from __future__ import annotations

import re
from typing import Any
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator

from harness.sources.ids import strip_tracking

MAX_URL_CHARS = 2048
MAX_TITLE_CHARS = 300
MAX_SNIPPET_CHARS = 300
MAX_TOOL_CHARS = 100

#: The id pattern of the contract (§3.8); the UI's marker regex expects it.
SOURCE_ID_PATTERN = r"^[0-9a-f]{6,8}$"

_ALLOWED_SCHEMES = frozenset({"http", "https"})

# C0/C1 controls, zero-width characters, line/paragraph separators and the bidi
# embedding/override/isolate controls: invisible, and able to reorder or hide
# what a reader sees.
_UNSAFE_CHARS = re.compile("[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]")


def clean_text(value: Any, limit: int) -> str:
    """``value`` as one safe line of at most ``limit`` characters."""
    text = " ".join(_UNSAFE_CHARS.sub(" ", str(value or "")).split())
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "…"


def clean_url(value: Any) -> str:
    """``value`` as a link a citation may carry, or ``ValueError``.

    Refused rather than repaired: a URL that is not a plain ``http(s)`` link
    to a host is not one the user should be sent to.
    """
    if not isinstance(value, str):
        raise ValueError("A source URL must be a string.")
    url = value.strip()
    if not url or len(url) > MAX_URL_CHARS:
        raise ValueError("A source URL must be 1 to 2048 characters long.")
    if any(ch.isspace() for ch in url) or _UNSAFE_CHARS.search(url):
        raise ValueError("A source URL must not contain whitespace or control characters.")
    parts = urlsplit(url)
    if parts.scheme.lower() not in _ALLOWED_SCHEMES:
        raise ValueError("A source URL must be http or https.")
    if not parts.hostname:
        raise ValueError("A source URL needs a host.")
    if parts.username is not None or parts.password is not None:
        # ``https://bank.example@evil.example`` reads as the first host.
        raise ValueError("A source URL must not carry credentials.")
    _ = parts.port  # raises ValueError for a malformed port
    return strip_tracking(url)


class Source(BaseModel):
    """One web page a tool returned, ready to cite. See the module docstring."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    id: str = Field(pattern=SOURCE_ID_PATTERN)
    url: str
    title: str = ""
    snippet: str = ""
    tool: str = ""

    @field_validator("url", mode="before")
    @classmethod
    def _url(cls, value: Any) -> str:
        return clean_url(value)

    @field_validator("title", mode="before")
    @classmethod
    def _title(cls, value: Any) -> str:
        return clean_text(value, MAX_TITLE_CHARS)

    @field_validator("snippet", mode="before")
    @classmethod
    def _snippet(cls, value: Any) -> str:
        return clean_text(value, MAX_SNIPPET_CHARS)

    @field_validator("tool", mode="before")
    @classmethod
    def _tool(cls, value: Any) -> str:
        return clean_text(value, MAX_TOOL_CHARS)


__all__ = [
    "MAX_SNIPPET_CHARS",
    "MAX_TITLE_CHARS",
    "MAX_TOOL_CHARS",
    "MAX_URL_CHARS",
    "SOURCE_ID_PATTERN",
    "Source",
    "clean_text",
    "clean_url",
]
