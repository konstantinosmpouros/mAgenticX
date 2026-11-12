"""Citable sources (plan 42): the pages a search tool returned, so the agent can cite them.

* ``model`` — :class:`Source`, the one schema every layer carries; where
  untrusted search results are made safe (http(s) only, capped, no controls).
* ``ids`` — the short, deterministic id of a page (hash of its normalised URL).
* ``extractors`` — the registry: tool name → how to read its result and mark
  each page with ``[src:ID]`` for the model.
* ``store`` — the conversation's sources in ``agent_runtime``, the registry a
  citation resolves against across runs, sub-agents and background tasks.

``SourcesMiddleware`` (``harness/middlewares/sources.py``) puts these together
on every tool call; the normalizer turns its stamp into the ``SOURCES`` event.
"""
from harness.sources.extractors import (
    EXTRACTORS,
    MAX_SOURCES_PER_RESULT,
    extract_sources,
    has_extractor,
    marker,
)
from harness.sources.ids import assign_ids, normalise_url, source_id, strip_tracking
from harness.sources.model import SOURCE_ID_PATTERN, Source
from harness.sources.store import MAX_LISTED_SOURCES, ConversationSourceStore

__all__ = [
    "EXTRACTORS",
    "MAX_LISTED_SOURCES",
    "MAX_SOURCES_PER_RESULT",
    "SOURCE_ID_PATTERN",
    "ConversationSourceStore",
    "Source",
    "assign_ids",
    "extract_sources",
    "has_extractor",
    "marker",
    "normalise_url",
    "source_id",
    "strip_tracking",
]
