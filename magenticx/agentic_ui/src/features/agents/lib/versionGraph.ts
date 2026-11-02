import type { AgentVersionSummary } from "@/shared/lib/types";

/**
 * The History tab's version graph: each version is a dot in a lane, joined to
 * the version it was saved on top of. Two saves on top of one version (edit,
 * restore it, edit again) are two branches that meet at it.
 *
 * Laid out like `git log --graph`, newest row first: a lane waits for the
 * version it leads down to; a row nobody waits for starts a lane of its own
 * (a branch tip); every lane waiting for a row ends in it.
 */

/** One row's slice of the graph. Lanes are columns, 0 on the left. */
export type GraphRow = {
  /** The lane this version's dot sits in. */
  lane: number;
  /** Lanes that come in from above and end in this dot (its own lane included when it continues one). */
  joins: number[];
  /** Lanes that pass by this row untouched, top to bottom. */
  through: number[];
  /** Whether a line leaves the dot downwards, to the version it was based on. */
  down: boolean;
};

export type VersionGraph = { rows: GraphRow[]; lanes: number };

/**
 * The version a row leads down to: its `basedOn` while that is kept; a row
 * from before `basedOn` was recorded follows the one listed below it; the
 * first version (created, or the baseline) leads nowhere.
 */
export const parentOf = (
  versions: AgentVersionSummary[],
  index: number,
): number | null => {
  const version = versions[index];
  if (version.basedOn !== null) {
    return versions.some((v) => v.versionNo === version.basedOn) ? version.basedOn : null;
  }
  if (version.kind === "created" || version.kind === "baseline") return null;
  return versions[index + 1]?.versionNo ?? null;
};

/** The graph for versions listed newest first. */
export function layoutVersionGraph(versions: AgentVersionSummary[]): VersionGraph {
  // lanes[i] is the version lane i leads down to, or null when it is free.
  const lanes: (number | null)[] = [];
  let widest = 0;
  const rows = versions.map((version, index) => {
    const waiting = lanes.flatMap((want, i) => (want === version.versionNo ? [i] : []));
    let lane = waiting[0];
    if (lane === undefined) {
      const free = lanes.indexOf(null);
      lane = free >= 0 ? free : lanes.length;
    }
    const through = lanes.flatMap((want, i) =>
      want !== null && want !== version.versionNo ? [i] : [],
    );
    waiting.forEach((i) => (lanes[i] = null));
    const parent = parentOf(versions, index);
    lanes[lane] = parent;
    // A free lane at the right edge is no lane at all.
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    widest = Math.max(widest, lane + 1, ...through.map((i) => i + 1));
    return { lane, joins: waiting, through, down: parent !== null };
  });
  return { rows, lanes: widest };
}
