type RectViewBox = {
  x?: number | string;
  y?: number | string;
  width?: number | string;
  height?: number | string;
};

export type StackedBarLabelLayout = {
  text: string;
  x: number;
  y: number;
  backgroundX: number;
  backgroundY: number;
  backgroundWidth: number;
  backgroundHeight: number;
};

const LABEL_HEIGHT = 16;
const HORIZONTAL_PADDING = 8;
const SEGMENT_PADDING = 4;
const APPROXIMATE_CHARACTER_WIDTH = 6;

export type ChartMarkKind = "bar" | "line" | "area";
export type ChartValueLabelMode = "above" | "inside-if-fits" | "tooltip-only";

export const getChartValueLabelMode = (
  stacked: boolean | undefined,
  kind: ChartMarkKind,
): ChartValueLabelMode => {
  if (!stacked) return "above";
  if (kind === "bar") return "inside-if-fits";
  if (kind === "area") return "tooltip-only";
  return "above";
};

const finiteNumber = (value: unknown) => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const formatStackedValue = (value: number) =>
  new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);

/**
 * Fit a readable value badge inside a stacked bar segment.
 *
 * Recharts positions every ordinary `top` label at the edge of its segment.
 * Those edges can be only a few pixels apart in a stack, making the labels
 * overlap. A segment is the only reliable collision boundary we have here, so
 * render in its centre when the complete badge fits and otherwise let the
 * tooltip carry the exact value.
 */
export function getStackedBarLabelLayout(
  viewBox: unknown,
  value: number | string | null | undefined,
): StackedBarLabelLayout | null {
  const rectangle =
    viewBox !== null && typeof viewBox === "object" ? (viewBox as RectViewBox) : undefined;
  const x = finiteNumber(rectangle?.x);
  const y = finiteNumber(rectangle?.y);
  const width = finiteNumber(rectangle?.width);
  const height = finiteNumber(rectangle?.height);
  const numericValue = finiteNumber(value);

  if (x === null || y === null || width === null || height === null || numericValue === null) {
    return null;
  }

  const text = formatStackedValue(numericValue);
  const backgroundWidth = Math.max(
    LABEL_HEIGHT,
    text.length * APPROXIMATE_CHARACTER_WIDTH + HORIZONTAL_PADDING,
  );
  const segmentWidth = Math.abs(width);
  const segmentHeight = Math.abs(height);

  if (
    segmentWidth < backgroundWidth + SEGMENT_PADDING ||
    segmentHeight < LABEL_HEIGHT + SEGMENT_PADDING
  ) {
    return null;
  }

  const centreX = x + width / 2;
  const centreY = y + height / 2;

  return {
    text,
    x: centreX,
    y: centreY,
    backgroundX: centreX - backgroundWidth / 2,
    backgroundY: centreY - LABEL_HEIGHT / 2,
    backgroundWidth,
    backgroundHeight: LABEL_HEIGHT,
  };
}
