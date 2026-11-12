/**
 * The conversation's source registry (plan 42 §3.6–3.7) — pure helpers.
 *
 * A citation marker resolves against every source the conversation's tools
 * returned. Those come from four places, merged into one map by id:
 *
 * 1. the durable list the bridge serves for the conversation (sources of runs
 *    the client never streamed: background tasks, other sessions, a reload);
 * 2. the `SOURCES` events in the event logs of the settled messages on screen;
 * 3. the timelines of the background tasks this tab is folding (plan 41);
 * 4. the live run's timeline — so a pill lights up the moment its marker
 *    streams in, before the durable list knows the source.
 *
 * A source's id is a hash of its URL, so the same id from two places is the
 * same page; the later place simply wins.
 */
import { collectRunSources } from "@/features/inference";
import type {
  CitationSource,
  CitationSourceMap,
  MessageOut,
  RunTimeline,
} from "@/shared/lib/types";

type SourceList = Iterable<CitationSource> | Record<string, CitationSource> | null | undefined;

function entries(list: SourceList): Iterable<CitationSource> {
  if (!list) return [];
  if (Symbol.iterator in list) return list as Iterable<CitationSource>;
  return Object.values(list);
}

/** One map from several lists, later lists winning on the same id. */
export function mergeSources(...lists: SourceList[]): Map<string, CitationSource> {
  const merged = new Map<string, CitationSource>();
  for (const list of lists) {
    for (const source of entries(list)) merged.set(source.id, source);
  }
  return merged;
}

// A settled message's log never changes once persisted, so its sources are
// read once per log (keyed by the array's identity), not on every render.
const settledCache = new WeakMap<object, Record<string, CitationSource>>();

/** The sources one settled message's event log carries. */
export function messageSources(message: MessageOut): Record<string, CitationSource> {
  const events = message.rawEvents;
  if (!Array.isArray(events) || !events.length) return {};
  const cached = settledCache.get(events);
  if (cached) return cached;
  const found = collectRunSources(events);
  settledCache.set(events, found);
  return found;
}

/** The sources a folded timeline gathered (live run or background task). */
export function timelineSources(
  timeline: Pick<RunTimeline, "sources"> | null | undefined,
): Record<string, CitationSource> {
  return timeline?.sources ?? {};
}

export type SourceRegistryInput = {
  durable?: readonly CitationSource[] | null;
  messages?: readonly MessageOut[] | null;
  /** Folded timelines whose sources count too: background tasks, then the live run. */
  timelines?: readonly (Pick<RunTimeline, "sources"> | null | undefined)[];
};

/** Every source the conversation may cite, by id. */
export function buildSourceRegistry({
  durable,
  messages,
  timelines,
}: SourceRegistryInput): CitationSourceMap {
  return mergeSources(
    durable,
    ...(messages ?? []).map(messageSources),
    ...(timelines ?? []).map(timelineSources),
  );
}

/** Whether two registries hold the same sources (so a re-merge can keep the old map). */
export function sameRegistry(a: CitationSourceMap, b: CitationSourceMap): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [id, source] of a) {
    const other = b.get(id);
    if (
      !other ||
      other.url !== source.url ||
      other.title !== source.title ||
      other.snippet !== source.snippet
    ) {
      return false;
    }
  }
  return true;
}
