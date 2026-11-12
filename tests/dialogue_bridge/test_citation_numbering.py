"""Plan 42: an exported document prints citation markers as numbered references."""
from __future__ import annotations

from schema import ConversationSource
from utils.citations import has_citation_markers, number_citations

SOURCES = {
    "3fa2c1": ConversationSource(id="3fa2c1", url="https://example.com/a", title="Page A", snippet="", tool="tavily-search"),
    "9b02e4": ConversationSource(id="9b02e4", url="https://example.org/b", title="Page B", snippet="", tool="tavily-search"),
}


def test_markers_become_numbers_by_first_appearance_across_messages():
    texts, cited = number_citations(
        ["Grew 12% [src:9b02e4].", "Both agree [src:3fa2c1, 9b02e4]."], SOURCES
    )
    assert texts == ["Grew 12% [1].", "Both agree [2, 1]."]
    assert [(c.number, c.title, c.url) for c in cited] == [
        (1, "Page B", "https://example.org/b"),
        (2, "Page A", "https://example.com/a"),
    ]


def test_unknown_ids_are_dropped_never_printed():
    texts, cited = number_citations(["Made up [src:abcdef]. Real [src:abcdef,3fa2c1]."], SOURCES)
    assert texts == ["Made up. Real [1]."]
    assert len(cited) == 1


def test_markers_in_code_stay_as_written():
    text = "Use `[src:3fa2c1]` literally.\n```\n[src:9b02e4]\n```\nDone [src:3fa2c1]."
    texts, _ = number_citations([text], SOURCES)
    assert texts == ["Use `[src:3fa2c1]` literally.\n```\n[src:9b02e4]\n```\nDone [1]."]


def test_detects_markers_only_when_present():
    assert has_citation_markers(["no markers", None, "one [src:3fa2c1]"])
    assert not has_citation_markers(["plain", None, "[src:XYZ]"])
