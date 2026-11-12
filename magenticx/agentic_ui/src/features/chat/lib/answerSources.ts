/**
 * The sources of one answer (plan 42) — what the answer's Sources panel lists.
 *
 * An answer is a group of assistant messages (lib/answerGroups). Its sources
 * fall in two parts:
 *
 * 1. the ones its text points at: the ids of the `[src:…]` markers in every
 *    member's content (code excluded, as for the pills), in order of first
 *    appearance, resolved against the conversation's registry — an id the
 *    registry does not know is dropped, as the pill drops it;
 * 2. "More": every other source the group's runs found (the union of the
 *    `SOURCES` events in the members' event logs), in the order found.
 *
 * Both lists are http(s) only and free of repeats (by id, and by URL across
 * the two parts).
 */
import { replaceCitationMarkers } from "@/shared/lib/citations";
import { isHttpUrl } from "@/shared/lib/schemas";
import type { CitationSource, CitationSourceMap, MessageOut } from "@/shared/lib/types";
import { messageSources } from "./sources";

export type AnswerSources = {
  /** Sources the answer's text points at, in order of first appearance. */
  cited: CitationSource[];
  /** The other sources the answer's runs found. */
  more: CitationSource[];
};

/** The marker ids in the texts, in order of first appearance, without repeats. */
export function markerIds(texts: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    replaceCitationMarkers(text, (ids) => {
      for (const id of ids) seen.add(id);
      return "";
    });
  }
  return [...seen];
}

type SourceList = Iterable<CitationSource> | Record<string, CitationSource> | null | undefined;

function listOf(list: SourceList): Iterable<CitationSource> {
  if (!list) return [];
  if (Symbol.iterator in list) return list as Iterable<CitationSource>;
  return Object.values(list);
}

/**
 * Split an answer's sources into the ones its text points at and the rest.
 *
 * `found` are the lists the answer's runs gathered (one per member, say);
 * `registry` is the conversation's source map the markers resolve against.
 * A marker id missing from the registry still resolves when a run of this
 * answer found it.
 */
export function splitAnswerSources(
  texts: readonly (string | null | undefined)[],
  registry: CitationSourceMap,
  found: readonly SourceList[],
): AnswerSources {
  const foundById = new Map<string, CitationSource>();
  for (const list of found) {
    for (const source of listOf(list)) {
      if (!foundById.has(source.id)) foundById.set(source.id, source);
    }
  }

  const ids = new Set<string>();
  const urls = new Set<string>();
  const cited: CitationSource[] = [];
  for (const id of markerIds(texts)) {
    const source = registry.get(id) ?? foundById.get(id);
    if (!source || !isHttpUrl(source.url) || urls.has(source.url)) continue;
    ids.add(source.id);
    urls.add(source.url);
    cited.push(source);
  }

  const more: CitationSource[] = [];
  for (const source of foundById.values()) {
    if (ids.has(source.id) || urls.has(source.url) || !isHttpUrl(source.url)) continue;
    ids.add(source.id);
    urls.add(source.url);
    more.push(source);
  }
  return { cited, more };
}

/** An answer group's sources, from its members' texts and event logs. */
export function answerSources(
  members: readonly MessageOut[],
  registry: CitationSourceMap,
  extra: readonly SourceList[] = [],
): AnswerSources {
  return splitAnswerSources(
    members.map((member) => member.content),
    registry,
    [...members.map(messageSources), ...extra],
  );
}
