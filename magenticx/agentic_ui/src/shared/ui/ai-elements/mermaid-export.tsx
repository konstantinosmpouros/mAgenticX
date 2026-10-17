import { CheckIcon, ImageDownIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { downloadDiagramPng } from "@/shared/lib/diagram-export";

const MERMAID_BLOCK_SELECTOR = '[data-streamdown="mermaid-block"]';
const MERMAID_CHART_SELECTOR = '[aria-label="Mermaid chart"]';
const DONE_RESET_MS = 2000;

/** The "Download image" button of one diagram, beside Streamdown's own buttons. */
function DiagramActions({ block }: { block: HTMLElement }) {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const handleDownload = () => {
    // The chart's own SVG — the buttons' icons are SVGs too, and come first.
    const svg = block.querySelector<SVGSVGElement>(`${MERMAID_CHART_SELECTOR} svg`);
    if (!svg) return; // still rendering, or Mermaid could not parse it
    void downloadDiagramPng(svg).then(() => {
      setDone(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setDone(false), DONE_RESET_MS);
    });
  };

  // Same look as Streamdown's "Download file" / copy buttons next to it.
  return (
    <button
      type="button"
      className="cursor-pointer p-1 text-muted-foreground transition-all hover:text-foreground"
      onClick={handleDownload}
      title={done ? "Image downloaded" : "Download image (PNG)"}
      aria-label={done ? "Image downloaded" : "Download image (PNG)"}
    >
      {done ? <CheckIcon size={14} /> : <ImageDownIcon size={14} />}
    </button>
  );
}

/** The row holding Streamdown's diagram buttons (source download, copy), if shown. */
function controlsRow(block: HTMLElement): HTMLElement | null {
  return (
    Array.from(block.children).find(
      (child): child is HTMLElement =>
        child instanceof HTMLElement && child.querySelector(":scope > button") !== null,
    ) ?? null
  );
}

/**
 * Puts a "Download image (PNG)" button on every Mermaid diagram rendered under
 * `root`.
 *
 * Streamdown renders the diagrams itself and offers no hook to add actions (its
 * own controls only download the Mermaid source and copy it), so the diagram
 * frames are found in the rendered DOM — watched, because a diagram appears only
 * once its block has arrived — and each gets its button through a portal into
 * Streamdown's controls row.
 */
export function MermaidExportLayer({ root }: { root: HTMLElement | null }) {
  const [rows, setRows] = useState<HTMLElement[]>([]);

  useEffect(() => {
    if (!root) return;
    const scan = () => {
      // Only diagrams Mermaid has drawn: one that failed to parse gets no button.
      const found = Array.from(root.querySelectorAll<HTMLElement>(MERMAID_BLOCK_SELECTOR))
        .filter((block) => block.querySelector(`${MERMAID_CHART_SELECTOR} svg`) !== null)
        .map(controlsRow)
        .filter((row): row is HTMLElement => row !== null);
      setRows((previous) =>
        previous.length === found.length && previous.every((row, index) => row === found[index])
          ? previous
          : found,
      );
    };
    scan();
    const observer = new MutationObserver(scan);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [root]);

  return (
    <>
      {rows.map((row, index) =>
        createPortal(<DiagramActions block={row.parentElement ?? row} />, row, `diagram-${index}`),
      )}
    </>
  );
}
