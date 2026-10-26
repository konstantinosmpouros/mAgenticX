// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import {
  buildAgentPayload,
  draftFromDetail,
  emptySubagent,
} from "@/features/agents/lib/agentSpec";
import type { AgentDraft, AgentDraftSubAgent, CustomAgentDetail } from "@/shared/lib/types";

/**
 * Sub-agents carry their own model and a tool subset (plan 20 §5.3).
 *
 * "Inherit" is spelled by OMISSION in the spec: a sub-agent with no `model`
 * runs on the agent's model, and one with no `tools` gets every tool the agent
 * has. So the form's blank values must never be written as `""` or `[]` — an
 * empty list would be read as "no tools at all". And because the agents service
 * refuses a sub-agent tool its agent does not declare, a tool removed from the
 * agent must not survive on a sub-agent into the saved spec.
 */

const sub = (over: Partial<AgentDraftSubAgent> = {}): AgentDraftSubAgent => ({
  ...emptySubagent(),
  name: "researcher",
  description: "Finds sources",
  prompt: "Research things.",
  ...over,
});

const draft = (over: Partial<AgentDraft> = {}): AgentDraft => ({
  slug: "my-agent",
  name: "My agent",
  description: "",
  icon: "Bot",
  model: "openai:gpt-4o",
  prompt: "Do the thing.",
  memory: true,
  tools: ["tavily/search", "arxiv/search_papers"],
  skills: [],
  subagents: [],
  files: [],
  ...over,
});

type SpecSub = {
  name: string;
  model?: string;
  tools?: { server_id: string; tool_name: string }[];
};
const specSubs = (d: AgentDraft) =>
  (buildAgentPayload(d).spec as { subagents: SpecSub[] }).subagents;

const detail = (
  spec: Record<string, unknown>,
  files: { path: string; content: string }[] = [],
): CustomAgentDetail => ({
  id: "my-agent-v1",
  slug: "my-agent",
  name: "My agent",
  description: "",
  icon: "Bot",
  version: "1.0.0",
  type: "deep agent",
  spec: { model: { main: "openai:gpt-4o" }, ...spec },
  files: [
    { path: "AGENT.md", content: "Do the thing.", encoding: "utf-8" },
    ...files.map((f) => ({ ...f, encoding: "utf-8" as const })),
  ],
});

describe("a new sub-agent", () => {
  it("starts out inheriting the agent's model and tools", () => {
    expect(emptySubagent()).toEqual({
      name: "",
      description: "",
      prompt: "",
      model: "",
      tools: [],
    });
  });
});

describe("sub-agents — saving", () => {
  it("omits model and tools to inherit, rather than writing blanks", () => {
    const [s] = specSubs(draft({ subagents: [sub()] }));
    expect(s).not.toHaveProperty("model");
    // An empty list would mean "no tools" to the runtime, not "all of them".
    expect(s).not.toHaveProperty("tools");
  });

  it("writes an explicit model and tool subset in the spec's shapes", () => {
    const [s] = specSubs(
      draft({ subagents: [sub({ model: "openai:gpt-4o-mini", tools: ["arxiv/search_papers"] })] }),
    );
    expect(s.model).toBe("openai:gpt-4o-mini");
    expect(s.tools).toEqual([{ server_id: "arxiv", tool_name: "search_papers" }]);
  });

  it("drops a sub-agent tool the agent no longer declares", () => {
    // The server refuses it outright; the builder prunes on removal, and the
    // payload filters too so no path can produce a rejected spec.
    const [s] = specSubs(
      draft({
        tools: ["tavily/search"],
        subagents: [sub({ tools: ["arxiv/search_papers", "tavily/search"] })],
      }),
    );
    expect(s.tools).toEqual([{ server_id: "tavily", tool_name: "search" }]);
  });

  it("falls back to inherit when every picked tool has left the agent", () => {
    const [s] = specSubs(
      draft({ tools: [], subagents: [sub({ tools: ["arxiv/search_papers"] })] }),
    );
    expect(s).not.toHaveProperty("tools");
  });
});

describe("sub-agents — hydrating an edit", () => {
  it("reads model and MCP tools back, and treats absence as inherit", () => {
    const d = draftFromDetail(
      detail(
        {
          subagents: [
            {
              name: "researcher",
              description: "Finds sources",
              prompt: "./subagents/researcher.md",
              model: "openai:gpt-5",
              tools: [{ server_id: "arxiv", tool_name: "search_papers" }, { native: "remember" }],
            },
            { name: "writer", description: "Writes", prompt: "./subagents/writer.md" },
          ],
        },
        [
          { path: "subagents/researcher.md", content: "Research." },
          { path: "subagents/writer.md", content: "Write." },
        ],
      ),
    );
    expect(d.subagents.map(({ name, model, tools }) => ({ name, model, tools }))).toEqual([
      // Native refs are skipped, as for the agent's own list.
      { name: "researcher", model: "openai:gpt-5", tools: ["arxiv/search_papers"] },
      { name: "writer", model: "", tools: [] },
    ]);
  });
});

describe("round trip", () => {
  it("survives save → edit → save unchanged", () => {
    const original = draft({
      subagents: [
        sub({ model: "openai:gpt-4o-mini", tools: ["arxiv/search_papers"] }),
        sub({ name: "writer", description: "Writes", prompt: "Write." }),
      ],
    });
    const saved = buildAgentPayload(original);
    const rehydrated = draftFromDetail(detail(saved.spec, saved.files));
    expect(specSubs(rehydrated)).toEqual(specSubs(original));
  });
});

describe("nested sub-agents (a sub-agent's own sub-agents)", () => {
  type NestedSub = SpecSub & { subagents?: SpecSub[] };
  const nestedDetail = () =>
    detail(
      {
        tools: [{ server_id: "arxiv", tool_name: "search_papers" }],
        subagents: [
          {
            name: "researcher",
            description: "Finds sources",
            prompt: "./subagents/researcher.md",
            subagents: [
              {
                name: "fact-checker",
                description: "Checks one claim",
                prompt: "./subagents/researcher--fact-checker.md",
                tools: [{ server_id: "arxiv", tool_name: "search_papers" }],
              },
            ],
          },
        ],
      },
      [
        { path: "subagents/researcher.md", content: "Research." },
        { path: "subagents/researcher--fact-checker.md", content: "Check." },
      ],
    );

  it("keeps them, with their prompts, through edit → save", () => {
    const d = draftFromDetail(nestedDetail());
    // Their prompt files are theirs, not reference files the user would see.
    expect(d.files).toEqual([]);
    expect(
      d.subagents[0].subagents?.map(({ name, prompt, tools }) => ({ name, prompt, tools })),
    ).toEqual([{ name: "fact-checker", prompt: "Check.", tools: ["arxiv/search_papers"] }]);
    const saved = buildAgentPayload(d);
    const [researcher] = (saved.spec as { subagents: NestedSub[] }).subagents;
    expect(researcher.subagents).toEqual([
      {
        name: "fact-checker",
        description: "Checks one claim",
        prompt: "./subagents/researcher--fact-checker.md",
        tools: [{ server_id: "arxiv", tool_name: "search_papers" }],
      },
    ]);
    expect(
      saved.files.find((f) => f.path === "subagents/researcher--fact-checker.md")?.content,
    ).toBe("Check.");
  });

  it("drops a nested tool the agent no longer declares", () => {
    const d = draftFromDetail(nestedDetail());
    const saved = buildAgentPayload({ ...d, tools: [] });
    const [researcher] = (saved.spec as { subagents: NestedSub[] }).subagents;
    expect(researcher.subagents?.[0]).not.toHaveProperty("tools");
  });
});
