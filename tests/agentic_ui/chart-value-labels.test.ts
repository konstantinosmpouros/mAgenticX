import { describe, expect, it } from "vitest";

import {
  getChartValueLabelMode,
  getStackedBarLabelLayout,
} from "@/features/chat/lib/chartValueLabels";

describe("chart value-label mode", () => {
  it("uses fitted labels only for marks that have a bounded stacked segment", () => {
    expect(getChartValueLabelMode(true, "bar")).toBe("inside-if-fits");
    expect(getChartValueLabelMode(true, "area")).toBe("tooltip-only");
  });

  it("keeps ordinary labels for non-stacked marks and composed-chart lines", () => {
    expect(getChartValueLabelMode(false, "bar")).toBe("above");
    expect(getChartValueLabelMode(true, "line")).toBe("above");
  });
});

describe("stacked bar value labels", () => {
  it("centres a compact value badge inside a segment with enough room", () => {
    const layout = getStackedBarLabelLayout({ x: 10, y: 20, width: 60, height: 30 }, 42);

    expect(layout).toMatchObject({
      text: "42",
      x: 40,
      y: 35,
      backgroundY: 27,
      backgroundHeight: 16,
    });
    expect(layout?.backgroundX).toBeGreaterThanOrEqual(10);
    expect((layout?.backgroundX ?? 0) + (layout?.backgroundWidth ?? 0)).toBeLessThanOrEqual(70);
  });

  it("omits a label when a short stacked segment cannot contain it", () => {
    expect(getStackedBarLabelLayout({ x: 10, y: 20, width: 60, height: 12 }, 42)).toBeNull();
  });

  it("omits a label when its formatted text is wider than the segment", () => {
    expect(getStackedBarLabelLayout({ x: 10, y: 20, width: 20, height: 30 }, 1_200_000)).toBeNull();
  });

  it("supports bars whose dimensions run in the negative direction", () => {
    const layout = getStackedBarLabelLayout({ x: 70, y: 50, width: -60, height: -30 }, -42);

    expect(layout).toMatchObject({ text: "-42", x: 40, y: 35 });
  });

  it("drops missing and non-numeric values", () => {
    expect(getStackedBarLabelLayout({ x: 0, y: 0, width: 60, height: 30 }, undefined)).toBeNull();
    expect(getStackedBarLabelLayout({ x: 0, y: 0, width: 60, height: 30 }, null)).toBeNull();
    expect(getStackedBarLabelLayout({ x: 0, y: 0, width: 60, height: 30 }, "nope")).toBeNull();
    expect(getStackedBarLabelLayout(undefined, 42)).toBeNull();
  });
});
