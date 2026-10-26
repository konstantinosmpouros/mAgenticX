// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";

import treeCases from "./fixtures/agent-tree-cases.json";
import {
  buildAgentPayload,
  draftFromDetail,
  emptyDraft,
  emptySubagent,
  nestedSubagentPromptPath,
} from "@/features/agents/lib/agentSpec";
import { checkDraft, draftUsage, MAX_FILES } from "@/features/agents/lib/agentRules";
import {
  ROOT_UID,
  countByNode,
  mergeIssues,
  placeIssues,
  targetOf,
} from "@/features/agents/lib/agentIssues";
import { approvalChanges, approvalRows, riskNote } from "@/features/agents/lib/agentApprovals";
import { buildBuilderFlow, GHOST_ID, neighbourOf } from "@/features/agents/lib/builderFlow";
import { draftReducer, locate, type DraftAction } from "@/features/agents/hooks/useAgentDraft";
import { importOutcome } from "@/features/agents/lib/importResult";
import {
  clearStoredDraft,
  draftStorageKey,
  readStoredDraft,
  writeStoredDraft,
} from "@/features/agents/lib/draftStorage";
import { helpFieldFor } from "@/features/agents/lib/yamlHelp";
import type {
  AgentDraft,
  AgentDraftSubAgent,
  AgentToolRow,
  BuiltinToolInfo,
  CustomAgentDetail,
} from "@/shared/lib/types";

/**
 * The canvas builder's logic (plan 44 P3+P4), without a page: the draft
 * reducer (stable uids, updates by path, the tool cascade), the client rules
 * against the same table the server is tested on, issue paths landing on
 * nodes and fields, a 3-level round trip through the spec, the approvals
 * diff saved after the agent, the canvas's add limits, the import's result
 * states and the autosave.
 */

const node = (name: string, over: Partial<AgentDraftSubAgent> = {}): AgentDraftSubAgent => ({
  ...emptySubagent(),
  name,
  description: `The ${name}.`,
  prompt: `You are ${name}.`,
  ...over,
});

/** researcher → fact-checker → source-checker, and a writer beside the researcher. */
const threeLevels = (): AgentDraft => ({
  ...emptyDraft("openai:gpt-5"),
  slug: "market-researcher",
  name: "Market Researcher",
  prompt: "You research markets.",
  tools: ["web/search", "web/fetch", "db/query"],
  subagents: [
    node("researcher", {
      tools: ["web/search", "web/fetch"],
      subagents: [
        node("fact-checker", {
          model: "openai:gpt-4o-mini",
          tools: ["web/search"],
          subagents: [node("source-checker")],
        }),
      ],
    }),
    node("writer"),
  ],
});

const run = (draft: AgentDraft, ...actions: DraftAction[]) => actions.reduce(draftReducer, draft);
const uidOf = (draft: AgentDraft, ...indices: number[]) => {
  let list = draft.subagents;
  let found: AgentDraftSubAgent | undefined;
  for (const index of indices) {
    found = list[index];
    list = found.subagents;
  }
  return found!.uid;
};

// ---------------------------------------------------------------------------
describe("the draft reducer", () => {
  it("updates a node three levels down by uid, leaving the rest as they were", () => {
    const draft = threeLevels();
    const deep = uidOf(draft, 0, 0, 0);
    const next = run(draft, { type: "update-node", uid: deep, patch: { prompt: "Rate sources." } });
    expect(locate(next, deep)?.node.prompt).toBe("Rate sources.");
    expect(locate(next, deep)?.path).toEqual([0, 0, 0]);
    // Untouched branches keep their identity (no needless re-render or re-layout).
    expect(next.subagents[1]).toBe(draft.subagents[1]);
  });

  it("keeps every uid stable when a sibling before it is removed", () => {
    const draft = threeLevels();
    const writer = uidOf(draft, 1);
    const next = run(draft, { type: "remove-node", uid: uidOf(draft, 0) });
    expect(next.subagents.map((n) => n.uid)).toEqual([writer]);
    expect(locate(next, writer)?.path).toEqual([0]);
  });

  it("removes a node with its whole branch", () => {
    const draft = threeLevels();
    const deep = uidOf(draft, 0, 0, 0);
    const next = run(draft, { type: "remove-node", uid: uidOf(draft, 0, 0) });
    expect(locate(next, deep)).toBeNull();
    expect(next.subagents[0].subagents).toEqual([]);
  });

  it("adds children up to the third level and no further", () => {
    const draft = threeLevels();
    const added = run(draft, { type: "add-child", parentUid: uidOf(draft, 0, 0), uid: "new-1" });
    expect(locate(added, "new-1")?.depth).toBe(3);
    const refused = run(added, { type: "add-child", parentUid: "new-1", uid: "new-2" });
    expect(refused).toBe(added);
    const top = run(draft, { type: "add-child", parentUid: ROOT_UID, uid: "top" });
    expect(top.subagents.map((n) => n.uid).at(-1)).toBe("top");
  });

  it("duplicates a branch beside the original, with fresh uids and a free name", () => {
    const draft = threeLevels();
    const original = uidOf(draft, 0);
    const once = run(draft, { type: "duplicate-node", uid: original, newUid: "copy" });
    expect(once.subagents.map((n) => n.name)).toEqual(["researcher", "researcher-copy", "writer"]);
    const twice = run(once, { type: "duplicate-node", uid: original, newUid: "copy-2" });
    expect(twice.subagents[1].name).toBe("researcher-copy-2");
    const copyUids = [...walkUids(twice.subagents[2])];
    const originalUids = new Set(walkUids(twice.subagents[0]));
    expect(copyUids.some((uid) => originalUids.has(uid))).toBe(false);
  });

  it("removes a tool taken off the agent from every node below", () => {
    const draft = threeLevels();
    const next = run(draft, { type: "remove-tool", key: "web/search" });
    expect(next.subagents[0].tools).toEqual(["web/fetch"]);
    // The fact-checker had only that one: it now inherits what is left above.
    expect(next.subagents[0].subagents[0].tools).toEqual([]);
  });

  it("narrows the nodes below when a node picks fewer tools", () => {
    const draft = threeLevels();
    const next = run(draft, { type: "set-node-tools", uid: uidOf(draft, 0), tools: ["web/fetch"] });
    expect(next.subagents[0].tools).toEqual(["web/fetch"]);
    expect(next.subagents[0].subagents[0].tools).toEqual([]);
  });

  it("drops a removed tool's approval choice and its definition default", () => {
    const draft = { ...threeLevels(), hitl: { query: true, write_file: false }, approvals: { "db/query": false } };
    const next = run(draft, { type: "remove-tool", key: "db/query" });
    expect(next.hitl).toEqual({ write_file: false });
    expect(next.approvals).toEqual({});
  });

  it("lets the slug follow the name only when asked", () => {
    const draft = emptyDraft();
    expect(run(draft, { type: "set-name", value: "Café Bot", followSlug: true }).slug).toBe("cafe-bot");
    const edited = { ...draft, slug: "fixed" };
    expect(run(edited, { type: "set-name", value: "New", followSlug: false }).slug).toBe("fixed");
  });
});

function* walkUids(node: AgentDraftSubAgent): Generator<string> {
  yield node.uid;
  for (const child of node.subagents) yield* walkUids(child);
}

// ---------------------------------------------------------------------------
describe("the builder's rules, against the server's table", () => {
  type Case = { name: string; tools: unknown[]; subagents: unknown[]; errors: string[] };
  const withPrompts = (nodes: unknown[], above: string[] = []): unknown[] =>
    (nodes as Array<Record<string, unknown>>).map((n) => {
      const names = [...above, String(n.name)];
      return {
        ...n,
        prompt: `./${nestedSubagentPromptPath(names)}`,
        subagents: withPrompts((n.subagents as unknown[]) ?? [], names),
      };
    });
  const filesFor = (nodes: unknown[], above: string[] = []): { path: string; content: string; encoding: "utf-8" }[] =>
    (nodes as Array<Record<string, unknown>>).flatMap((n) => {
      const names = [...above, String(n.name)];
      return [
        { path: nestedSubagentPromptPath(names), content: "Work.", encoding: "utf-8" as const },
        ...filesFor((n.subagents as unknown[]) ?? [], names),
      ];
    });

  for (const c of (treeCases as { cases: Case[] }).cases) {
    it(c.name, () => {
      const detail: CustomAgentDetail = {
        id: "",
        slug: "agent",
        name: "Agent",
        description: "",
        icon: "Bot",
        version: undefined,
        type: "deep agent",
        spec: { slug: "agent", tools: c.tools, subagents: withPrompts(c.subagents) },
        files: [{ path: "AGENT.md", content: "Help.", encoding: "utf-8" }, ...filesFor(c.subagents)],
      };
      const draft = draftFromDetail(detail);
      const paths = checkDraft(draft, { mode: "edit" })
        .filter((issue) => issue.severity === "error" && issue.path.startsWith("subagents"))
        .map((issue) => issue.path);
      expect(new Set(paths)).toEqual(new Set(c.errors));
    });
  }

  it("counts the file quota over every prompt at every depth", () => {
    const draft = threeLevels();
    expect(draftUsage(draft).fileCount).toBe(5);
    const crowded = {
      ...draft,
      files: Array.from({ length: MAX_FILES - 4 }, (_, i) => ({ path: `notes/${i}.md`, content: "x" })),
    };
    expect(checkDraft(crowded, { mode: "edit" }).some((i) => i.path === "files")).toBe(true);
  });

  it("marks an empty field as still to fill, not as wrong", () => {
    const issues = checkDraft({ ...emptyDraft(), subagents: [{ ...emptySubagent() }] }, { mode: "create" });
    const required = issues.filter((i) => i.required).map((i) => i.path);
    expect(required).toEqual(
      expect.arrayContaining(["name", "prompt", "subagents.0.name", "subagents.0.description", "subagents.0.prompt"]),
    );
  });
});

// ---------------------------------------------------------------------------
describe("issue paths → nodes and fields", () => {
  const draft = threeLevels();
  it.each([
    ["name", ROOT_UID, "name", "identity"],
    ["slug", ROOT_UID, "name", "identity"],
    ["model.main", ROOT_UID, "model", "identity"],
    ["prompt", ROOT_UID, "prompt", "instructions"],
    ["tools.2", ROOT_UID, "tools", "tools"],
    ["skills.0", ROOT_UID, "skills", "skills"],
    ["hitl.write_file", ROOT_UID, "approvals", "approvals"],
    ["files[AGENT.md]", ROOT_UID, "prompt", "instructions"],
    ["files[notes/a.md]", ROOT_UID, "files", "files"],
    ["", ROOT_UID, "general", "identity"],
  ])("%s → the main agent's %s", (path, uid, field, section) => {
    expect(targetOf(path, draft)).toMatchObject({ uid, field, section });
  });

  it("finds a node by its index path, three levels down", () => {
    expect(targetOf("subagents.0.subagents.0.subagents.0.name", draft)).toEqual({
      uid: uidOf(draft, 0, 0, 0),
      field: "name",
      section: null,
    });
    expect(targetOf("subagents.1", draft)).toMatchObject({ uid: uidOf(draft, 1), field: "general" });
  });

  it("finds a sub-agent's prompt file, and an older spec's model.subagents entry", () => {
    expect(targetOf("files[subagents/researcher--fact-checker.md]", draft)).toMatchObject({
      uid: uidOf(draft, 0, 0),
      field: "prompt",
    });
    expect(targetOf("model.subagents.writer", draft)).toMatchObject({ uid: uidOf(draft, 1), field: "model" });
  });

  it("falls back to the deepest node it has for a path deeper than the draft", () => {
    expect(targetOf("subagents.1.subagents.4.name", draft)).toMatchObject({ uid: uidOf(draft, 1) });
  });

  it("keeps the server's answer on its node after the draft changes", () => {
    const placed = placeIssues(
      [{ path: "subagents.1.name", message: "x", severity: "error", source: "server" }],
      draft,
    );
    const writer = uidOf(draft, 1);
    // The researcher goes: the writer is now subagents.0, its uid unchanged.
    expect(placed[0].target.uid).toBe(writer);
    expect(countByNode(placed).get(writer)).toBe(1);
  });

  it("says a rule once when both checkers report the same spot", () => {
    const client = placeIssues([{ path: "name", message: "Give it a name.", severity: "error", source: "client" }], draft);
    const server = placeIssues(
      [
        { path: "slug", message: "Invalid agent slug", severity: "error", source: "server" },
        { path: "model.main", message: "Not allowed here.", severity: "error", source: "server" },
      ],
      draft,
    );
    expect(mergeIssues(client, server).map((i) => i.message)).toEqual(["Give it a name.", "Not allowed here."]);
  });
});

// ---------------------------------------------------------------------------
describe("the spec round trip at three levels", () => {
  const asDetail = (payload: ReturnType<typeof buildAgentPayload>): CustomAgentDetail => ({
    id: "c1",
    slug: String(payload.spec.slug),
    name: String(payload.spec.name),
    description: String(payload.spec.description),
    icon: String(payload.spec.icon),
    version: "1.0.0",
    type: "deep agent",
    spec: payload.spec,
    files: payload.files,
  });
  const strip = (draft: AgentDraft) =>
    JSON.parse(JSON.stringify(draft, (key, value) => (key === "uid" ? undefined : value)));

  it("comes back as the same draft, and saves to the same payload", () => {
    const original = { ...threeLevels(), files: [{ path: "notes/style.md", content: "Be brief." }], hitl: { write_file: false } };
    const saved = buildAgentPayload(original);
    const back = draftFromDetail(asDetail(saved));
    expect(strip(back)).toEqual(strip(original));
    expect(buildAgentPayload(back)).toEqual(saved);
    // Each node's prompt is its own file, named by its path.
    expect(saved.files.map((f) => f.path)).toEqual([
      "AGENT.md",
      "subagents/researcher.md",
      "subagents/researcher--fact-checker.md",
      "subagents/researcher--fact-checker--source-checker.md",
      "subagents/writer.md",
      "notes/style.md",
    ]);
  });

  it("writes each node's own model and no model.subagents map", () => {
    const saved = buildAgentPayload(threeLevels());
    expect(saved.spec.model).toEqual({ main: "openai:gpt-5" });
    const researcher = (saved.spec.subagents as Array<{ subagents: Array<{ model?: string }> }>)[0];
    expect(researcher.subagents[0].model).toBe("openai:gpt-4o-mini");
  });

  it("folds an older spec's model.subagents into the nodes it names", () => {
    const draft = draftFromDetail({
      ...asDetail(buildAgentPayload(threeLevels())),
      spec: {
        ...buildAgentPayload(threeLevels()).spec,
        model: { main: "openai:gpt-5", subagents: { writer: "openai:gpt-4o" } },
      },
    });
    expect(draft.subagents[1].model).toBe("openai:gpt-4o");
    expect(buildAgentPayload(draft).spec.model).toEqual({ main: "openai:gpt-5" });
  });

  it("no longer writes the old approval floor, and keeps an imported hitl as it came", () => {
    expect(buildAgentPayload(emptyDraft()).spec).not.toHaveProperty("hitl");
    expect(buildAgentPayload({ ...emptyDraft(), hitl: { write_file: false } }).spec.hitl).toEqual({
      write_file: false,
    });
  });

  it("writes an unfinished node in place, so the server's indices match the canvas", () => {
    const draft = { ...threeLevels(), subagents: [{ ...emptySubagent() }, node("writer")] };
    const subs = buildAgentPayload(draft).spec.subagents as Array<{ name: string }>;
    expect(subs.map((s) => s.name)).toEqual(["", "writer"]);
  });
});

// ---------------------------------------------------------------------------
describe("approvals, saved after the agent", () => {
  const builtins: BuiltinToolInfo[] = [
    { name: "write_file", description: "", group: "Filesystem", hitlDefault: true, locked: false, gateable: true, mainOnly: false },
    { name: "read_file", description: "", group: "Filesystem", hitlDefault: false, locked: false, gateable: true, mainOnly: false },
    { name: "execute", description: "", group: "Execution", hitlDefault: true, locked: true, gateable: true, mainOnly: false },
    { name: "ask_user", description: "", group: "Interaction", hitlDefault: false, locked: false, gateable: false, mainOnly: true },
  ];
  const rowsFor = (draft: AgentDraft, liveRows: AgentToolRow[] | null = null) =>
    approvalRows({ draft, builtins, catalog: [], liveRows });

  it("starts from the platform default, and an imported hitl over it", () => {
    const rows = rowsFor({ ...emptyDraft(), tools: ["web/search"], hitl: { search: true } });
    const value = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    expect(value).toEqual({ write_file: true, read_file: false, execute: true, ask_user: false, "web/search": true });
    expect(approvalChanges(rows)).toEqual({});
  });

  it("sends only what moved, never a locked or ungateable tool", () => {
    const draft = {
      ...emptyDraft(),
      tools: ["web/search"],
      approvals: { write_file: false, "web/search": true, execute: false, ask_user: true, read_file: false },
    };
    expect(approvalChanges(rowsFor(draft))).toEqual({ write_file: false, "web/search": true });
  });

  it("editing, starts from the agent's rows and sends null to go back to the default", () => {
    const live = [
      { key: "write_file", name: "write_file", description: "", kind: "builtin", group: "Filesystem", declared: true, available: true, unavailableReason: null, enabled: true, approval: false, approvalLocked: false },
    ] as AgentToolRow[];
    const unchanged = rowsFor(emptyDraft(), live);
    expect(unchanged.find((r) => r.key === "write_file")?.value).toBe(false);
    expect(approvalChanges(unchanged)).toEqual({});
    const reset = rowsFor({ ...emptyDraft(), approvals: { write_file: true } }, live);
    expect(approvalChanges(reset)).toEqual({ write_file: null });
  });

  it("warns in plain words when a risky tool stops asking", () => {
    const rows = rowsFor({ ...emptyDraft(), approvals: { write_file: false } });
    const row = rows.find((r) => r.key === "write_file")!;
    expect(row.changed).toBe(true);
    expect(riskNote(row)).toBe("This agent will write files without asking.");
    expect(riskNote(rows.find((r) => r.key === "read_file")!)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("the canvas", () => {
  const modelLabel = (id: string) => id.replace(/^openai:/, "");

  it("draws the main agent, every node and a + only above the third level", () => {
    const draft = threeLevels();
    const flow = buildBuilderFlow(draft, { modelLabel, selectedUid: uidOf(draft, 0) });
    expect(flow.nodes).toHaveLength(5);
    const byDepth = Object.fromEntries(flow.nodes.map((n) => [n.id, n.data as { depth: number; canAdd: boolean }]));
    expect(byDepth[ROOT_UID]).toMatchObject({ depth: 0, canAdd: true });
    expect(byDepth[uidOf(draft, 0, 0)]).toMatchObject({ depth: 2, canAdd: true });
    expect(byDepth[uidOf(draft, 0, 0, 0)]).toMatchObject({ depth: 3, canAdd: false });
    expect(flow.edges).toHaveLength(4);
  });

  it("shows a node's model only where it differs from the one above, and inherited tools as such", () => {
    const draft = threeLevels();
    const flow = buildBuilderFlow(draft, { modelLabel });
    const data = (uid: string) => flow.nodes.find((n) => n.id === uid)!.data as { model: string | null; tools: unknown };
    expect(data(uidOf(draft, 0)).model).toBeNull();
    expect(data(uidOf(draft, 0, 0)).model).toBe("gpt-4o-mini");
    expect(data(uidOf(draft, 0, 0, 0)).model).toBeNull();
    expect(data(uidOf(draft, 1)).tools).toBe("inherit");
    expect(data(uidOf(draft, 0)).tools).toBe(2);
  });

  it("offers a ghost 'Add a sub-agent' only on an editable agent with no team", () => {
    expect(buildBuilderFlow(emptyDraft(), { modelLabel }).nodes.map((n) => n.id)).toEqual([ROOT_UID, GHOST_ID]);
    expect(buildBuilderFlow(emptyDraft(), { modelLabel, readOnly: true }).nodes).toHaveLength(1);
  });

  it("lays the tree out top-down without overlaps", () => {
    const flow = buildBuilderFlow(threeLevels(), { modelLabel });
    const rows = new Map<number, Array<{ x: number; width: number }>>();
    for (const n of flow.nodes) {
      const list = rows.get(n.position.y) ?? [];
      list.push({ x: n.position.x, width: n.width ?? 0 });
      rows.set(n.position.y, list);
    }
    for (const list of rows.values()) {
      list.sort((a, b) => a.x - b.x);
      for (let i = 1; i < list.length; i += 1) {
        expect(list[i].x).toBeGreaterThanOrEqual(list[i - 1].x + list[i - 1].width);
      }
    }
  });

  it("moves between nodes with the arrow keys", () => {
    const draft = threeLevels();
    const flow = buildBuilderFlow(draft, { modelLabel });
    expect(neighbourOf(flow, ROOT_UID, "ArrowDown")).toBe(uidOf(draft, 0));
    expect(neighbourOf(flow, uidOf(draft, 0), "ArrowRight")).toBe(uidOf(draft, 1));
    expect(neighbourOf(flow, uidOf(draft, 0, 0), "ArrowUp")).toBe(uidOf(draft, 0));
    expect(neighbourOf(flow, uidOf(draft, 0, 0, 0), "ArrowDown")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("the import's result", () => {
  const base = { errors: [], files: [] };

  it("a YAML that didn't parse says where", () => {
    const outcome = importOutcome({
      ...base,
      valid: false,
      spec: null,
      issues: [{ path: "", message: "The YAML doesn't parse (line 3, column 5): bad indent.", severity: "error" }],
    });
    expect(outcome).toEqual({
      kind: "unparsed",
      messages: ["The YAML doesn't parse (line 3, column 5): bad indent."],
    });
  });

  it("an invalid one opens with its issues on its nodes", () => {
    const outcome = importOutcome({
      valid: false,
      errors: ["x"],
      issues: [{ path: "subagents.0.subagents.0.tools", message: "Not the parent's.", severity: "error" }],
      spec: {
        slug: "r",
        name: "R",
        prompt: "./AGENT.md",
        subagents: [{ name: "a", description: "A.", prompt: "./subagents/a.md", subagents: [{ name: "b", description: "B.", prompt: "./subagents/a--b.md" }] }],
      },
      files: [
        { path: "AGENT.md", content: "Go.", encoding: "utf-8" },
        { path: "subagents/a.md", content: "A.", encoding: "utf-8" },
        { path: "subagents/a--b.md", content: "B.", encoding: "utf-8" },
      ],
    });
    expect(outcome.kind).toBe("invalid");
    if (outcome.kind === "unparsed") return;
    const b = outcome.draft.subagents[0].subagents[0];
    expect(outcome.issues[0].target).toMatchObject({ uid: b.uid, field: "tools" });
    expect(b.prompt).toBe("B.");
    expect(outcome.summary).toMatchObject({ team: 2, levels: 2, files: 3 });
  });

  it("a valid one creates from the server's own payload", () => {
    const spec = { slug: "r", name: "R", prompt: "./AGENT.md", hitl: { write_file: false } };
    const outcome = importOutcome({
      valid: true,
      errors: [],
      issues: [{ path: "tools", message: "Couldn't reach the gateway.", severity: "warning" }],
      spec,
      files: [{ path: "AGENT.md", content: "Go.", encoding: "utf-8" }],
    });
    expect(outcome.kind).toBe("valid");
    if (outcome.kind === "unparsed") return;
    expect(outcome.payload.spec).toBe(spec);
    expect(outcome.draft.hitl).toEqual({ write_file: false });
  });

  it("links an issue to its field in the help", () => {
    expect(helpFieldFor("subagents.0.subagents.1.tools")).toBe("subagents.tools");
    expect(helpFieldFor("model.main")).toBe("model");
    expect(helpFieldFor("files[AGENT.md]")).toBe("files");
    expect(helpFieldFor("")).toBe("errors");
  });
});

// ---------------------------------------------------------------------------
describe("autosave", () => {
  const key = draftStorageKey("u1", null);
  beforeEach(() => window.localStorage.clear());

  it("keys the draft by user and agent, and reads back what it wrote", () => {
    expect(key).toBe("agent-draft:u1:new");
    expect(draftStorageKey("u1", "c9")).toBe("agent-draft:u1:c9");
    writeStoredDraft(key, threeLevels(), 1234);
    const stored = readStoredDraft(key);
    expect(stored?.savedAt).toBe(1234);
    expect(stored?.draft.subagents[0].subagents[0].name).toBe("fact-checker");
    clearStoredDraft(key);
    expect(readStoredDraft(key)).toBeNull();
  });

  it("ignores an entry that isn't a draft", () => {
    window.localStorage.setItem(key, JSON.stringify({ savedAt: 1, draft: { name: 3 } }));
    expect(readStoredDraft(key)).toBeNull();
    window.localStorage.setItem(key, "{not json");
    expect(readStoredDraft(key)).toBeNull();
  });
});
