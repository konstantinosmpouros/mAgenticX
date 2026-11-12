/**
 * Inline citation markers (plan 42 §3.8) — the pure text side.
 *
 * The agent ends a sentence it took from a search result with a marker such as
 * `[src:3fa2c1]`, or `[src:3fa2c1,9b02e4]` for several sources. The chat turns
 * markers into citation pills (`remarkCitations`), and Copy turns them into
 * numbered references (`features/chat/lib/citationText`). Both read markers
 * through this module so they agree on what one is.
 */

/** The marker grammar of the contract; the capture is the id list. */
export const CITATION_MARKER_SOURCE = String.raw`\[src:\s*([0-9a-f]{6,8}(?:\s*,\s*[0-9a-f]{6,8})*)\s*\]`;

/** A fresh global matcher (a shared `/g` regex would carry `lastIndex` between callers). */
export function citationMarkerPattern(): RegExp {
  return new RegExp(CITATION_MARKER_SOURCE, "g");
}

/** The ids of one marker's capture, in order, without repeats. */
export function parseCitationIds(capture: string): string[] {
  const ids = capture
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return [...new Set(ids)];
}

/** The site a pill names: the URL's host without `www.`; "" when it is not a URL. */
export function citationHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

// What the end of a still-streaming answer looks like while a marker is being
// written: `[`, `[s`, `[sr`, `[src`, `[src:3f`, `[src:3fa2c1, 9b`.
const UNCLOSED_MARKER_AT_END = /\[(?:s(?:r(?:c(?::[\s0-9a-f,]*)?)?)?)?$/;
const FENCE_LINE = /^ {0,3}(?:`{3,}|~{3,})/;

/** Whether the text ends inside a fenced code block or an inline code span. */
function endsInsideCode(text: string): boolean {
  const lines = text.split("\n");
  const fences = lines.filter((line) => FENCE_LINE.test(line)).length;
  if (fences % 2 === 1) return true;
  const lastLine = lines[lines.length - 1] ?? "";
  return (lastLine.match(/`/g)?.length ?? 0) % 2 === 1;
}

/**
 * The streaming answer without a marker that has not closed yet, so the raw
 * `[src:3fa` never flickers on screen before it becomes a pill. Text inside an
 * open code block or span is left alone: a marker is never read there. Only
 * for text that is still arriving — the next chunk either closes the marker
 * (it renders as a pill) or shows it was ordinary text after all.
 */
export function hideUnclosedCitationMarker(text: string): string {
  const match = UNCLOSED_MARKER_AT_END.exec(text);
  if (!match || endsInsideCode(text)) return text;
  return text.slice(0, match.index).replace(/[ \t]+$/, "");
}

const INLINE_CODE = /(`+)[\s\S]*?\1/g;

/**
 * Replace every citation marker outside code with `replace(ids, leadingSpace)`.
 * The whitespace before a marker is handed to the replacer, so a marker that
 * resolves to nothing can drop it along with itself ("grew 12% [src:x]." →
 * "grew 12%."). Fenced blocks and inline code spans keep their text verbatim.
 */
export function replaceCitationMarkers(
  text: string,
  replace: (ids: string[], leadingSpace: string) => string,
): string {
  const marker = new RegExp(String.raw`([ \t]*)` + CITATION_MARKER_SOURCE, "g");
  const swap = (prose: string) =>
    prose.replace(marker, (_whole, space: string, capture: string) =>
      replace(parseCitationIds(capture), space),
    );
  const swapOutsideInlineCode = (prose: string) => {
    let out = "";
    let last = 0;
    for (const span of prose.matchAll(INLINE_CODE)) {
      const start = span.index ?? 0;
      out += swap(prose.slice(last, start)) + span[0];
      last = start + span[0].length;
    }
    return out + swap(prose.slice(last));
  };

  const out: string[] = [];
  let inFence = false;
  let prose: string[] = [];
  const flush = () => {
    if (prose.length) out.push(swapOutsideInlineCode(prose.join("\n")));
    prose = [];
  };
  for (const line of text.split("\n")) {
    if (FENCE_LINE.test(line)) {
      flush();
      inFence = !inFence;
      out.push(line);
    } else if (inFence) {
      out.push(line);
    } else {
      prose.push(line);
    }
  }
  flush();
  return out.join("\n");
}

/** Markdown / whitespace stripped for a one-glance snippet (a search result's
 *  excerpt is often a page's markdown: `## Background …`). */
export const plainSnippet = (text: string | undefined): string =>
  (text ?? "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#*_`>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
