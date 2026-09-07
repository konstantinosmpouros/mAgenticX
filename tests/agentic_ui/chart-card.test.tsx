// @vitest-environment happy-dom
import { render, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChartBlock } from "@/shared/lib/types";

vi.mock("@/shared/hooks/use-mobile", () => ({ useIsMobile: () => false }));
vi.mock("@/shared/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { ChartCard } from "@/features/chat/components/message_parts/ChartCard";

const composedStack: ChartBlock = {
  kind: "chart",
  id: "chart-block-1",
  chartId: "chart-1",
  chartType: "composed",
  title: "Composed — stacked=T, show_values=T",
  subtitle: "Revenue A/B and margin",
  xKey: "month",
  stacked: true,
  showValues: true,
  series: [
    { key: "revenue_a", label: "Revenue A ($K)", type: "bar", axis: "left" },
    { key: "revenue_b", label: "Revenue B ($K)", type: "bar", axis: "left" },
    { key: "margin", label: "Margin (%)", type: "line", axis: "right" },
  ],
  data: [
    { month: "Jan", revenue_a: 30, revenue_b: 20, margin: 22.1 },
    { month: "Feb", revenue_a: 35, revenue_b: 30, margin: 25.1 },
    { month: "Mar", revenue_a: 28, revenue_b: 32, margin: 21.1 },
    { month: "Apr", revenue_a: 40, revenue_b: 40, margin: 27.1 },
  ],
};

describe("ChartCard value labels", () => {
  beforeAll(() => {
    window.ResizeObserver = class {
      readonly callback: ResizeObserverCallback;

      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }

      observe(target: Element) {
        this.callback(
          [{ contentRect: { width: 700, height: 300 }, target } as ResizeObserverEntry],
          this,
        );
      }

      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  });

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("renders stacked bar values inside fitted badges in a composed chart", async () => {
    const { container } = render(<ChartCard block={composedStack} />);

    await waitFor(() => {
      expect(container.querySelectorAll("[data-stacked-bar-label]").length).toBeGreaterThan(0);
    });

    const badges = Array.from(container.querySelectorAll("[data-stacked-bar-label]"));
    expect(badges.map((badge) => badge.getAttribute("data-stacked-bar-label"))).toContain("30");
    expect(
      badges.every((badge) => badge.querySelector("rect") && badge.querySelector("text")),
    ).toBe(true);

    const lineLabels = await waitFor(
      () => {
        const marginValues = new Set(composedStack.data.map((row) => String(row.margin)));
        const labels = Array.from(container.querySelectorAll("text")).filter((label) =>
          marginValues.has(label.textContent ?? ""),
        );
        expect(labels).toHaveLength(composedStack.data.length);
        return labels;
      },
      { timeout: 3_000 },
    );
    expect(lineLabels.every((label) => Number(label.getAttribute("y")) >= 0)).toBe(true);
  });
});
