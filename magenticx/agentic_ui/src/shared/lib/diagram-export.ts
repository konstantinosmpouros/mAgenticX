/**
 * Download of a Mermaid diagram from an answer as a PNG image. The diagram is
 * taken from the rendered SVG, so the file shows exactly what the user sees.
 */

import { triggerBrowserDownload } from "./download";

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";

/** `diagram-YYYYMMDD-HHMM.png`, local time. */
export function diagramFileName(now: Date = new Date(), extension = "png"): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `diagram-${stamp}.${extension}`;
}

/** The diagram's natural size: its viewBox, else its on-screen box. */
export function svgSize(svg: SVGSVGElement): { width: number; height: number } {
  const box = svg.viewBox?.baseVal;
  if (box && box.width > 0 && box.height > 0) return { width: box.width, height: box.height };
  const rect = svg.getBoundingClientRect();
  return { width: Math.max(1, rect.width), height: Math.max(1, rect.height) };
}

/**
 * The SVG as a standalone document: namespaces set and an explicit pixel size,
 * since Mermaid sizes it `width="100%"` with a CSS `max-width`, which an image
 * decoder cannot resolve.
 */
export function standaloneSvg(svg: SVGSVGElement): string {
  const { width, height } = svgSize(svg);
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", SVG_NS);
  clone.setAttribute("xmlns:xlink", XLINK_NS);
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  clone.style.removeProperty("max-width");
  return new XMLSerializer().serializeToString(clone);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("diagram image failed to load"));
    image.src = src;
  });
}

/**
 * The diagram drawn on a canvas at `scale` × its size (2 = sharp on screens and
 * in documents), over `background` — Mermaid is configured with a white page,
 * and a transparent PNG would turn dark in dark-themed viewers.
 */
export async function svgToPngBlob(
  svg: SVGSVGElement,
  { scale = 2, background = "#ffffff" }: { scale?: number; background?: string } = {},
): Promise<Blob> {
  const { width, height } = svgSize(svg);
  const image = await loadImage(
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(standaloneSvg(svg))}`,
  );
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas unavailable");
  context.fillStyle = background;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("PNG encoding failed"))),
      "image/png",
    ),
  );
}

/**
 * Download the diagram as PNG. Should a browser refuse to rasterise it (Safari
 * taints the canvas for Mermaid's HTML labels), the same diagram is saved as
 * SVG instead, so the click never does nothing.
 */
export async function downloadDiagramPng(
  svg: SVGSVGElement,
  now: Date = new Date(),
): Promise<void> {
  try {
    triggerBrowserDownload(await svgToPngBlob(svg), diagramFileName(now, "png"));
  } catch {
    triggerBrowserDownload(
      new Blob([standaloneSvg(svg)], { type: "image/svg+xml" }),
      diagramFileName(now, "svg"),
    );
  }
}
