// ------------------------------------------------------
// Inline citations (plan 42)
// ------------------------------------------------------
// Inferred from its Zod schema (see `../schemas`) so the wire contract and the
// type cannot drift.
import type { CitationSource } from "../schemas";

export type { CitationSource };

/** Every source a conversation may cite, by source id. */
export type CitationSourceMap = ReadonlyMap<string, CitationSource>;
