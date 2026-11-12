import { createContext, useContext } from "react";
import type { CitationSourceMap } from "./types";

// The sources the open conversation may cite (plan 42), by id. Provided by the
// chat (features/chat's useConversationSources, at the workspace shell and on
// the shared-conversation page) and read by the citation pill the markdown
// renderers draw, so a marker resolves without the sources being threaded
// through every message component. Lives in shared/ because the renderers do,
// and shared/ never imports from features/. Outside a provider the map is
// empty: every marker then resolves to nothing and renders nothing.

const NO_SOURCES: CitationSourceMap = new Map();

export const CitationSourcesContext = createContext<CitationSourceMap>(NO_SOURCES);

export function useCitationSources(): CitationSourceMap {
  return useContext(CitationSourcesContext);
}
