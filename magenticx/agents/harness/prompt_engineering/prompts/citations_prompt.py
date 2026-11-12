"""Citing sources: how to turn the ``[src:ID]`` ids a search tool returns into citations.

Plan 42. ``SourcesMiddleware`` puts an id such as ``[src:3fa2c1]`` beside every
page a search tool returns; the chat turns the same marker in the answer into
an inline citation, live as it streams. Only ids a tool really returned can
render, so the model has nothing to gain from inventing one.

The section states the outcome in a few lines (the prompt-engineering review of
2026-11-12: short, outcome-first, no shouting). It is the one place this is
said — the tool descriptions do not repeat it — and it is gated on
``has_source_tools``, so an agent without a search tool composes exactly the
prompt it had before. Background tasks get it too: a task's result keeps its
markers, and the orchestrator carries them into its answer.
"""
from __future__ import annotations

from harness.prompt_engineering.context import PromptContext

_HEADER = "## Cite What You Found"

_BODY = """\
Search results come with ids like `[src:3fa2c1]`. When a sentence states \
something you took from a result, end it with that marker, before the full \
stop; several sources are `[src:3fa2c1,9b02e4]`. Cite only ids you were given, \
and only for what that source says. Keep the markers when you hand a result \
back to another agent. Don't add a list of sources at the end: the chat builds it."""


def citations_prompt(context: PromptContext) -> str:
    """The citing block for this run. Empty when no tool hands out source ids."""
    if not context.has_source_tools:
        return ""
    return f"{_HEADER}\n\n{_BODY}"


__all__ = ["citations_prompt"]
