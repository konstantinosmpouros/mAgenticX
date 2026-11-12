"""The extractor registry: which tools return citable sources, and how to read them.

One entry per tool name: ``tool name → extractor(content) → (sources, rewritten
content)``. An extractor reads a tool's result exactly as the model would get
it, picks out each web page (URL, title, snippet), gives it an id, and rewrites
the result so the model sees that id next to the page (plan 42 §3.8):

* **Tavily** (``tavily-search``, ``tavily-extract``, ``tavily-crawl``) answers
  text blocks — ``Title: …`` / ``URL: …`` / ``Content: …`` (and
  ``Raw Content: …`` for extract and crawl). Each block's ``Title:`` line
  becomes ``[src:ID] Title: …``.
* **arXiv** (``search_papers``) answers JSON with a ``papers`` list; each paper
  with a usable ``url`` gets ``"cite": "[src:ID]"`` as its first key, and the
  JSON is written back with ``indent=2``.

Any other MCP tool is read by :func:`extract_generic` (JSON objects with a link,
``Title:``/``URL:`` blocks, markdown links), so a newly installed search server
cites without code. A tool whose result those miss gets its own extractor:
one function here and one line in :data:`EXTRACTORS`,
plus a test against a recorded real result of the tool
(``tests/agents/fixtures/sources/``).

Everything here is pure and total in the caller's eyes: a tool without an
extractor, or a result the extractor cannot read (an upstream format change),
comes back with no sources and its content unchanged, so the answer still works
— uncited. Only the counts are logged, never a URL or snippet.
"""
from __future__ import annotations

import json
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from functools import partial
from types import MappingProxyType
from typing import Any

from pydantic import ValidationError

from core.logging import get_logger
from harness.sources.ids import assign_ids, normalise_url
from harness.sources.model import MAX_SNIPPET_CHARS, Source, clean_url

logger = get_logger(__name__)

#: ``content -> (sources, rewritten content)``; see the module docstring.
Extractor = Callable[[str], tuple[list[Source], str]]

#: Most sources one tool result may contribute. A crawl can list hundreds of
#: pages; past this many the rest stay in the result, uncited.
MAX_SOURCES_PER_RESULT = 50

#: How much of a Tavily ``Content:`` section is read for the snippet. The
#: snippet is cut to 300 characters anyway; this bounds the work on a huge page.
_SNIPPET_SCAN_CHARS = 4 * MAX_SNIPPET_CHARS

_TITLE = "Title:"
_URL = "URL:"
_CONTENT = "Content:"
_RAW_CONTENT = "Raw Content:"
#: What Tavily writes as ``Content:`` when it has no summary (extract, crawl).
_NO_CONTENT = "undefined"


def marker(source_id: str) -> str:
    """The marker that names a source, in a tool result and in the answer."""
    return f"[src:{source_id}]"


@dataclass(frozen=True)
class _Found:
    """A page an extractor saw, before validation and ids."""

    url: str
    title: str
    snippet: str


def _resolve(tool: str, found: list[_Found]) -> list[Source | None]:
    """A :class:`Source` for each page found, or ``None`` where it was dropped.

    A page is dropped when its URL is not a safe ``http(s)`` link, or past the
    first :data:`MAX_SOURCES_PER_RESULT` distinct pages. Ids are assigned over
    the kept pages together, so a clash inside this result is extended to 8.
    """
    cleaned: list[tuple[str, str] | None] = []  # (clean URL, normalised URL)
    distinct: dict[str, None] = {}
    for page in found:
        try:
            url = clean_url(page.url)
            normalised = normalise_url(url)
        except ValueError:
            cleaned.append(None)
            continue
        if normalised not in distinct and len(distinct) >= MAX_SOURCES_PER_RESULT:
            cleaned.append(None)
            continue
        distinct[normalised] = None
        cleaned.append((url, normalised))
    ids = assign_ids(distinct)
    resolved: list[Source | None] = []
    for page, kept in zip(found, cleaned):
        if kept is None:
            resolved.append(None)
            continue
        url, normalised = kept
        try:
            resolved.append(Source(id=ids[normalised], url=url, title=page.title, snippet=page.snippet, tool=tool))
        except ValidationError:
            resolved.append(None)
    dropped = sum(source is None for source in resolved)
    if dropped:
        logger.info("sources_dropped", "Left tool-result pages uncited", tool=tool, dropped=dropped)
    return resolved


def _unique(sources: list[Source | None]) -> list[Source]:
    """The distinct sources, in the order the result first names them."""
    seen: dict[str, Source] = {}
    for source in sources:
        if source is not None and source.id not in seen:
            seen[source.id] = source
    return list(seen.values())


# --------------------------------------------------------------------- Tavily
def _tavily_snippet(lines: list[str]) -> str:
    """The text of a block's ``Content:`` section, or "" when Tavily had none."""
    parts: list[str] = []
    size = 0
    in_content = False
    for line in lines:
        if line.startswith(_RAW_CONTENT):
            break
        if line.startswith(_CONTENT):
            in_content = True
            line = line[len(_CONTENT):]
        if in_content:
            parts.append(line.strip())
            size += len(line)
            if size >= _SNIPPET_SCAN_CHARS:
                break
    text = " ".join(part for part in parts if part)
    return "" if text == _NO_CONTENT else text


def extract_tavily(content: str, *, tool: str) -> tuple[list[Source], str]:
    """Sources of a Tavily text result; each ``Title:`` line gets its marker.

    A block starts at a ``Title:`` line directly followed by a ``URL:`` line —
    both, so a page whose own text holds a line starting ``Title:`` is never
    taken for a block. Line endings are kept as they came.
    """
    lines = content.splitlines(keepends=True)
    starts = [
        index for index in range(len(lines) - 1)
        if lines[index].startswith(_TITLE) and lines[index + 1].startswith(_URL)
    ]
    found: list[_Found] = []
    for position, start in enumerate(starts):
        end = starts[position + 1] if position + 1 < len(starts) else len(lines)
        found.append(_Found(
            url=lines[start + 1][len(_URL):].strip(),
            title=lines[start][len(_TITLE):].strip(),
            snippet=_tavily_snippet(lines[start + 2:end]),
        ))
    resolved = _resolve(tool, found)
    for start, source in zip(starts, resolved):
        if source is not None:
            lines[start] = f"{marker(source.id)} {lines[start]}"
    sources = _unique(resolved)
    return sources, ("".join(lines) if sources else content)


# ---------------------------------------------------------------------- arXiv
def extract_papers(content: str, *, tool: str) -> tuple[list[Source], str]:
    """Sources of an arXiv ``search_papers`` result; each paper gets a ``cite`` key.

    ``cite`` goes first so the model reads the id before the paper. The JSON
    is re-serialised with ``indent=2`` (the shape the server sends) and
    ``ensure_ascii=False`` (an accented author costs one token, not six).
    """
    data = json.loads(content)
    papers = data.get("papers") if isinstance(data, dict) else None
    if not isinstance(papers, list):
        return [], content
    entries = [paper for paper in papers if isinstance(paper, dict)]
    resolved = _resolve(tool, [
        _Found(url=paper.get("url"), title=paper.get("title") or "", snippet=paper.get("abstract") or "")
        for paper in entries
    ])
    by_paper = {id(paper): source for paper, source in zip(entries, resolved)}
    sources = _unique(resolved)
    if not sources:
        return [], content
    rewritten: list[Any] = []
    for paper in papers:
        source = by_paper.get(id(paper)) if isinstance(paper, dict) else None
        if source is None:
            rewritten.append(paper)
            continue
        rewritten.append({"cite": marker(source.id), **{key: value for key, value in paper.items() if key != "cite"}})
    return sources, json.dumps({**data, "papers": rewritten}, indent=2, ensure_ascii=False)


# -------------------------------------------------------------------- generic
#: Keys that hold a page's link, title and summary in the JSON most search
#: servers answer. The first one present wins.
_URL_KEYS = ("url", "link", "href", "source_url", "sourceUrl", "page_url", "pdf_url")
_TITLE_KEYS = ("title", "name", "headline", "page_title")
_SNIPPET_KEYS = ("snippet", "description", "summary", "abstract", "content", "text", "excerpt")
#: How deep the generic reader walks a JSON result looking for pages.
_MAX_JSON_DEPTH = 6
#: A markdown link to a web page: ``[title](https://…)``.
_MARKDOWN_LINK = re.compile(r"\[([^\]\n]{1,300})\]\((https?://[^\s)]{1,2048})\)")


def _first_text(entry: Mapping[str, Any], keys: tuple[str, ...]) -> str:
    """The first non-empty string among ``keys`` in ``entry``, else ""."""
    for key in keys:
        value = entry.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return ""


def _json_pages(node: Any, depth: int, out: list[dict[str, Any]]) -> None:
    """Collect every object that names a web page (an http(s) link), depth-first."""
    if depth > _MAX_JSON_DEPTH:
        return
    if isinstance(node, dict):
        link = _first_text(node, _URL_KEYS)
        if link.startswith(("http://", "https://")):
            out.append(node)
            return
        for value in node.values():
            _json_pages(value, depth + 1, out)
    elif isinstance(node, list):
        for value in node:
            _json_pages(value, depth + 1, out)


def _extract_generic_json(content: str, *, tool: str) -> tuple[list[Source], str]:
    """A JSON result: each object with a link gets ``"cite": "[src:ID]"`` first."""
    data = json.loads(content)
    pages: list[dict[str, Any]] = []
    _json_pages(data, 0, pages)
    if not pages:
        return [], content
    resolved = _resolve(tool, [
        _Found(url=_first_text(page, _URL_KEYS), title=_first_text(page, _TITLE_KEYS),
               snippet=_first_text(page, _SNIPPET_KEYS)[:_SNIPPET_SCAN_CHARS])
        for page in pages
    ])
    by_page = {id(page): source for page, source in zip(pages, resolved)}
    sources = _unique(resolved)
    if not sources:
        return [], content

    def cite(node: Any, depth: int) -> Any:
        if depth > _MAX_JSON_DEPTH:
            return node
        if isinstance(node, dict):
            source = by_page.get(id(node))
            if source is not None:
                return {"cite": marker(source.id), **{key: value for key, value in node.items() if key != "cite"}}
            return {key: cite(value, depth + 1) for key, value in node.items()}
        if isinstance(node, list):
            return [cite(value, depth + 1) for value in node]
        return node

    return sources, json.dumps(cite(data, 0), indent=2, ensure_ascii=False)


def _extract_markdown_links(content: str, *, tool: str) -> tuple[list[Source], str]:
    """Markdown links to web pages: each gets its marker right after it."""
    matches = list(_MARKDOWN_LINK.finditer(content))
    if not matches:
        return [], content
    resolved = _resolve(tool, [_Found(url=match.group(2), title=match.group(1), snippet="") for match in matches])
    sources = _unique(resolved)
    if not sources:
        return [], content
    parts: list[str] = []
    last = 0
    for match, source in zip(matches, resolved):
        parts.append(content[last:match.end()])
        if source is not None:
            parts.append(f" {marker(source.id)}")
        last = match.end()
    parts.append(content[last:])
    return sources, "".join(parts)


def extract_generic(content: str, *, tool: str) -> tuple[list[Source], str]:
    """Sources of a result from a search tool with no extractor of its own.

    For any MCP tool (a newly installed search server needs no code here), in
    order: JSON objects carrying a link (``url`` / ``link`` / …), then
    Tavily-style ``Title:`` / ``URL:`` blocks, then markdown links. The first
    reading that finds a page wins; none → no sources, content unchanged.
    """
    stripped = content.lstrip()
    if stripped[:1] in ("{", "["):
        try:
            return _extract_generic_json(content, tool=tool)
        except ValueError:
            pass  # Not JSON after all: read it as text.
    sources, rewritten = extract_tavily(content, tool=tool)
    if sources:
        return sources, rewritten
    return _extract_markdown_links(content, tool=tool)


#: tool name → extractor. The one place a source tool is declared.
EXTRACTORS: Mapping[str, Extractor] = MappingProxyType({
    "tavily-search": partial(extract_tavily, tool="tavily-search"),
    "tavily-extract": partial(extract_tavily, tool="tavily-extract"),
    "tavily-crawl": partial(extract_tavily, tool="tavily-crawl"),
    "search_papers": partial(extract_papers, tool="search_papers"),
})


def has_extractor(tool_name: Any, *, mcp: bool = False) -> bool:
    """Whether ``tool_name`` may return citable sources: a tool with its own
    extractor, or any MCP tool (read by :func:`extract_generic`)."""
    return isinstance(tool_name, str) and (mcp or tool_name in EXTRACTORS)


def _extract_text(extractor: Extractor, tool_name: str, text: str) -> tuple[list[Source], str]:
    """One extractor run that never raises: unreadable means uncited."""
    try:
        return extractor(text)
    except (ValueError, TypeError, KeyError, AttributeError, RecursionError) as exc:
        # ValueError covers json.JSONDecodeError: an upstream format change.
        logger.warning("sources_extract_failed", "Could not read sources from a tool result",
                       tool=tool_name, error_type=type(exc).__name__)
        return [], text


def extract_sources(tool_name: Any, content: Any, *, mcp: bool = False) -> tuple[list[Source], Any]:
    """The sources in one tool result and the content the model should see.

    ``content`` is a ``ToolMessage.content``: a string, or a list of content
    blocks, whose text blocks are read one by one (anything else in the list
    passes through). A tool with its own extractor uses it; any other MCP tool
    (``mcp``) is read generically. Anything else, or content of another shape,
    comes back unchanged with no sources.
    """
    extractor = EXTRACTORS.get(tool_name) if isinstance(tool_name, str) else None
    if extractor is None and mcp and isinstance(tool_name, str):
        extractor = partial(extract_generic, tool=tool_name[:100])
    if extractor is None:
        return [], content
    if isinstance(content, str):
        return _extract_text(extractor, tool_name, content)
    if not isinstance(content, list):
        return [], content
    sources: dict[str, Source] = {}
    blocks: list[Any] = []
    for block in content:
        if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str):
            found, text = _extract_text(extractor, tool_name, block["text"])
            for source in found:
                sources.setdefault(source.id, source)
            blocks.append({**block, "text": text} if found else block)
        else:
            blocks.append(block)
    if not sources:
        return [], content
    return list(sources.values()), blocks


__all__ = [
    "EXTRACTORS",
    "MAX_SOURCES_PER_RESULT",
    "Extractor",
    "extract_generic",
    "extract_papers",
    "extract_sources",
    "extract_tavily",
    "has_extractor",
    "marker",
]
