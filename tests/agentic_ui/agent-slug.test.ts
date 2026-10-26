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

import { emptyDraft, slugify } from "@/features/agents/lib/agentSpec";
import { checkDraft } from "@/features/agents/lib/agentRules";

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
 * The builder's own name rule (lib/agentRules), driven without mounting it: an
 * empty field is a missing name, a filled one with no Latin letter is an
 * identifier problem, and a slug you already have is taken.
 */
const nameIssue = (name: string, taken: Set<string> = new Set()) =>
  checkDraft(
    { ...emptyDraft(), name, slug: slugify(name), prompt: "Help." },
    { mode: "create", takenSlugs: taken },
  ).find((issue) => issue.path === "name");

describe("the two different name failures", () => {
  it("reports an empty field as a missing name, shown once touched", () => {
    expect(nameIssue("")).toMatchObject({ message: "Give the agent a name.", required: true });
    expect(nameIssue("   ")?.required).toBe(true);
  });

  it("reports a filled but unslugifiable name as an identifier problem", () => {
    // The bug the user hit: this said "A name is required" over a filled field.
    expect(nameIssue("Βοηθός")?.message).toMatch(/identifier/);
    expect(nameIssue("助手")?.message).toMatch(/identifier/);
    expect(nameIssue("助手")?.required).toBeFalsy();
  });

  it("accepts an ordinary name", () => {
    expect(nameIssue("Research Bot")).toBeUndefined();
  });

  it("still catches a duplicate", () => {
    expect(nameIssue("Research Bot", new Set(["research-bot"]))?.message).toMatch(/already have/);
  });
});
