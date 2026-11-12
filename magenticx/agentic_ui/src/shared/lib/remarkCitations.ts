/**
 * remarkCitations — citation markers as nodes of their own (plan 42 §3.6).
 *
 * Turns every `[src:ID]` / `[src:ID,ID]` in the answer's prose into an
 * `mx-citation` element carrying the ids (`data-ids="3fa2c1,9b02e4"`), which
 * the markdown renderers map to the citation pill. The plugin knows nothing
 * about which ids exist: the pill resolves them against the conversation's
 * sources when it renders, drops the unknown ones and renders nothing when no
 * id is known — so a citation the model invented never reaches the screen, and
 * a source that arrives a moment after its marker still lights it up.
 *
 * Markers inside inline code, code blocks, math, raw HTML and link text are
 * left as they are. The whitespace before a marker is dropped; the pill brings
 * its own small gap. A marker still being streamed is hidden before parsing
 * (`hideUnclosedCitationMarker` in ./citations), not here.
 */
import type { Nodes, Parent, PhrasingContent, Root, Text } from "mdast";

import { citationMarkerPattern, parseCitationIds } from "./citations";

/** The element name the renderers map to the pill. */
export const CITATION_ELEMENT = "mx-citation";

const SKIP = new Set(["code", "inlineCode", "html", "link", "linkReference", "math", "inlineMath"]);

function citationNode(ids: string[]): PhrasingContent {
  return {
    type: "citation",
    data: { hName: CITATION_ELEMENT, hProperties: { dataIds: ids.join(",") } },
    children: [],
  } as unknown as PhrasingContent;
}

/** The text node split around its markers; null when it holds none. */
function splitText(node: Text): PhrasingContent[] | null {
  const pattern = citationMarkerPattern();
  const parts: PhrasingContent[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(node.value)) !== null) {
    const before = node.value.slice(last, match.index).replace(/[ \t]+$/, "");
    if (before) parts.push({ type: "text", value: before });
    parts.push(citationNode(parseCitationIds(match[1])));
    last = match.index + match[0].length;
  }
  if (last === 0) return null;
  const rest = node.value.slice(last);
  if (rest) parts.push({ type: "text", value: rest });
  return parts;
}

function walk(parent: Parent): void {
  const children = parent.children as Nodes[];
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (SKIP.has(child.type)) continue;
    if (child.type === "text") {
      const parts = splitText(child);
      if (parts) {
        children.splice(index, 1, ...(parts as Nodes[]));
        index += parts.length - 1;
      }
      continue;
    }
    if ("children" in child) walk(child as Parent);
  }
}

/** The remark plugin: every marker in the tree's prose becomes a citation node. */
export function remarkCitations() {
  return (tree: Root) => {
    walk(tree);
  };
}
