// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import {
  buildAgentPayload,
  draftFromDetail,
} from "@/features/settings/lib/agentSpec";
import type { AgentDraft, CustomAgentDetail } from "@/shared/lib/types";

/**
 * The builder's tool list crosses a shape boundary and must round-trip.
 *
 * The UI, the catalog and every per-agent override row identify a tool by one
 * canonical key (`server/tool`); `agent.yaml` splits it into `server_id` +
 * `tool_name`. The split is on the FIRST slash only — a server id cannot
 * contain one but a tool name can — and getting it wrong writes a spec that
 * resolves to no live tool, so the agent silently loses the tool it declared.
 *
 * The inverse matters just as much: an edit hydrates the form from the saved
 * spec, so a field this direction drops is a field the next save deletes.
 */

const draft = (over: Partial<AgentDraft> = {}): AgentDraft => ({
  slug: "my-agent",
  name: "My agent",
  description: "",
  icon: "Bot",
  model: "gpt-5",
  prompt: "Do the thing.",
  memory: true,
  tools: [],
  skills: [],
  subagents: [],
  files: [],
  ...over,
});

const detail = (spec: Record<string, unknown>): CustomAgentDetail => ({
  id: "my-agent-v1",
  slug: "my-agent",
  name: "My agent",
  description: "",
  icon: "Bot",
  version: "1.0.0",
  type: "deep agent",
  spec: { model: { main: "gpt-5" }, ...spec },
  files: [{ path: "AGENT.md", content: "Do the thing.", encoding: "utf-8" }],
});

const specTools = (d: AgentDraft) =>
  (buildAgentPayload(d).spec as { tools: { server_id: string; tool_name: string }[] }).tools;

describe("declared tools — saving", () => {
  it("splits a key into the spec's two fields", () => {
    expect(specTools(draft({ tools: ["arxiv/download_paper"] }))).toEqual([
      { server_id: "arxiv", tool_name: "download_paper" },
    ]);
  });

  it("splits on the first slash only, so a tool name may contain more", () => {
    expect(specTools(draft({ tools: ["gateway/files/read"] }))).toEqual([
      { server_id: "gateway", tool_name: "files/read" },
    ]);
  });

  it("writes an empty list when nothing is declared", () => {
    expect(specTools(draft())).toEqual([]);
  });
});

describe("declared tools — hydrating an edit", () => {
  it("reads the spec's two fields back into one key", () => {
    const d = draftFromDetail(
      detail({ tools: [{ server_id: "arxiv", tool_name: "download_paper" }] }),
    );
    expect(d.tools).toEqual(["arxiv/download_paper"]);
  });

  it("skips native refs, which this form does not manage", () => {
    // A native ref has no server_id/tool_name. Mapping it blindly would produce
    // "undefined/undefined", which the next save would write back as a real —
    // and unresolvable — MCP tool.
    const d = draftFromDetail(
      detail({ tools: [{ native: "write_file" }, { server_id: "rag", tool_name: "sql_query" }] }),
    );
    expect(d.tools).toEqual(["rag/sql_query"]);
  });

  it("tolerates a spec with no tools key at all", () => {
    expect(draftFromDetail(detail({})).tools).toEqual([]);
  });
});

describe("round trip", () => {
  it("survives save → edit → save unchanged", () => {
    // The property that matters: opening an agent and saving it again must not
    // quietly change what it declares.
    const tools = ["arxiv/download_paper", "gateway/files/read", "rag/sql_query"];
    const saved = buildAgentPayload(draft({ tools }));
    const rehydrated = draftFromDetail(detail(saved.spec));
    expect(rehydrated.tools).toEqual(tools);
    expect(specTools(rehydrated)).toEqual(specTools(draft({ tools })));
  });
});
