import { describe, expect, it } from "vitest";

import { AGENT_TEMPLATES } from "@/features/agents/lib/agentTemplates";
import { MAX_PROMPT_BYTES, checkDraft } from "@/features/agents/lib/agentRules";

/**
 * An agent's instructions, and each sub-agent's at every depth, are at most
 * 64 KiB — as the server checks on save. Reference files keep their own,
 * larger per-file limit.
 */
describe("the prompt limit", () => {
  const draft = () => AGENT_TEMPLATES[0].draft("openai:gpt-5");
  const errorsAt = (d: ReturnType<typeof draft>) =>
    checkDraft(d, { mode: "create" })
      .filter((issue) => issue.severity === "error")
      .map((issue) => issue.path);

  it("allows a prompt of exactly 64 KiB", () => {
    expect(MAX_PROMPT_BYTES).toBe(64 * 1024);
    expect(errorsAt({ ...draft(), prompt: "x".repeat(MAX_PROMPT_BYTES) })).toEqual([]);
  });

  it("refuses the agent's own prompt past it", () => {
    expect(errorsAt({ ...draft(), prompt: "x".repeat(MAX_PROMPT_BYTES + 1) })).toEqual(["prompt"]);
  });

  it("refuses a nested sub-agent's prompt past it", () => {
    const d = draft();
    const parent = d.subagents.findIndex((s) => s.subagents.length > 0);
    d.subagents[parent].subagents[0].prompt = "x".repeat(MAX_PROMPT_BYTES + 1);
    expect(errorsAt(d)).toEqual([`subagents.${parent}.subagents.0.prompt`]);
  });

  it("leaves a larger reference file to the per-file limit", () => {
    const d = draft();
    const files = [...d.files, { path: "guides/long.md", content: "x".repeat(200 * 1024) }];
    expect(errorsAt({ ...d, files })).toEqual([]);
  });
});
