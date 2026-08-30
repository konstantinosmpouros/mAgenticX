// @vitest-environment happy-dom
// The export helper reads resolved theme colors via window.getComputedStyle,
// so this file needs a DOM even though it only exercises pure logic.
import { describe, expect, it } from "vitest";

import { chartLegendEntries } from "@/features/chat/lib/chartExport";
import type { ChartBlock } from "@/shared/lib/types";

/**
 * The exported PNG paints its own legend, because recharts draws the real one
 * as HTML outside the `<svg>`. That makes legend selection a place where the
 * image can confidently disagree with the chart on screen — so the rule that
 * pie/radial name categories while everything else names measures is pinned.
 */

const block = (over: Partial<ChartBlock>): ChartBlock => ({
  kind: "chart",
  id: "b1",
  chartId: "c1",
  chartType: "bar",
  title: "T",
  xKey: "region",
  series: [{ key: "rev", label: "Revenue" }],
  data: [
    { region: "EMEA", rev: 1 },
    { region: "APAC", rev: 2 },
  ],
  ...over,
});

describe("chartLegendEntries", () => {
  it("names categories for a pie, which colours per row", () => {
    expect(chartLegendEntries(block({ chartType: "pie" })).map((e) => e.label)).toEqual([
      "EMEA",
      "APAC",
    ]);
  });

  it("names categories for a radial too", () => {
    expect(chartLegendEntries(block({ chartType: "radial" })).map((e) => e.label)).toEqual([
      "EMEA",
      "APAC",
    ]);
  });

  it("names measures for a multi-series chart", () => {
    const multi = block({
      series: [
        { key: "rev", label: "Revenue" },
        { key: "cost", label: "Cost" },
      ],
    });
    expect(chartLegendEntries(multi).map((e) => e.label)).toEqual(["Revenue", "Cost"]);
  });

  it("omits the legend entirely for a single-measure chart", () => {
    // One series needs no legend — the title already says what is plotted.
    expect(chartLegendEntries(block({}))).toEqual([]);
  });

  it("gives every entry a distinct palette slot", () => {
    // The palette lives in the theme stylesheet, which no test environment
    // loads — define the tokens so this exercises the index mapping rather
    // than the identical fallback every lookup would otherwise return.
    for (let i = 1; i <= 5; i += 1) {
      document.documentElement.style.setProperty(`--chart-${i}`, `${i * 40} 70% 50%`);
    }
    const multi = block({
      series: [
        { key: "a", label: "A" },
        { key: "b", label: "B" },
        { key: "c", label: "C" },
      ],
    });
    const colors = chartLegendEntries(multi).map((e) => e.color);
    expect(colors).toEqual(["hsl(40 70% 50%)", "hsl(80 70% 50%)", "hsl(120 70% 50%)"]);
  });
});
