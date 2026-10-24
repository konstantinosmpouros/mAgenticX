import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  EASE_ENTER,
  EASE_EXIT,
  PANEL_TIMING,
  RADIX_MOTION,
  panelMotion,
  popoverMotion,
  sheetMotion,
} from "@/shared/lib/motion/panels";

/**
 * The shared panel motion (src/shared/lib/motion/panels.ts): its CSS half
 * (src/styles/motion.css, which Radix dialogs, sheets and menus use) must keep
 * the same durations and curves as the framer-motion half, and reduced motion
 * must only fade.
 */
const UI = path.resolve(__dirname, "../../magenticx/agentic_ui");
const css = readFileSync(path.join(UI, "src/styles/motion.css"), "utf8");
const cssVar = (name: string) => css.match(new RegExp(`${name}:\s*([^;]+);`))?.[1]?.trim();

describe("panel motion", () => {
  it("motion.css mirrors PANEL_TIMING and the curves", () => {
    for (const [kind, timing] of Object.entries(PANEL_TIMING)) {
      expect(cssVar(`--mx-${kind}-in`)).toBe(`${Math.round(timing.enter * 1000)}ms`);
      expect(cssVar(`--mx-${kind}-out`)).toBe(`${Math.round(timing.exit * 1000)}ms`);
    }
    expect(cssVar("--mx-ease-enter")).toBe(`cubic-bezier(${EASE_ENTER.join(", ")})`);
    expect(cssVar("--mx-ease-exit")).toBe(`cubic-bezier(${EASE_EXIT.join(", ")})`);
  });

  it("every Radix class has its rules", () => {
    const classes = [
      RADIX_MOTION.backdrop,
      RADIX_MOTION.panel,
      RADIX_MOTION.popover,
      RADIX_MOTION.sheetToPanel,
      ...Object.values(RADIX_MOTION.sheet),
    ].flatMap((value) => value.split(" "));
    for (const name of new Set(classes)) expect(css).toContain(`.${name}`);
  });

  it("animates exits, not just entrances", () => {
    const { content } = panelMotion(false);
    expect(content.exit).toMatchObject({ opacity: 0 });
    expect(sheetMotion("right", false).content.exit).toMatchObject({ x: "100%" });
    expect(popoverMotion(false).exit).toMatchObject({ opacity: 0 });
  });

  it("only fades under reduced motion", () => {
    const presets = [
      panelMotion(true).content,
      panelMotion(true).backdrop,
      sheetMotion("left", true).content,
      popoverMotion(true),
    ];
    for (const preset of presets) {
      for (const target of [preset.initial, preset.exit]) {
        const keys = Object.keys(target).filter((key) => key !== "transition");
        expect(keys).toEqual(["opacity"]);
      }
    }
    expect(css).toMatch(/prefers-reduced-motion: reduce[\s\S]*mx-fade-in/);
  });
});
