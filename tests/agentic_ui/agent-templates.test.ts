import { describe, expect, it } from "vitest";

import { AGENT_TEMPLATES, findTemplate, teamSize } from "@/features/agents/lib/agentTemplates";
import { checkDraft } from "@/features/agents/lib/agentRules";
import { buildAgentPayload } from "@/features/agents/lib/agentSpec";

/**
 * The New agent screen's starter templates: each opens a filled-in draft that
 * already passes the builder's own checks, so Create works without an edit —
 * a lead, a nested team, and the reference guides its instructions point at.
 */
describe("starter templates", () => {
  it("have unique ids and are found by id", () => {
    const ids = AGENT_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(findTemplate("research")?.name).toBe("Deep research team");
    expect(findTemplate("nope")).toBeNull();
    expect(findTemplate(null)).toBeNull();
  });

  it.each(AGENT_TEMPLATES.map((t) => [t.id, t] as const))(
    "%s passes the builder's checks and builds a payload",
    (_id, template) => {
      const draft = template.draft("openai:gpt-5");
      expect(draft.model).toBe("openai:gpt-5");
      expect(draft.name).toBe(template.lead);
      expect(checkDraft(draft, { mode: "create" })).toEqual([]);
      expect(() => buildAgentPayload(draft)).not.toThrow();

      // A real team: several specialists, one of them with a team of its own.
      expect(teamSize(draft)).toBeGreaterThanOrEqual(5);
      expect(draft.subagents.some((s) => s.subagents.length > 0)).toBe(true);

      // Every guide the instructions name is a file the agent ships with.
      const named = [...JSON.stringify(draft).matchAll(/\/reference\/([\w./-]+\.md)/g)].map(
        (m) => m[1],
      );
      expect(named.length).toBeGreaterThan(0);
      const paths = new Set(draft.files.map((f) => f.path));
      named.forEach((path) => expect(paths).toContain(path));
    },
  );

  it("gives every opening a fresh draft, so edits never leak into the template", () => {
    const template = AGENT_TEMPLATES[0];
    const a = template.draft("m");
    const b = template.draft("m");
    expect(a).not.toBe(b);
    expect(a.subagents[0].uid).not.toBe(b.subagents[0].uid);
  });
});
