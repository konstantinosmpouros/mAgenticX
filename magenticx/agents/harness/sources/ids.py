"""Source ids: a short, stable name for a web page the agent was shown (plan 42 §3.2).

An id is the first 6 hex characters of ``sha256(normalised URL)``. Hashing
makes it deterministic: the same page gets the same id in any run, sub-agent or
background task, so no counter is shared across runs and the orchestrator can
cite an id a task found. Six hex characters are short enough for the model to
copy exactly and never collide with a word.

Normalising decides which URLs are "the same page": the scheme and host are
lowercased, a leading ``www.`` goes, and so do the fragment, every ``utm_*``
query parameter and a trailing ``/`` (not the root's). Two different pages
whose 6-character ids clash inside one tool result both get 8 characters
(:func:`assign_ids`).
"""
from __future__ import annotations

import hashlib
from collections.abc import Iterable
from urllib.parse import urlsplit, urlunsplit

#: Length of an id, and of one extended because 6 clashed in a tool result.
SHORT_ID_LENGTH = 6
LONG_ID_LENGTH = 8

_TRACKING_PREFIX = "utm_"


def _without_tracking(query: str) -> str:
    """``query`` without its ``utm_*`` parameters, the rest kept byte for byte.

    Filtered on the raw ``&``-separated pairs rather than parsed and
    re-encoded, so a parameter we keep is never re-escaped differently.
    """
    kept = [
        pair for pair in query.split("&")
        if pair and not pair.split("=", 1)[0].lower().startswith(_TRACKING_PREFIX)
    ]
    return "&".join(kept)


def strip_tracking(url: str) -> str:
    """``url`` without ``utm_*`` parameters — what a user opens from a citation.

    Everything else, the fragment included, is left as the tool returned it,
    so the link still lands where the source pointed.
    """
    parts = urlsplit(url)
    return urlunsplit(parts._replace(query=_without_tracking(parts.query)))


def normalise_url(url: str) -> str:
    """The form of ``url`` an id is computed from (see the module docstring).

    Raises ``ValueError`` for a URL without a host or with a malformed port.
    """
    parts = urlsplit(url.strip())
    host = (parts.hostname or "").lower()
    if not host:
        raise ValueError("A source URL needs a host.")
    if host.startswith("www."):
        host = host[len("www."):]
    if ":" in host:  # an IPv6 literal: urlsplit took its brackets off
        host = f"[{host}]"
    port = parts.port  # raises ValueError for a malformed port
    netloc = f"{host}:{port}" if port is not None else host
    path = parts.path.rstrip("/") or "/"
    query = _without_tracking(parts.query)
    return urlunsplit((parts.scheme.lower(), netloc, path, query, ""))


def _digest(normalised: str) -> str:
    return hashlib.sha256(normalised.encode("utf-8")).hexdigest()


def source_id(url: str) -> str:
    """The 6-character id of ``url`` (no clash handling — see :func:`assign_ids`)."""
    return _digest(normalise_url(url))[:SHORT_ID_LENGTH]


def assign_ids(normalised_urls: Iterable[str]) -> dict[str, str]:
    """An id for each distinct normalised URL of one tool result.

    Two different pages whose 6-character ids clash both get 8 characters, so
    neither keeps an id the other could be mistaken for. The same URL twice is
    one page and gets one id.
    """
    digests = {url: _digest(url) for url in dict.fromkeys(normalised_urls)}
    short_counts: dict[str, int] = {}
    for digest in digests.values():
        short = digest[:SHORT_ID_LENGTH]
        short_counts[short] = short_counts.get(short, 0) + 1
    return {
        url: digest[:LONG_ID_LENGTH] if short_counts[digest[:SHORT_ID_LENGTH]] > 1 else digest[:SHORT_ID_LENGTH]
        for url, digest in digests.items()
    }


__all__ = [
    "LONG_ID_LENGTH",
    "SHORT_ID_LENGTH",
    "assign_ids",
    "normalise_url",
    "source_id",
    "strip_tracking",
]
