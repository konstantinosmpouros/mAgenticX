import type { ThinkingBlockItem } from "@/shared/lib/types";

import {
  humaniseName,
  parseToolArgs,
  subagentName,
  titleFromArgs,
  toolTitle,
} from "./toolPresentation";

/** Longest live title before it is clipped with an ellipsis. */
const MAX_TITLE = 72;

const clipTitle = (text: string): string =>
  text.length > MAX_TITLE ? `${text.slice(0, MAX_TITLE - 1).trimEnd()}…` : text;

/**
 * A thought's headline. A reasoning model's summary part opens with a bold
 * title (`**Weighing the sources**\n\n…`): that title. Any other thought: its
 * first line, without markdown markers. Empty when there is no text yet.
 */
export const thoughtTitle = (text: string): string => {
  const bold = /^\s*\*\*(.+?)\*\*/.exec(text);
  if (bold) return clipTitle(bold[1].trim());
  const firstLine = text.split("\n").find((line) => line.trim()) ?? "";
  return clipTitle(firstLine.replace(/[*_`#>]+/g, "").trim());
};

/**
 * What a live chain of thought says it is doing: its latest step, while the
 * block still runs. A thought → its headline; a tool call → its step title
 * where the tool is known ("Read report.pdf"), else "Using <tool>"; a hand-off
 * → "Delegating to the … sub-agent". Null when there is nothing to say yet —
 * the caller keeps its generic "Reasoning...".
 *
 * `serverIdOf` names an MCP tool's server, so it reads "Server · Tool" as its
 * own step row does.
 */
export const liveCoTTitle = (
  items: readonly ThinkingBlockItem[],
  serverIdOf: (toolName: string) => string | undefined = () => undefined,
): string | null => {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind === "thought") {
      const title = thoughtTitle(item.text);
      if (title) return title;
      continue;
    }
    if (item.kind === "tool") {
      const args = parseToolArgs(item.argsText);
      const known = titleFromArgs(item.name, args);
      if (known) return clipTitle(known);
      const label = toolTitle(item.name, args, serverIdOf(item.name));
      // A tool with no label of its own reads as words, not `fetch_weather`.
      return clipTitle(`Using ${label === item.name ? humaniseName(item.name) : label}`);
    }
    if (item.kind === "delegation") {
      return item.type ? `Delegating to the ${subagentName(item.type)} sub-agent` : "Delegating to a sub-agent";
    }
    return null; // an approval or a question: the caller has its own words for those
  }
  return null;
};
