"""The source extractors (plan 42): real tool results in, ids and marked content out.

Pinned against results recorded from the real tools on 2026-11-12
(``fixtures/sources/``) — exactly the ``ToolMessage.content`` string
langchain-mcp-adapters hands the agent:

* every page of a Tavily or arXiv result becomes a ``Source`` whose id is the
  first 6 hex of ``sha256(normalised URL)``, and the model sees ``[src:ID]``
  beside it (Tavily: before ``Title:``; arXiv: a ``cite`` first key);
* the URL normalisation of the contract (§3.8), and the 8-character id when
  two pages clash on 6 inside one result;
* untrusted input is contained: a non-http(s) URL is dropped, titles and
  snippets lose control characters and are capped;
* an unknown tool or unreadable content passes through untouched.
"""
from __future__ import annotations

import hashlib
import importlib
import json
from pathlib import Path

import pytest
from pydantic import ValidationError

FIXTURES = Path(__file__).parent / "fixtures" / "sources"


def _fixture(name: str) -> str:
    return (FIXTURES / f"{name}.txt").read_text(encoding="utf-8")


def _sha6(normalised: str) -> str:
    return hashlib.sha256(normalised.encode()).hexdigest()[:6]


@pytest.fixture
def sources(agents_service):
    return importlib.import_module("harness.sources")


@pytest.fixture
def extractors(agents_service):
    return importlib.import_module("harness.sources.extractors")


# ---------------------------------------------------------------------- Tavily
def test_a_tavily_search_result_names_every_page_and_marks_its_title(sources):
    content = _fixture("tavily-search")

    found, rewritten = sources.extract_sources("tavily-search", content)

    assert [s.url for s in found] == [
        "https://en.wikipedia.org/wiki/Greek_government-debt_crisis",
        "https://debtjustice.org.uk/countries-in-crisis/greek-debt-crisis-case-banks-people",
        "https://www.piie.com/microsites/2022/greek-debt-crisis-no-easy-way-out",
    ]
    # The id is the contract's: the normalised URL drops `www.`.
    assert found[2].id == _sha6("https://piie.com/microsites/2022/greek-debt-crisis-no-easy-way-out")
    assert all(s.tool == "tavily-search" for s in found)
    assert found[0].title == "Greek government-debt crisis - Wikipedia"
    assert found[0].snippet.startswith("In January 2010, the Greek Ministry of Finance")
    assert all(len(s.snippet) <= 300 for s in found)
    for source in found:
        assert f"[src:{source.id}] Title: {source.title}" in rewritten
    # Nothing else changed: removing the markers gives the original back.
    stripped = rewritten
    for source in found:
        stripped = stripped.replace(f"[src:{source.id}] ", "")
    assert stripped == content


def test_a_tavily_extract_result_without_a_summary_has_an_empty_snippet(sources):
    found, rewritten = sources.extract_sources("tavily-extract", _fixture("tavily-extract"))

    [page] = found
    assert page.url == "https://en.wikipedia.org/wiki/Greek_government-debt_crisis" and page.tool == "tavily-extract"
    assert page.snippet == ""  # Tavily writes `Content: undefined`; the raw page is no summary
    assert rewritten.startswith(f"Detailed Results:\n\n[src:{page.id}] Title: Greek government-debt crisis")


def test_tavily_crawl_reads_the_same_blocks(sources):
    block = "Title: Docs\nURL: https://docs.example.com/a/\nContent: undefined\nRaw Content: # Docs\n"
    [page], rewritten = sources.extract_sources("tavily-crawl", block)
    assert page.id == _sha6("https://docs.example.com/a") and rewritten.startswith(f"[src:{page.id}] Title: Docs")


def test_a_title_line_inside_a_page_is_not_taken_for_a_block(sources):
    content = (
        "Title: Real\nURL: https://a.example/x\nContent: text\nRaw Content: notes\n"
        "Title: not a result, just page text\nmore page text\n"
    )
    found, rewritten = sources.extract_sources("tavily-extract", content)
    assert [s.url for s in found] == ["https://a.example/x"]
    assert rewritten.count("[src:") == 1


def test_crlf_line_endings_are_kept(sources):
    content = "Title: A\r\nURL: https://a.example/\r\nContent: one\r\n"
    [page], rewritten = sources.extract_sources("tavily-search", content)
    assert rewritten == f"[src:{page.id}] {content}" and page.snippet == "one"


# ----------------------------------------------------------------------- arXiv
def test_an_arxiv_result_gets_a_cite_key_first_on_every_paper(sources):
    content = _fixture("search_papers")

    found, rewritten = sources.extract_sources("search_papers", content)

    assert [s.url for s in found] == ["https://arxiv.org/pdf/2610.00223v1", "https://arxiv.org/pdf/2610.24913v1"]
    assert found[0].title.startswith("A Holistic Assessment of the Carbon Footprint of Noor")
    assert found[0].snippet.startswith("As ever larger language models") and len(found[0].snippet) <= 300
    assert found[0].snippet.endswith("…")
    data = json.loads(rewritten)
    original = json.loads(content)
    for paper, before, source in zip(data["papers"], original["papers"], found):
        assert next(iter(paper)) == "cite" and paper["cite"] == f"[src:{source.id}]"
        assert {k: v for k, v in paper.items() if k != "cite"} == before
    assert data["total_results"] == original["total_results"]
    assert rewritten.startswith('{\n  "total_results": 2,')  # indent=2, as the server sends it


def test_a_paper_with_a_bad_url_is_left_uncited(sources):
    content = json.dumps({"papers": [
        {"title": "Good", "url": "https://arxiv.org/abs/1", "abstract": "a"},
        {"title": "Evil", "url": "javascript:alert(1)", "abstract": "b"},
        "not a paper",
    ]})
    found, rewritten = sources.extract_sources("search_papers", content)
    papers = json.loads(rewritten)["papers"]
    assert [s.title for s in found] == ["Good"]
    assert "cite" in papers[0] and "cite" not in papers[1] and papers[2] == "not a paper"


# ---------------------------------------------------------- pass-through cases
@pytest.mark.parametrize("tool, content", [
    ("read_file", "Title: X\nURL: https://a.example/\n"),       # no extractor
    ("search_papers", "not json at all"),                        # unreadable
    ("search_papers", json.dumps({"total_results": 0})),         # no papers
    ("tavily-search", "No results found."),                      # nothing to cite
    ("tavily-search", None),                                     # not content
])
def test_no_sources_means_the_content_is_untouched(sources, tool, content):
    assert sources.extract_sources(tool, content) == ([], content)


def test_a_bad_url_is_dropped_and_its_title_left_unmarked(sources):
    content = (
        "Title: Fine\nURL: https://ok.example/page\nContent: a\n\n"
        "Title: Script\nURL: javascript:alert(document.cookie)\nContent: b\n\n"
        "Title: Data\nURL: data:text/html,<script>x</script>\nContent: c\n\n"
        "Title: Creds\nURL: https://bank.example@evil.example/\nContent: d\n"
    )
    found, rewritten = sources.extract_sources("tavily-search", content)
    assert [s.title for s in found] == ["Fine"]
    assert "] Title: Script" not in rewritten and "] Title: Data" not in rewritten
    assert "] Title: Creds" not in rewritten


def test_content_blocks_are_read_text_by_text(sources):
    blocks = [
        {"type": "text", "text": "Title: A\nURL: https://a.example/\nContent: one\n"},
        {"type": "image", "url": "https://img.example/x.png"},
        {"type": "text", "text": "Title: A again\nURL: https://www.a.example\nContent: same page\n"},
    ]
    found, rewritten = sources.extract_sources("tavily-search", blocks)
    assert len(found) == 1  # the same page in two blocks is one source
    assert rewritten[1] == blocks[1]
    assert rewritten[0]["text"].startswith(f"[src:{found[0].id}] Title: A")
    assert rewritten[2]["text"].startswith(f"[src:{found[0].id}] Title: A again")


# -------------------------------------------------------------------- the ids
@pytest.mark.parametrize("url, normalised", [
    ("HTTPS://WWW.Example.COM/Path/?utm_source=x&b=2&UTM_medium=y#frag", "https://example.com/Path?b=2"),
    ("https://example.com", "https://example.com/"),
    ("https://example.com/", "https://example.com/"),
    ("https://example.com/a/", "https://example.com/a"),
    ("http://example.com:8080/a", "http://example.com:8080/a"),
    ("https://[2001:db8::1]/x", "https://[2001:db8::1]/x"),
])
def test_urls_normalise_as_the_contract_says(sources, url, normalised):
    assert sources.normalise_url(url) == normalised
    assert sources.source_id(url) == _sha6(normalised)


def test_the_same_page_gets_the_same_id_whatever_its_tracking(sources):
    a, _ = sources.extract_sources("tavily-search", "Title: A\nURL: https://www.example.com/a/?utm_campaign=z\n")
    b, _ = sources.extract_sources("tavily-search", "Title: A\nURL: https://example.com/a#top\n")
    assert a[0].id == b[0].id
    # The link the user opens keeps the page but loses the tracking.
    assert a[0].url == "https://www.example.com/a/"


def test_a_clash_on_six_characters_extends_both_ids_to_eight(sources):
    # Find two URLs whose 6-hex prefixes collide (a deterministic search).
    seen: dict[str, str] = {}
    pair: tuple[str, str] | None = None
    index = 0
    while pair is None:
        url = f"https://example.com/{index}"
        short = _sha6(url)
        if short in seen:
            pair = (seen[short], url)
        seen[short] = url
        index += 1
    ids = sources.assign_ids([pair[0], pair[1], pair[0], "https://other.example/"])
    assert len(ids[pair[0]]) == 8 and len(ids[pair[1]]) == 8 and ids[pair[0]] != ids[pair[1]]
    assert ids["https://other.example/"] == _sha6("https://other.example/")


def test_a_result_contributes_at_most_fifty_sources(sources, extractors):
    content = "".join(f"Title: P{i}\nURL: https://e.example/{i}\nContent: x\n\n" for i in range(60))
    found, rewritten = sources.extract_sources("tavily-crawl", content)
    assert len(found) == extractors.MAX_SOURCES_PER_RESULT == 50
    assert rewritten.count("[src:") == 50


# ------------------------------------------------------------ the Source model
def test_titles_and_snippets_are_made_safe_and_capped(sources):
    source = sources.Source(
        id="abc123", url="https://a.example/", tool="t" * 150,
        title="Hello‮evil\u0000\n\t  world", snippet="x " * 400,
    )
    assert source.title == "Hello evil world"
    assert len(source.snippet) == 300 and source.snippet.endswith("…")
    assert len(source.tool) == 100


@pytest.mark.parametrize("url", [
    "ftp://a.example/", "javascript:alert(1)", "https:///nohost", "https://a.example/" + "x" * 2048,
    "https://a.example/a b", "https://a.example:99999/", 42,
])
def test_a_url_that_is_not_a_plain_web_link_is_refused(sources, url):
    with pytest.raises(ValidationError):
        sources.Source(id="abc123", url=url)


@pytest.mark.parametrize("bad_id", ["ABC123", "abc12", "abc123456", "s-abc123", "zzzzzz"])
def test_an_id_outside_the_contract_is_refused(sources, bad_id):
    with pytest.raises(ValidationError):
        sources.Source(id=bad_id, url="https://a.example/")


def test_only_the_registered_tools_have_extractors(sources):
    assert set(sources.EXTRACTORS) == {"tavily-search", "tavily-extract", "tavily-crawl", "search_papers"}
    assert sources.has_extractor("tavily-search") and not sources.has_extractor("tavily-map")
    assert not sources.has_extractor(None)
    # Any MCP tool may cite: it is read generically.
    assert sources.has_extractor("brave_web_search", mcp=True)


# --------------------------------------------------------------------- generic
def test_a_new_mcp_server_s_json_results_are_cited_without_code(sources):
    content = json.dumps({"web": {"results": [
        {"link": "https://ecb.europa.eu/pub/a", "name": "ECB report", "summary": "Imbalances grew."},
        {"note": "no link here"},
        {"url": "javascript:alert(1)", "title": "bad"},
    ]}})
    found, rewritten = sources.extract_sources("brave_web_search", content, mcp=True)
    assert [(s.url, s.title, s.snippet, s.tool) for s in found] == [
        ("https://ecb.europa.eu/pub/a", "ECB report", "Imbalances grew.", "brave_web_search"),
    ]
    first = json.loads(rewritten)["web"]["results"][0]
    assert list(first)[0] == "cite" and first["cite"] == f"[src:{found[0].id}]"


def test_title_url_blocks_and_markdown_links_are_read_too(sources):
    blocks = "Title: Page A\nURL: https://a.example/x\nContent: about A\n"
    found, rewritten = sources.extract_sources("some_search", blocks, mcp=True)
    assert [s.url for s in found] == ["https://a.example/x"] and rewritten.startswith(f"[src:{found[0].id}] Title:")

    links = "See [The IMF note](https://www.imf.org/en/x) and [b](ftp://no)."
    found, rewritten = sources.extract_sources("other_search", links, mcp=True)
    assert [(s.title, s.url) for s in found] == [("The IMF note", "https://www.imf.org/en/x")]
    assert f"(https://www.imf.org/en/x) [src:{found[0].id}]" in rewritten


def test_a_non_mcp_tool_or_a_result_without_pages_is_left_alone(sources):
    content = "[x](https://a.example/)"
    assert sources.extract_sources("read_file", content) == ([], content)
    assert sources.extract_sources("an_mcp_tool", "just text", mcp=True) == ([], "just text")
