/**
 * The builder's names and ids, checked the way the engine checks them
 * (`agents/harness/workflows/spec.py`), so a bad one is caught as it is typed.
 */

/** A node id: a letter first, then letters, digits, `_` or `-` (≤ 64). No dots: templates split on them. */
export const NODE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
/** An edge id. */
export const EDGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
/** An input or state field name: an identifier (≤ 64). */
export const FIELD_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** A branch (a router case's name): lower-case identifier (≤ 32). */
export const BRANCH_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
/** Names the engine keeps for itself: no input, state field or node may take one. */
export const RESERVED_NAMES: ReadonlySet<string> = new Set([
  "input",
  "nodes",
  "iterations",
  "trace",
  "state",
  "output",
]);

export const isValidNodeId = (id: string): boolean => NODE_ID_PATTERN.test(id);

/** Why a node id cannot be used, or null when it can. `taken` excludes the node's own id. */
export function nodeIdProblem(id: string, taken: ReadonlySet<string>): string | null {
  if (!id) return "The id can't be empty.";
  if (!NODE_ID_PATTERN.test(id)) {
    return "Start with a letter; then letters, digits, _ or - (up to 64).";
  }
  if (RESERVED_NAMES.has(id)) return `'${id}' is reserved.`;
  if (taken.has(id)) return `Another node is already called '${id}'.`;
  return null;
}

/** The id stem a new node of `kind` starts from: `trigger.manual` → `trigger`, `fetch` → `fetch`. */
export function idStem(kind: string): string {
  const head = kind.split(".")[0] ?? "";
  const cleaned = head.replace(/[^A-Za-z0-9_-]/g, "");
  const stem = /^[A-Za-z]/.test(cleaned) ? cleaned : `node${cleaned}`;
  return RESERVED_NAMES.has(stem) ? `${stem}_node` : stem.slice(0, 56) || "node";
}

/** The first free id from `stem`: `fetch`, then `fetch_2`, `fetch_3`, … */
export function uniqueId(stem: string, taken: ReadonlySet<string>): string {
  if (!taken.has(stem) && !RESERVED_NAMES.has(stem)) return stem;
  for (let n = 2; ; n += 1) {
    const candidate = `${stem}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** A fresh node id for a kind. */
export const newNodeId = (kind: string, taken: ReadonlySet<string>): string =>
  uniqueId(idStem(kind), taken);

/** A fresh edge id: `e1`, `e2`, … — the first not taken. */
export function newEdgeId(taken: ReadonlySet<string>): string {
  for (let n = taken.size + 1; ; n += 1) {
    const candidate = `e${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** A fresh router case name: `case_1`, `case_2`, … */
export function newCaseName(taken: ReadonlySet<string>): string {
  for (let n = 1; ; n += 1) {
    const candidate = `case_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * The DOM id of a field in the inspector, so an issue picked from the list
 * can focus it: `nodeId` null is the workflow's own settings. `field` is the
 * issue's field (`config.url`, `inputs[0].name`).
 */
export const fieldDomId = (nodeId: string | null, field: string): string =>
  `wf-${nodeId ?? "$workflow"}-${field}`.replace(/[^A-Za-z0-9_-]/g, "_");
