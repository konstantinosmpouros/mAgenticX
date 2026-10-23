/**
 * Markdown fixes for an answer that is still streaming in.
 *
 * Streamdown renders a ```mermaid block on every chunk, finished or not, and its
 * incomplete-markdown repair appends `](streamdown:incomplete-link)` to the end
 * of the text even inside an open code block — so a half-written diagram shows
 * Mermaid's parse error until the block closes, and every failed render attempt
 * also adds and removes a measuring node on <body>.
 */

export const DIAGRAM_PENDING_TEXT = "Generating diagram…";

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

type OpenFence = { line: number; marker: string; info: string };

/** The fence still open at the end of the text, if any. */
function openFenceAtEnd(lines: string[]): OpenFence | null {
  let open: OpenFence | null = null;
  lines.forEach((text, line) => {
    const match = FENCE.exec(text);
    if (!match) return;
    const [, marker, rest] = match;
    if (open === null) {
      // A backtick fence's info string may not contain a backtick (CommonMark).
      if (marker.startsWith("`") && rest.includes("`")) return;
      open = { line, marker, info: rest.trim() };
    } else if (
      marker[0] === open.marker[0] &&
      marker.length >= open.marker.length &&
      rest.trim() === ""
    ) {
      open = null;
    }
  });
  return open;
}

/**
 * The answer as it should be rendered right now. An open ```mermaid block at the
 * end is held back: while `streaming` it becomes a short "Generating diagram…"
 * line (the diagram renders once, when its block closes); in a finished answer
 * — a run cancelled mid-diagram — it is shown as plain code instead of an error
 * box. Anything else passes through unchanged.
 */
export function prepareStreamingMarkdown(markdown: string, streaming: boolean): string {
  if (!markdown.includes("```") && !markdown.includes("~~~")) return markdown;
  const lines = markdown.split("\n");
  const open = openFenceAtEnd(lines);
  if (open === null || open.info.split(/\s+/)[0].toLowerCase() !== "mermaid") return markdown;

  const before = lines.slice(0, open.line).join("\n");
  if (streaming) return `${before.trimEnd()}\n\n*${DIAGRAM_PENDING_TEXT}*\n`;
  const code = lines.slice(open.line + 1).join("\n");
  return `${before}\n${open.marker}text\n${code}\n${open.marker}\n`;
}
