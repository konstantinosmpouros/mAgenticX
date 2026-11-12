"""Citation markers in stored answer text, turned into numbered references (plan 42).

An answer cites its sources with markers such as ``[src:3fa2c1]`` or
``[src:3fa2c1,9b02e4]``; the chat turns them into inline citation pills. A
document that leaves the chat (the PDF export) has no pills, so the markers
become ``[1]``, ``[2]`` — numbered by first appearance across everything
exported — with one list of the cited sources at the end. Ids the conversation
does not know are removed, never printed: a marker is only as good as the
source behind it. Markers inside code are left as written.
"""
from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass

from schema import ConversationSource

#: The marker the agent writes (shared contract with the agents service and the UI).
CITATION_RE = re.compile(r"[ \t]*\[src:\s*([0-9a-f]{6,8}(?:\s*,\s*[0-9a-f]{6,8})*)\s*\]")

#: Fenced code blocks and inline code spans, which keep their markers as written.
_CODE_RE = re.compile(r"```.*?(?:```|$)|`[^`\n]*`", re.DOTALL)


@dataclass(frozen=True)
class CitedSource:
    """One entry of the exported reference list."""

    number: int
    title: str
    url: str


def has_citation_markers(texts: Iterable[str | None]) -> bool:
    """Whether any of the texts carries a marker — the export only fetches sources then."""
    return any(text and CITATION_RE.search(text) for text in texts)


def number_citations(
    texts: list[str], sources: Mapping[str, ConversationSource]
) -> tuple[list[str], list[CitedSource]]:
    """Replace every marker with numbered references and list what they point to.

    Numbers follow first appearance across ``texts`` in order, so a source cited
    by several messages keeps one number. Unknown ids are dropped; a marker
    with no known id disappears together with the space before it.
    """
    numbers: dict[str, int] = {}
    cited: list[CitedSource] = []

    def replace_markers(segment: str) -> str:
        def one(match: re.Match[str]) -> str:
            refs: list[int] = []
            for raw in match.group(1).split(","):
                source_id = raw.strip()
                source = sources.get(source_id)
                if source is None:
                    continue
                if source_id not in numbers:
                    numbers[source_id] = len(numbers) + 1
                    cited.append(CitedSource(numbers[source_id], source.title or source.url, source.url))
                if numbers[source_id] not in refs:
                    refs.append(numbers[source_id])
            return f" [{', '.join(str(n) for n in refs)}]" if refs else ""

        return CITATION_RE.sub(one, segment)

    out: list[str] = []
    for text in texts:
        parts: list[str] = []
        last = 0
        for code in _CODE_RE.finditer(text):
            parts.append(replace_markers(text[last:code.start()]))
            parts.append(code.group(0))
            last = code.end()
        parts.append(replace_markers(text[last:]))
        out.append("".join(parts))
    return out, cited


__all__ = ["CITATION_RE", "CitedSource", "has_citation_markers", "number_citations"]
