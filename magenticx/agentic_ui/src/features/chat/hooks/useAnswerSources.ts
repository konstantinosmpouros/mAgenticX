import { useMemo } from "react";

import { answerSources, type AnswerSources } from "@/features/chat/lib/answerSources";
import { useCitationSources } from "@/shared/lib/citations-context";
import type { CitationSource, MessageOut } from "@/shared/lib/types";

/**
 * The sources of one answer group (lib/answerSources) — what its Sources
 * panel lists and whether the action bar offers it. `timelineSources` are the
 * sources of the bar's own message as its folded timeline knows them, so an
 * answer that just finished counts its sources before its log is reloaded.
 */
export function useAnswerSources(
  members: readonly MessageOut[],
  timelineSources?: Record<string, CitationSource> | null,
): AnswerSources {
  const registry = useCitationSources();
  return useMemo(
    () => answerSources(members, registry, [timelineSources]),
    [members, registry, timelineSources],
  );
}
