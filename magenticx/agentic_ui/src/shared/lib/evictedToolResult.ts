/**
 * A tool result the agent harness moved to a file because it was too large.
 *
 * deepagents replaces such a result with a fixed note for the model: where the
 * result was saved, how to read it in parts with `read_file`, and a head/tail
 * preview. Those instructions are for the model; shown as they are, the tool
 * card reads as a wall of prose. The card shows the path and the preview
 * instead. Anything that does not match the note exactly is left alone.
 */

export type EvictedToolResult = {
  /** Where the full result lives in the agent's files. */
  path: string;
  /** The head and tail of the result, as the model saw them. Empty when absent. */
  preview: string;
};

const HEADER = /^\s*Tool result too large, the result of this tool call \S+ was saved in the filesystem at this path: (\S+)/;
const PREVIEW_NOTE = /^Here is a preview[^\n]*:[ \t]*$/m;

/** The saved path and preview of an evicted result, or null for any other text. */
export function parseEvictedToolResult(text: string): EvictedToolResult | null {
  const header = HEADER.exec(text);
  if (!header) return null;
  const note = PREVIEW_NOTE.exec(text);
  const preview = note ? text.slice(note.index + note[0].length).replace(/^\n+/, "").trimEnd() : "";
  return { path: header[1], preview };
}
