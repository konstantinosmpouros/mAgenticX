import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_LOGOS,
  THEME_ATTRIBUTE_VALUES,
  THEME_IDS,
  THEMES,
  logoFor,
  orbFor,
  resolveStoredTheme,
  themeFor,
} from "@/styles/theme/themes";

/**
 * The palette themes (src/styles/theme): the registry, the legacy "light" /
 * "dark" names, the pre-render script's copy of the dark ids, and that every
 * theme defines the tokens the components read.
 */
const UI = path.resolve(__dirname, "../../magenticx/agentic_ui");
const read = (rel: string) => readFileSync(path.join(UI, rel), "utf8");
const tokensIn = (css: string) => new Set([...css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]));

describe("theme registry", () => {
  it("has the six palette themes, Daylight first", () => {
    expect(THEMES.map((t) => t.id)).toEqual(["daylight", "midnight", "aurora", "sunset", "sage", "citrus"]);
    expect(THEMES.filter((t) => t.mode === "dark").map((t) => t.id)).toEqual(["midnight"]);
  });

  it("maps legacy names to Daylight and Midnight", () => {
    expect(themeFor("light").id).toBe("daylight");
    expect(themeFor("dark").id).toBe("midnight");
    expect(themeFor(undefined).id).toBe("daylight");
    expect(THEME_ATTRIBUTE_VALUES.dark).toBe("midnight");
    expect(THEME_ATTRIBUTE_VALUES.sage).toBe("sage");
    expect(THEME_ATTRIBUTE_VALUES.system).toBeUndefined();
  });

  it("has no System option: a missing or stored system resolves once from the device", () => {
    expect(THEME_IDS).not.toContain("system");
    expect(resolveStoredTheme("system", false)).toBe("daylight");
    expect(resolveStoredTheme("system", true)).toBe("midnight");
    expect(resolveStoredTheme(null, true)).toBe("midnight");
    expect(resolveStoredTheme(undefined, false)).toBe("daylight");
    expect(resolveStoredTheme("nonsense", true)).toBe("midnight");
    // An explicit choice (or a legacy name) wins over the device.
    expect(resolveStoredTheme("sage", true)).toBe("sage");
    expect(resolveStoredTheme("midnight", false)).toBe("midnight");
    expect(resolveStoredTheme("light", true)).toBe("daylight");
    expect(resolveStoredTheme("dark", false)).toBe("midnight");
  });

  it("theme-init.js migrates the same way before paint", () => {
    const init = read("public/theme-init.js");
    const run = (stored: string | null, prefersDark: boolean) => {
      const store = new Map<string, string>(stored === null ? [] : [["theme", stored]]);
      const attrs: Record<string, string> = {};
      const classes = new Set<string>();
      const window = {
        matchMedia: () => ({ matches: prefersDark }),
        localStorage: {
          getItem: (k: string) => store.get(k) ?? null,
          setItem: (k: string, v: string) => void store.set(k, v),
        },
      };
      const document = {
        documentElement: {
          setAttribute: (k: string, v: string) => void (attrs[k] = v),
          classList: { toggle: (c: string, on: boolean) => void (on ? classes.add(c) : classes.delete(c)) },
          style: {} as Record<string, string>,
        },
      };
      new Function("window", "document", init)(window, document);
      return { stored: store.get("theme"), attr: attrs["data-theme"], dark: classes.has("dark") };
    };
    expect(run("system", true)).toEqual({ stored: "midnight", attr: "midnight", dark: true });
    expect(run(null, false)).toEqual({ stored: "daylight", attr: "daylight", dark: false });
    expect(run("dark", false)).toEqual({ stored: "midnight", attr: "midnight", dark: true });
    expect(run("citrus", true)).toEqual({ stored: "citrus", attr: "citrus", dark: false });
    for (const id of THEME_IDS) expect(run(id, false).stored).toBe(id);
  });

  it("gives every theme a logo and an orb", () => {
    expect(logoFor("midnight")).toBe(DEFAULT_LOGOS.dark);
    expect(logoFor("citrus")).toBe(DEFAULT_LOGOS.light);
    expect(orbFor("daylight")).toBe("/orbital-hub-transparent.webp");
    expect(orbFor("dark")).toBe("/orbital-hub-midnight.webp");
    for (const theme of THEMES) expect(orbFor(theme.id)).toMatch(/^\/orbital-hub-[a-z]+\.webp$/);
  });

  it("theme-init.js knows the same dark ids and aliases", () => {
    const init = read("public/theme-init.js");
    const dark = THEMES.filter((t) => t.mode === "dark").map((t) => `"${t.id}"`);
    expect(init).toContain(`DARK_THEMES = [${dark.join(", ")}]`);
    expect(init).toContain(`THEMES = [${THEME_IDS.map((id) => `"${id}"`).join(", ")}]`);
    expect(init).toContain('ALIASES = { light: "daylight", dark: "midnight" }');
  });
});

describe("theme stylesheets", () => {
  const light = tokensIn(read("src/styles/theme/light.css"));
  const midnight = tokensIn(read("src/styles/theme/midnight.css"));
  const roles = ["--theme-primary", "--theme-primary-fg", "--theme-glow", "--theme-gradient", "--tint", "--tint-line"];
  const orbGlow = ["--orb-glow-1", "--orb-glow-2", "--orb-glow-3"];

  it("every theme has its stylesheet, imported", () => {
    const index = read("src/index.css");
    for (const theme of THEMES) {
      expect(read(`src/styles/theme/${theme.id}.css`)).toContain(`:root[data-theme="${theme.id}"]`);
      expect(index).toContain(`./styles/theme/${theme.id}.css`);
    }
  });

  it("each light theme sets its roles and orb halo", () => {
    for (const theme of THEMES.filter((t) => t.mode === "light")) {
      const own = tokensIn(read(`src/styles/theme/${theme.id}.css`));
      for (const token of [...roles, ...orbGlow]) expect(own, `${theme.id} ${token}`).toContain(token);
    }
  });

  it("Midnight defines every token the light themes share", () => {
    const inherited = new Set(["--radius", "--transition-smooth", "--transition-slow"]);
    for (const token of light) {
      if (inherited.has(token)) continue;
      expect(midnight, token).toContain(token);
    }
    for (const token of [...roles.slice(0, 4), ...orbGlow, "--subagent-active", "--subagent-active-glow"]) {
      expect(midnight, token).toContain(token);
    }
  });
});
