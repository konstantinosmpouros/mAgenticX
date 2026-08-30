import type { ChartBlock } from "@/shared/lib/types";

/**
 * Export a rendered chart as a PNG the user can paste into a doc or a slide.
 *
 * Composed rather than screenshotted. Recharts draws the plot into an `<svg>`,
 * but the legend is a `div` in `.recharts-legend-wrapper` and the title lives in
 * the card's `<figcaption>` — both outside the SVG. Serializing the SVG alone
 * would export a chart with no title and no legend, so this paints the frame
 * itself from the block's own data and draws the SVG into the middle of it.
 *
 * The other reason not to screenshot: colors come from `hsl(var(--chart-N))`
 * and axis text from Tailwind classes. Once an SVG is serialized standalone,
 * external CSS and custom properties no longer apply and everything renders
 * black — so every computed paint value is inlined onto the clone first.
 */

// Rendered at 2x so the export stays crisp on a high-DPI screen and when scaled
// into a slide. Higher multiples bloat the file for no visible gain.
const SCALE = 2;
const PADDING = 24;
const TITLE_SIZE = 16;
const SUBTITLE_SIZE = 12;
const LEGEND_SIZE = 12;
const LEGEND_SWATCH = 10;
const LEGEND_GAP = 16;
const PALETTE_SIZE = 5;

// Paint properties that carry a chart's appearance. Copied from the live
// element's computed style, which resolves var() to a concrete color.
const PAINT_PROPS = [
  "fill",
  "fill-opacity",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-dasharray",
  "opacity",
  "font-family",
  "font-size",
  "font-weight",
  "text-anchor",
] as const;

/** Resolve a theme token to a usable CSS color, falling back if it's unset. */
const themeColor = (name: string, fallback: string): string => {
  const raw = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return raw ? `hsl(${raw})` : fallback;
};

const paletteColor = (index: number) =>
  themeColor(`--chart-${(index % PALETTE_SIZE) + 1}`, "#8884d8");

/**
 * Copy every computed paint value onto the clone as an inline style.
 *
 * Walks both trees in lockstep. `getComputedStyle` is what makes this work: it
 * returns the *resolved* value, so `var(--color-revenue)` and the Tailwind
 * `fill-muted-foreground` class both come back as plain colors that survive
 * serialization.
 */
const inlineComputedStyles = (source: Element, clone: Element): void => {
  const computed = window.getComputedStyle(source);
  const declarations: string[] = [];
  for (const prop of PAINT_PROPS) {
    const value = computed.getPropertyValue(prop);
    if (value) declarations.push(`${prop}:${value}`);
  }
  if (declarations.length) clone.setAttribute("style", declarations.join(";"));
  // Tailwind classes have already been resolved into the inline style above;
  // leaving them would only re-apply nothing and bloat the serialized output.
  clone.removeAttribute("class");

  const sourceChildren = source.children;
  const cloneChildren = clone.children;
  for (let i = 0; i < sourceChildren.length; i += 1) {
    const sc = sourceChildren[i];
    const cc = cloneChildren[i];
    if (sc && cc) inlineComputedStyles(sc, cc);
  }
};

/**
 * The legend entries the exported image should carry, or none.
 *
 * Exported because the pie/radial split is the one real branch here: those two
 * colour per ROW, so their legend names categories, while every other type
 * names measures. Getting that backwards produces a legend that confidently
 * mislabels the chart, which is worth a test.
 */
export const chartLegendEntries = (block: ChartBlock): { label: string; color: string }[] => {
  // Pie and radial colour per ROW, so their legend names categories rather
  // than measures — matching what the card itself shows.
  if (block.chartType === "pie" || block.chartType === "radial") {
    return block.data.map((row, i) => ({
      label: String(row[block.xKey] ?? ""),
      color: paletteColor(i),
    }));
  }
  if (block.series.length < 2) return [];
  return block.series.map((s, i) => ({ label: s.label, color: paletteColor(i) }));
};

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "chart";

/** Serialize an SVG element to a data URL that a canvas can draw without tainting. */
const svgToDataUrl = (svg: SVGSVGElement, width: number, height: number): string => {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  inlineComputedStyles(svg, clone);
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  if (!clone.getAttribute("viewBox")) {
    clone.setAttribute("viewBox", `0 0 ${width} ${height}`);
  }
  const markup = new XMLSerializer().serializeToString(clone);
  // A data URL (not a blob URL) keeps the canvas untainted in every browser,
  // which is what lets toBlob() succeed afterwards.
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
};

const loadImage = (src: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("The chart image could not be rasterized."));
    img.src = src;
  });

/**
 * Render `block` — as currently drawn inside `figure` — to a PNG and save it.
 *
 * Throws with a human-readable message on any failure so the caller can toast
 * it; there is no partial success worth reporting.
 */
export async function downloadChartPng(figure: HTMLElement, block: ChartBlock): Promise<void> {
  // `.recharts-surface`, NOT the first <svg>: the card's lucide icon is an svg
  // too and it sits earlier in the DOM, so a bare querySelector("svg") exports
  // an 11px icon instead of the chart.
  const svg = figure.querySelector(".recharts-surface");
  if (!(svg instanceof SVGSVGElement)) {
    throw new Error("The chart is not ready to export yet.");
  }

  const rect = svg.getBoundingClientRect();
  const plotWidth = Math.max(1, Math.round(rect.width));
  // Recharts reserves space inside the container for the legend even though it
  // draws the legend as HTML outside the SVG. Cropping that band off keeps the
  // export from carrying a blank strip above the legend we paint ourselves.
  const legendBand = figure.querySelector(".recharts-legend-wrapper");
  const reserved = legendBand ? Math.round(legendBand.getBoundingClientRect().height) : 0;
  const fullHeight = Math.max(1, Math.round(rect.height));
  const plotHeight = Math.max(1, fullHeight - reserved);

  const entries = chartLegendEntries(block);
  const font = window.getComputedStyle(figure).fontFamily || "system-ui, sans-serif";
  const background = themeColor("--background", "#ffffff");
  const foreground = themeColor("--foreground", "#000000");
  const muted = themeColor("--muted-foreground", "#666666");

  const titleH = TITLE_SIZE + 8;
  const subtitleH = block.subtitle ? SUBTITLE_SIZE + 8 : 0;
  const legendH = entries.length ? LEGEND_SIZE + 14 : 0;
  const width = plotWidth + PADDING * 2;
  const height = plotHeight + titleH + subtitleH + legendH + PADDING * 2;

  const canvas = document.createElement("canvas");
  canvas.width = width * SCALE;
  canvas.height = height * SCALE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser cannot render the chart to an image.");
  ctx.scale(SCALE, SCALE);

  // Paint the theme background first — a transparent PNG looks broken the
  // moment it lands on a white slide.
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);

  let y = PADDING;
  ctx.textBaseline = "top";
  ctx.fillStyle = foreground;
  ctx.font = `600 ${TITLE_SIZE}px ${font}`;
  ctx.fillText(block.title, PADDING, y);
  y += titleH;

  if (block.subtitle) {
    ctx.fillStyle = muted;
    ctx.font = `${SUBTITLE_SIZE}px ${font}`;
    ctx.fillText(block.subtitle, PADDING, y);
    y += subtitleH;
  }

  const img = await loadImage(svgToDataUrl(svg, plotWidth, fullHeight));
  ctx.drawImage(img, 0, 0, plotWidth, plotHeight, PADDING, y, plotWidth, plotHeight);
  y += plotHeight;

  if (entries.length) {
    ctx.font = `${LEGEND_SIZE}px ${font}`;
    let x = PADDING;
    const swatchY = y + (LEGEND_SIZE - LEGEND_SWATCH) / 2 + 4;
    for (const entry of entries) {
      const labelWidth = ctx.measureText(entry.label).width;
      const entryWidth = LEGEND_SWATCH + 6 + labelWidth + LEGEND_GAP;
      // Legends wrap rather than run off the edge; a clipped legend is worse
      // than a taller image, and the height was sized for one row, so stop
      // instead of drawing outside the canvas.
      if (x + entryWidth > width - PADDING && x > PADDING) break;
      ctx.fillStyle = entry.color;
      ctx.fillRect(x, swatchY, LEGEND_SWATCH, LEGEND_SWATCH);
      ctx.fillStyle = muted;
      ctx.fillText(entry.label, x + LEGEND_SWATCH + 6, y + 4);
      x += entryWidth;
    }
  }

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("The chart image could not be encoded.");

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${slugify(block.title)}.png`;
  link.click();
  // Revoking synchronously can cancel the download in some browsers; one turn
  // of the event loop is enough for the click to have been handled.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
