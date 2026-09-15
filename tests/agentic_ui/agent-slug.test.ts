/**
 * Deriving an agent's identifier from its display name.
 *
 * The builder has no identifier field — the slug is computed from the name — so
 * a name that yields nothing is a dead end the user cannot see or escape. These
 * pin the two halves of that bug: accented Latin must survive, and a name that
 * genuinely has no ASCII must be reported as an identifier problem rather than
 * as a missing name.
 */
import { describe, expect, it } from "vitest";

import { slugify } from "@/features/settings/lib/agentSpec";

describe("slugify", () => {
  it("lowercases and hyphenates a plain name", () => {
    expect(slugify("Research Bot")).toBe("research-bot");
    expect(slugify("Agent #1")).toBe("agent-1");
  });

  it("keeps accented Latin as its base letter", () => {
    // Previously "caf" — the é was dropped rather than folded, silently losing
    // the last character of the identifier.
    expect(slugify("Café")).toBe("cafe");
    expect(slugify("Über Agent")).toBe("uber-agent");
    expect(slugify("Ångström")).toBe("angstrom");
  });

  it("collapses runs and trims edge hyphens", () => {
    expect(slugify("  Spaced   Out  ")).toBe("spaced-out");
    expect(slugify("--leading and trailing--")).toBe("leading-and-trailing");
  });

  it("caps the length", () => {
    expect(slugify("a".repeat(80)).length).toBe(48);
  });

  it("returns empty for a name with no Latin alphanumerics", () => {
    // Not a crash and not a missing name — the caller has to tell the user the
    // *identifier* cannot be derived, which is a different sentence.
    for (const name of ["Βοηθός", "Ассистент", "助手", "🤖", "   ", "---"]) {
      expect(slugify(name)).toBe("");
    }
  });
});

/**
 * Mirrors the builder's `slugError` ordering. Kept here as a pure rule so the
 * distinction between the two failures can be driven without mounting the form.
 */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function slugError(name: string, taken: Set<string> = new Set()): string | null {
  const slug = slugify(name);
  if (!name.trim()) return "A name is required.";
  if (!slug) return "identifier";
  if (!SLUG_RE.test(slug)) return "format";
  if (taken.has(slug)) return "taken";
  return null;
}

describe("the two different name failures", () => {
  it("reports an empty field as a missing name", () => {
    expect(slugError("")).toBe("A name is required.");
    expect(slugError("   ")).toBe("A name is required.");
  });

  it("reports a filled but unslugifiable name as an identifier problem", () => {
    // The bug the user hit: this said "A name is required" over a filled field.
    expect(slugError("Βοηθός")).toBe("identifier");
    expect(slugError("助手")).toBe("identifier");
  });

  it("accepts an ordinary name", () => {
    expect(slugError("Research Bot")).toBeNull();
  });

  it("still catches a duplicate", () => {
    expect(slugError("Research Bot", new Set(["research-bot"]))).toBe("taken");
  });
});
