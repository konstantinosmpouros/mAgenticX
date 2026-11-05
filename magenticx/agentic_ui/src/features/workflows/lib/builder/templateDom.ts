import type { WorkflowTemplateRefLabel } from "@/shared/lib/types";
import { TEMPLATE_CHIP, TEMPLATE_CHIP_INVALID, TEMPLATE_CHIP_SEP, TEMPLATE_CHIP_SOURCE } from "./consts";
import { parseTemplate } from "./templates";

/**
 * The template chip editor's DOM side: a template string drawn into a
 * contenteditable (text as text nodes, each `{{path}}` as a non-editable chip
 * that keeps its exact text in `data-raw`), read back to the same string, and
 * the caret mapped to and from an offset in that string. Every edit the
 * editor makes itself (insert, paste, drop, Enter, deleting a chip) is done
 * on the string and redrawn, so the DOM is always a projection of the value.
 */

/**
 * A zero-width space beside a chip that would otherwise sit at a line's edge:
 * browsers can't put a caret next to a non-editable element without a text
 * node there. Never part of the value.
 */
const CARET_ANCHOR = String.fromCharCode(0x200b);
const ANCHOR_RE = new RegExp(CARET_ANCHOR, "g");

/** How a chip's path reads, from the field's offered paths. */
export type DescribeRef = (path: string) => WorkflowTemplateRefLabel;

const isChip = (node: Node): node is HTMLElement =>
  node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).dataset.raw !== undefined;

/** Fill a chip with its label: `source › label`, or the raw path in red when the field can't read it. */
function paintChip(chip: HTMLElement, describe: DescribeRef) {
  const path = chip.dataset.path ?? "";
  const ref = describe(path);
  const doc = chip.ownerDocument;
  chip.replaceChildren();
  chip.className = ref.valid ? TEMPLATE_CHIP : TEMPLATE_CHIP_INVALID;
  chip.title = ref.valid ? path : `This field can't read '${path}'`;
  chip.dataset.valid = String(ref.valid);
  if (ref.valid) {
    const source = doc.createElement("span");
    source.className = TEMPLATE_CHIP_SOURCE;
    source.textContent = ref.source;
    const sep = doc.createElement("span");
    sep.className = TEMPLATE_CHIP_SEP;
    sep.setAttribute("aria-hidden", "true");
    sep.textContent = "›";
    const label = doc.createElement("span");
    label.className = "truncate";
    label.textContent = ref.label;
    chip.append(source, sep, label);
  } else {
    chip.textContent = path || chip.dataset.raw || "";
  }
}

/** Draw `value` into `root`, replacing what is there. */
export function renderTemplateInto(root: HTMLElement, value: string, describe: DescribeRef, multiline: boolean) {
  const doc = root.ownerDocument;
  const nodes: Node[] = [];
  const segments = parseTemplate(value);
  segments.forEach((segment, index) => {
    if (segment.type === "text") {
      nodes.push(doc.createTextNode(segment.text));
      return;
    }
    if (index === 0) nodes.push(doc.createTextNode(CARET_ANCHOR));
    const chip = doc.createElement("span");
    chip.contentEditable = "false";
    chip.draggable = false;
    chip.dataset.path = segment.path;
    chip.dataset.raw = segment.raw;
    paintChip(chip, describe);
    nodes.push(chip);
    if (segments[index + 1]?.type !== "text") nodes.push(doc.createTextNode(CARET_ANCHOR));
  });
  // A trailing newline renders no line of its own unless something follows it.
  if (multiline && value.endsWith("\n")) {
    const sentinel = doc.createElement("br");
    sentinel.dataset.sentinel = "true";
    nodes.push(sentinel);
  }
  root.replaceChildren(...nodes);
}

/** Relabel every chip in `root` (what the field may read changed), leaving text and caret alone. */
export function refreshChipLabels(root: HTMLElement, describe: DescribeRef) {
  root.querySelectorAll<HTMLElement>("[data-raw]").forEach((chip) => paintChip(chip, describe));
}

const BLOCKS = new Set(["DIV", "P", "LI"]);

function serializeInto(node: Node, out: { text: string }, isRoot: boolean) {
  node.childNodes.forEach((child, index) => {
    if (child.nodeType === Node.TEXT_NODE) {
      out.text += (child.textContent ?? "").replace(ANCHOR_RE, "");
    } else if (isChip(child)) {
      out.text += child.dataset.raw ?? "";
    } else if (child.nodeName === "BR") {
      const element = child as HTMLElement;
      // Ours, or the one a browser leaves in an emptied editor: not a newline.
      const last = isRoot && index === node.childNodes.length - 1;
      if (!element.dataset.sentinel && !last) out.text += "\n";
    } else if (child.nodeType === Node.ELEMENT_NODE || child.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      if (BLOCKS.has(child.nodeName) && out.text && !out.text.endsWith("\n")) out.text += "\n";
      serializeInto(child, out, false);
    }
  });
}

/** The template string `root` (or a fragment of it) holds. */
export function serializeTemplateDom(root: Node): string {
  const out = { text: "" };
  serializeInto(root, out, true);
  return out.text;
}

/** The chip `node` sits in, if any (a caret can land inside one by mouse in some browsers). */
function chipAround(node: Node, root: HTMLElement): HTMLElement | null {
  for (let at: Node | null = node; at && at !== root; at = at.parentNode) if (isChip(at)) return at;
  return null;
}

/** The value offset of a DOM point inside `root` (a point inside a chip counts as after it). */
export function pointToOffset(root: HTMLElement, container: Node, offset: number): number {
  const range = root.ownerDocument.createRange();
  range.setStart(root, 0);
  const chip = chipAround(container, root);
  if (chip) range.setEndAfter(chip);
  else range.setEnd(container, offset);
  // Not as a root: a `<br>` right before the point is a newline here.
  const out = { text: "" };
  serializeInto(range.cloneContents(), out, false);
  return out.text.length;
}

/** The selection inside `root` as value offsets, or null when it is elsewhere. */
export function selectionOffsets(root: HTMLElement): { start: number; end: number } | null {
  const selection = root.ownerDocument.getSelection();
  if (!selection || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const start = pointToOffset(root, range.startContainer, range.startOffset);
  const end = range.collapsed ? start : pointToOffset(root, range.endContainer, range.endOffset);
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

/** The DOM point at value offset `target` (past the end: the end). */
function offsetToPoint(root: HTMLElement, target: number): { node: Node; offset: number } {
  let remaining = target;
  const children = Array.from(root.childNodes);
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (child.nodeType === Node.TEXT_NODE) {
      const data = child.textContent ?? "";
      const length = data.replace(ANCHOR_RE, "").length;
      if (remaining <= length) {
        let seen = 0;
        let at = 0;
        while (at < data.length && seen < remaining) {
          if (data[at] !== CARET_ANCHOR) seen += 1;
          at += 1;
        }
        // Past any anchor, so the caret shows on the chip's far side.
        while (at < data.length && data[at] === CARET_ANCHOR) at += 1;
        return { node: child, offset: at };
      }
      remaining -= length;
    } else if (isChip(child)) {
      const length = (child.dataset.raw ?? "").length;
      if (remaining === 0) return { node: root, offset: index };
      if (remaining <= length) return { node: root, offset: index + 1 };
      remaining -= length;
    } else if (child.nodeName === "BR") {
      if ((child as HTMLElement).dataset.sentinel) return { node: root, offset: index };
      if (remaining === 0) return { node: root, offset: index };
      remaining -= 1;
    } else {
      const length = serializeTemplateDom(child).length;
      if (remaining <= length) return { node: root, offset: index + 1 };
      remaining -= length;
    }
  }
  const sentinel = root.lastChild && root.lastChild.nodeName === "BR";
  return { node: root, offset: sentinel ? children.length - 1 : children.length };
}

/** Put a collapsed caret at value offset `offset`. */
export function setCaretOffset(root: HTMLElement, offset: number) {
  const selection = root.ownerDocument.getSelection();
  if (!selection) return;
  const point = offsetToPoint(root, offset);
  const range = root.ownerDocument.createRange();
  range.setStart(point.node, point.offset);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

type CaretDocument = Document & {
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

/** The value offset under a screen point (a drop), or null when it is not inside `root`. */
export function offsetFromPoint(root: HTMLElement, x: number, y: number): number | null {
  const doc = root.ownerDocument as CaretDocument;
  let node: Node | null = null;
  let offset = 0;
  if (typeof doc.caretPositionFromPoint === "function") {
    const position = doc.caretPositionFromPoint(x, y);
    if (position) {
      node = position.offsetNode;
      offset = position.offset;
    }
  } else if (typeof doc.caretRangeFromPoint === "function") {
    const range = doc.caretRangeFromPoint(x, y);
    if (range) {
      node = range.startContainer;
      offset = range.startOffset;
    }
  }
  if (!node || !root.contains(node)) return null;
  return pointToOffset(root, node, offset);
}

/** The `{{path}}` placeholders of `value` with where each starts and ends. */
export function refSpans(value: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  let at = 0;
  for (const segment of parseTemplate(value)) {
    const length = segment.type === "text" ? segment.text.length : segment.raw.length;
    if (segment.type === "ref") spans.push({ start: at, end: at + length });
    at += length;
  }
  return spans;
}

/**
 * Whether the DOM is still a faithful drawing of `value` after a keystroke:
 * one chip per placeholder (typed `{{…}}` text becomes a chip on a redraw),
 * no stray markup, and a trailing newline still holding its line.
 */
export function domMatches(root: HTMLElement, value: string, multiline: boolean): boolean {
  const chips = root.querySelectorAll("[data-raw]").length;
  if (chips !== refSpans(value).length) return false;
  if (multiline && value.endsWith("\n") && !root.querySelector("br[data-sentinel]")) return false;
  return Array.from(root.childNodes).every(
    (child) => child.nodeType === Node.TEXT_NODE || isChip(child) || child.nodeName === "BR",
  );
}
