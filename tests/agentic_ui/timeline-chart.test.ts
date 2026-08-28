import { describe, expect, it } from "vitest";

import { createTimeline, reduceTimelineEvents } from "@/features/inference/timeline";
import type { ChartBlock } from "@/shared/lib/types";

/**
 * A chart is the one timeline block that carries its whole payload on the
 * event — there are no bytes behind it, so the reducer IS the persistence
 * story: whatever survives this fold is what the user sees after a reload.
 * These pin the two things that makes safe: it lands at the right position in
 * the log, and a malformed payload is dropped rather than rendered wrong.
 */

const text = (delta: string) => ({ type: "TEXT_MESSAGE_CHUNK", delta });

const chart = (value: unknown) => ({
  type: "CUSTOM",
  name: "RENDER_CHART",
  value,
});

const validPayload = {
  chart_id: "call_1",
  type: "bar",
  title: "Revenue by month",
  subtitle: "FY2025, EUR M",
  x_key: "month",
  series: [{ key: "revenue", label: "Revenue" }],
  data: [
    { month: "Jan", revenue: 12.4 },
    { month: "Feb", revenue: null },
  ],
};

const charts = (blocks: { kind: string }[]) => blocks.filter((b) => b.kind === "chart");

describe("RENDER_CHART", () => {
  it("folds into a chart block carrying every value the agent sent", () => {
    const state = reduceTimelineEvents(createTimeline(), [chart(validPayload)]);

    const [block] = charts(state.blocks) as ChartBlock[];
    expect(block).toBeDefined();
    expect(block.chartType).toBe("bar");
    expect(block.title).toBe("Revenue by month");
    expect(block.subtitle).toBe("FY2025, EUR M");
    expect(block.xKey).toBe("month");
    expect(block.series).toEqual([{ key: "revenue", label: "Revenue" }]);
    // A null measure is a genuine gap and must survive the fold as null — a
    // zero here would be a number the agent never reported.
    expect(block.data).toEqual([
      { month: "Jan", revenue: 12.4 },
      { month: "Feb", revenue: null },
    ]);
  });

  it("interleaves at the log position so text renders above and below it", () => {
    const state = reduceTimelineEvents(createTimeline(), [
      text("Here is the trend:"),
      chart(validPayload),
      text("Revenue grew steadily."),
    ]);

    expect(state.blocks.map((b) => b.kind)).toEqual(["content", "chart", "content"]);
  });

  it("omits an absent subtitle rather than carrying an empty string", () => {
    const state = reduceTimelineEvents(createTimeline(), [
      chart({ ...validPayload, subtitle: null }),
    ]);

    const [block] = charts(state.blocks) as ChartBlock[];
    expect(block.subtitle).toBeUndefined();
  });

  it("drops a malformed payload instead of rendering a broken chart", () => {
    const state = reduceTimelineEvents(createTimeline(), [
      chart({ ...validPayload, series: [] }), // a chart with nothing to plot
      chart({ ...validPayload, data: [] }), // ...or nothing to plot it from
      chart({ ...validPayload, type: "sunburst" }), // ...or an unsupported type
      chart(null),
    ]);

    expect(charts(state.blocks)).toHaveLength(0);
  });

  it("carries the presentation modifiers through the fold", () => {
    const state = reduceTimelineEvents(createTimeline(), [
      chart({ ...validPayload, stacked: true, horizontal: true, show_values: true }),
    ]);

    const [block] = charts(state.blocks) as ChartBlock[];
    expect(block.stacked).toBe(true);
    expect(block.horizontal).toBe(true);
    expect(block.showValues).toBe(true);
  });

  it("defaults the modifiers to false when the event omits them", () => {
    const state = reduceTimelineEvents(createTimeline(), [chart(validPayload)]);

    const [block] = charts(state.blocks) as ChartBlock[];
    expect(block.stacked).toBe(false);
    expect(block.horizontal).toBe(false);
    expect(block.showValues).toBe(false);
  });

  it("folds every chart type the tool can emit", () => {
    const types = ["bar", "line", "area", "pie", "radar", "radial", "scatter", "composed"];
    const state = reduceTimelineEvents(
      createTimeline(),
      types.map((type, i) => chart({ ...validPayload, chart_id: `c${i}`, type })),
    );

    expect((charts(state.blocks) as ChartBlock[]).map((b) => b.chartType)).toEqual(types);
  });

  it("keeps per-series type and axis for a composed chart", () => {
    const state = reduceTimelineEvents(createTimeline(), [
      chart({
        ...validPayload,
        type: "composed",
        series: [
          { key: "revenue", label: "Revenue", type: "bar", axis: "left" },
          { key: "margin", label: "Margin", type: "line", axis: "right" },
        ],
        data: [{ month: "Jan", revenue: 12.4, margin: 0.4 }],
      }),
    ]);

    const [block] = charts(state.blocks) as ChartBlock[];
    expect(block.series).toEqual([
      { key: "revenue", label: "Revenue", type: "bar", axis: "left" },
      { key: "margin", label: "Margin", type: "line", axis: "right" },
    ]);
  });

  it("omits per-series type and axis when the agent did not set them", () => {
    const state = reduceTimelineEvents(createTimeline(), [chart(validPayload)]);

    const [block] = charts(state.blocks) as ChartBlock[];
    expect(block.series[0]).toEqual({ key: "revenue", label: "Revenue" });
  });

  it("keeps every chart when the agent draws more than one", () => {
    const state = reduceTimelineEvents(createTimeline(), [
      chart(validPayload),
      chart({ ...validPayload, chart_id: "call_2", title: "Headcount", type: "line" }),
    ]);

    const found = charts(state.blocks) as ChartBlock[];
    expect(found.map((b) => b.title)).toEqual(["Revenue by month", "Headcount"]);
    expect(found.map((b) => b.chartType)).toEqual(["bar", "line"]);
  });
});
