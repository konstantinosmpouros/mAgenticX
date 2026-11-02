/**
 * The agent.yaml contract on reads (`AgentSpecSchema`, plan 37).
 *
 * The UI reads a custom agent's spec typed but fail-open: a full nested spec
 * parses field for field, keys the UI does not know survive at every level (a
 * spec sent back must not lose a newer server's fields), and a malformed field
 * falls back to absent instead of crashing the page. The same schema backs
 * `CustomAgentDetailSchema`, `AgentVersionDetailSchema` and the import result.
 */
import { describe, expect, it } from "vitest";

import { draftFromDetail } from "@/features/agents/lib/agentSpec";
import {
  AgentSpecSchema,
  AgentVersionDetailSchema,
  CustomAgentDetailSchema,
  CustomAgentImportResultSchema,
} from "@/shared/lib/schemas";

const FULL = {
  id: "researcher-v1",
  slug: "researcher",
  name: "Researcher",
  version: "1.0.0",
  type: "deep_agent",
  description: "Digs.",
  icon: "Search",
  prompt: "./AGENT.md",
  model: { main: "openai:gpt-5", subagents: { scout: "openai:gpt-4o" } },
  memory: false,
  tools: [{ server_id: "web", tool_name: "search" }, { native: "read_file" }],
  skills: ["summarise", "cite"],
  hitl: { write_file: true, task: false },
  subagents: [
    {
      name: "scout",
      description: "Finds.",
      prompt: "./subagents/scout.md",
      model: "openai:gpt-4o-mini",
      tools: [{ server_id: "web", tool_name: "search" }],
      subagents: [
        {
          name: "checker",
          description: "Checks.",
          prompt: "./subagents/scout--checker.md",
          subagents: [{ name: "verifier", description: "Verifies.", prompt: "./v.md" }],
        },
      ],
    },
  ],
};

describe("AgentSpecSchema", () => {
  it("parses a full nested spec field for field", () => {
    const spec = AgentSpecSchema.parse(FULL);
    expect(spec).toEqual(FULL);
    expect(spec.subagents?.[0].subagents?.[0].subagents?.[0].name).toBe("verifier");
  });

  it("keeps unknown keys at the top level, in sub-agents at every depth, and in nested objects", () => {
    const raw = {
      ...FULL,
      future_field: { a: 1 },
      model: { ...FULL.model, temperature: 0.2 },
      tools: [{ server_id: "web", tool_name: "search", timeout_s: 30 }],
      subagents: [
        {
          ...FULL.subagents[0],
          budget: 5,
          subagents: [{ ...FULL.subagents[0].subagents[0], retries: 2 }],
        },
      ],
    };
    const spec = AgentSpecSchema.parse(raw);
    expect(spec).toEqual(raw);
    expect(spec.future_field).toEqual({ a: 1 });
    expect(spec.subagents?.[0].budget).toBe(5);
    expect(spec.subagents?.[0].subagents?.[0].retries).toBe(2);
    // A save that sends the spec carries them out again.
    expect(JSON.parse(JSON.stringify(spec))).toEqual(raw);
  });

  it("does not invent fields a spec did not have", () => {
    expect(AgentSpecSchema.parse({ slug: "a" })).toEqual({ slug: "a" });
  });

  it("drops a malformed field to absent instead of throwing", () => {
    const spec = AgentSpecSchema.parse({
      slug: "ok",
      name: 42,
      memory: "yes",
      model: 7,
      tools: "web/search",
      skills: ["fine", 3, null],
      hitl: { write_file: true, task: "sometimes" },
      subagents: [
        "not an object",
        { name: ["x"], description: "Kept.", tools: [null, { server_id: "web", tool_name: "s" }] },
      ],
    });
    expect(spec.slug).toBe("ok");
    expect(spec.name).toBeUndefined();
    expect(spec.memory).toBeUndefined();
    expect(spec.model).toBeUndefined();
    expect(spec.tools).toBeUndefined();
    expect(spec.skills).toEqual(["fine"]);
    expect(spec.hitl).toEqual({ write_file: true });
    // A non-object sub-agent stays in place as {}, so issue indices still line up.
    expect(spec.subagents).toHaveLength(2);
    expect(spec.subagents?.[0]).toEqual({});
    expect(spec.subagents?.[1].name).toBeUndefined();
    expect(spec.subagents?.[1].description).toBe("Kept.");
    expect(spec.subagents?.[1].tools).toEqual([{ server_id: "web", tool_name: "s" }]);
  });

  it("reads a spec that is not an object as an empty one", () => {
    for (const raw of [null, undefined, "yaml", 3, ["a"]]) {
      expect(AgentSpecSchema.parse(raw)).toEqual({});
    }
  });

  it("still reads a bare model id string", () => {
    expect(AgentSpecSchema.parse({ model: "openai:gpt-5" }).model).toBe("openai:gpt-5");
  });
});

describe("the schemas that carry a spec", () => {
  it("types the detail's and the version's spec, malformed or not", () => {
    const detail = CustomAgentDetailSchema.parse({ id: "c1", slug: "r", spec: { ...FULL, extra: 1 } });
    expect(detail.spec).toEqual({ ...FULL, extra: 1 });
    expect(CustomAgentDetailSchema.parse({ id: "c1", spec: "broken" }).spec).toEqual({});
    const version = AgentVersionDetailSchema.parse({ versionNo: 2, spec: { name: 5, slug: "r" } });
    expect(version.spec).toEqual({ slug: "r" });
  });

  it("keeps an import's missing spec null, and types a parsed one", () => {
    expect(CustomAgentImportResultSchema.parse({ valid: false, spec: null }).spec).toBeNull();
    expect(CustomAgentImportResultSchema.parse({ valid: false, spec: "x" }).spec).toBeNull();
    expect(CustomAgentImportResultSchema.parse({ valid: true, spec: FULL }).spec).toEqual(FULL);
  });

  it("opens a malformed spec in the builder on safe defaults", () => {
    const detail = CustomAgentDetailSchema.parse({
      id: "c1",
      slug: "r",
      name: "R",
      spec: { model: 7, memory: "no", skills: "x", hitl: [], subagents: [5, { name: "scout" }] },
      files: [{ path: "AGENT.md", content: "Help." }],
    });
    const draft = draftFromDetail(detail);
    // No guessed model: the builder asks for one ("Choose a model").
    expect(draft.model).toBe("");
    expect(draft.memory).toBe(true);
    expect(draft.skills).toEqual([]);
    expect(draft.hitl).toEqual({});
    expect(draft.prompt).toBe("Help.");
    expect(draft.subagents.map((sa) => sa.name)).toEqual(["", "scout"]);
  });
});
