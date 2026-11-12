/**
 * Citations as plain text (plan 42 §3.6) — what Copy puts on the clipboard.
 *
 * Pills only exist on screen. In copied text each `[src:…]` marker becomes a
 * numbered reference, `[1]` or `[1, 2]`, numbered in order of first
 * appearance, and a "Sources:" list closes the text:
 *
 *     Revenue grew 12% [1].
 *
 *     Sources:
 *     1. Q3 results — https://example.com/q3
 *
 * An id the conversation has no source for is removed, and a marker left with
 * no known id disappears together with the space before it — the same rule
 * the pills follow, so nothing invented reaches the clipboard. Markers inside
 * code are left as they are.
 */
import { replaceCitationMarkers } from "@/shared/lib/citations";
import { isHttpUrl } from "@/shared/lib/schemas";
import type { CitationSource, CitationSourceMap } from "@/shared/lib/types";

export function citationsToPlainText(text: string, sources: CitationSourceMap): string {
  const numbers = new Map<string, number>();
  const cited: CitationSource[] = [];

  const body = replaceCitationMarkers(text, (ids, space) => {
    const refs: number[] = [];
    for (const id of ids) {
      const source = sources.get(id);
      if (!source || !isHttpUrl(source.url)) continue;
      let n = numbers.get(id);
      if (n === undefined) {
        n = cited.length + 1;
        numbers.set(id, n);
        cited.push(source);
      }
      if (!refs.includes(n)) refs.push(n);
    }
    return refs.length ? `${space || " "}[${refs.join(", ")}]` : "";
  });

  if (!cited.length) return body;
  const list = cited.map((source, index) =>
    source.title ? `${index + 1}. ${source.title} — ${source.url}` : `${index + 1}. ${source.url}`,
  );
  return `${body.trimEnd()}\n\nSources:\n${list.join("\n")}`;
}
