import { useCallback, useMemo, useReducer, useState } from "react";

import type { AgentDraft, AgentDraftFile, AgentDraftSubAgent } from "@/shared/lib/types";
import {
  emptySubagent,
  newUid,
  slugify,
  toolNameOf,
} from "@/features/agents/lib/agentSpec";
import { ROOT_UID } from "@/features/agents/lib/agentIssues";
import { MAX_SUBAGENT_DEPTH } from "@/features/agents/lib/agentRules";

/**
 * The builder's draft: one reducer, every node of the team addressed by its
 * stable `uid` (never an array index, which a delete or a duplicate would
 * shift under a selection or an issue badge).
 *
 * The reducer is pure and exported, so its rules are tested without a page:
 * a node is found by uid and changed at its path in the tree; the tree never
 * grows past three levels; and the tool rule — a sub-agent only narrows what
 * the agent above it has — is re-applied after every change that touches tools,
 * so removing a tool from a node removes it from every node below it.
 */

export type SubagentPatch = Partial<Pick<AgentDraftSubAgent, "name" | "description" | "prompt" | "model">>;
export type RootField = "description" | "icon" | "model" | "prompt" | "memory";

export type DraftAction =
  | { type: "replace"; draft: AgentDraft }
  | { type: "set"; field: RootField; value: AgentDraft[RootField] }
  /** The agent's name; on create the slug follows it unless the slug was set apart from it. */
  | { type: "set-name"; value: string; followSlug: boolean }
  | { type: "add-tool"; key: string }
  | { type: "remove-tool"; key: string }
  | { type: "add-skill"; name: string }
  | { type: "remove-skill"; name: string }
  | { type: "add-files"; files: AgentDraftFile[] }
  | { type: "update-file"; path: string; content: string }
  | { type: "remove-file"; path: string }
  | { type: "set-approval"; key: string; value: boolean }
  | { type: "update-node"; uid: string; patch: SubagentPatch }
  /** A sub-agent's tool subset; `[]` inherits everything the agent above it has. */
  | { type: "set-node-tools"; uid: string; tools: string[] }
  /** `uid` is the new node's, chosen by the caller so it can select it. */
  | { type: "add-child"; parentUid: string; uid: string }
  | { type: "duplicate-node"; uid: string; newUid: string }
  | { type: "remove-node"; uid: string };

/** Where a node sits: its index path, depth (1–3) and the uids above it. */
export type NodeLocation = {
  node: AgentDraftSubAgent;
  path: number[];
  depth: number;
  /** The uids above it, the main agent's (`root`) first. */
  ancestors: string[];
};

/** Find a sub-agent anywhere in the tree by its uid. */
export function locate(draft: AgentDraft, uid: string): NodeLocation | null {
  const walk = (
    nodes: AgentDraftSubAgent[],
    path: number[],
    ancestors: string[],
  ): NodeLocation | null => {
    for (const [index, node] of nodes.entries()) {
      const here = [...path, index];
      if (node.uid === uid) return { node, path: here, depth: here.length, ancestors };
      const found = walk(node.subagents ?? [], here, [...ancestors, node.uid]);
      if (found) return found;
    }
    return null;
  };
  return walk(draft.subagents, [], [ROOT_UID]);
}

/** The depth of a node: 0 for the main agent, 1–3 for its team. */
export const depthOf = (draft: AgentDraft, uid: string): number =>
  uid === ROOT_UID ? 0 : (locate(draft, uid)?.depth ?? 0);

/** Replace the children list at an index path (`[]` is the main agent's team). */
function updateChildrenAt(
  nodes: AgentDraftSubAgent[],
  path: number[],
  fn: (children: AgentDraftSubAgent[]) => AgentDraftSubAgent[],
): AgentDraftSubAgent[] {
  if (!path.length) return fn(nodes);
  const [head, ...rest] = path;
  return nodes.map((node, index) =>
    index === head ? { ...node, subagents: updateChildrenAt(node.subagents ?? [], rest, fn) } : node,
  );
}

/** Replace the node at an index path. */
function updateAt(
  nodes: AgentDraftSubAgent[],
  path: number[],
  fn: (node: AgentDraftSubAgent) => AgentDraftSubAgent,
): AgentDraftSubAgent[] {
  const index = path[path.length - 1];
  return updateChildrenAt(nodes, path.slice(0, -1), (children) =>
    children.map((node, i) => (i === index ? fn(node) : node)),
  );
}

/**
 * Keep every node's tools inside what the agent above it has, top to bottom.
 * A node that lists none inherits, so it passes its parent's set on down.
 */
export function clampTools(nodes: AgentDraftSubAgent[], allowed: string[]): AgentDraftSubAgent[] {
  let changed = false;
  const next = nodes.map((node) => {
    const tools = node.tools.filter((key) => allowed.includes(key));
    const subagents = clampTools(node.subagents ?? [], tools.length ? tools : allowed);
    if (tools.length === node.tools.length && subagents === node.subagents) return node;
    changed = true;
    return { ...node, tools, subagents };
  });
  return changed ? next : nodes;
}

/** A deep copy with fresh uids, so the copy and the original never share an identity. */
function copyNode(node: AgentDraftSubAgent, uid: string = newUid()): AgentDraftSubAgent {
  return {
    ...node,
    uid,
    tools: [...node.tools],
    subagents: (node.subagents ?? []).map((child) => copyNode(child)),
  };
}

/** `<name>-copy`, then `-copy-2`, … — whichever is free among the siblings. */
function copyName(name: string, siblings: AgentDraftSubAgent[]): string {
  const base = name.trim() ? `${name.trim()}-copy` : "";
  if (!base) return "";
  const taken = new Set(siblings.map((s) => s.name.trim()));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

const withTools = (draft: AgentDraft): AgentDraft => {
  const subagents = clampTools(draft.subagents, draft.tools);
  return subagents === draft.subagents ? draft : { ...draft, subagents };
};

export function draftReducer(draft: AgentDraft, action: DraftAction): AgentDraft {
  switch (action.type) {
    case "replace":
      return action.draft;
    case "set":
      return { ...draft, [action.field]: action.value };
    case "set-name":
      return {
        ...draft,
        name: action.value,
        slug: action.followSlug ? slugify(action.value) : draft.slug,
      };
    case "add-tool":
      return draft.tools.includes(action.key)
        ? draft
        : { ...draft, tools: [...draft.tools, action.key] };
    case "remove-tool": {
      // Its definition default and the choice made for it go with it: the
      // server refuses a gate on a tool the agent doesn't have.
      const name = toolNameOf(action.key);
      const stillNamed = draft.tools.some((key) => key !== action.key && toolNameOf(key) === name);
      const { [action.key]: _choice, ...approvals } = draft.approvals ?? {};
      const hitl = { ...(draft.hitl ?? {}) };
      if (!stillNamed) delete hitl[name];
      return withTools({
        ...draft,
        tools: draft.tools.filter((key) => key !== action.key),
        approvals,
        hitl,
      });
    }
    case "add-skill":
      return draft.skills.includes(action.name)
        ? draft
        : { ...draft, skills: [...draft.skills, action.name] };
    case "remove-skill":
      return { ...draft, skills: draft.skills.filter((name) => name !== action.name) };
    case "add-files": {
      const existing = new Set(draft.files.map((file) => file.path));
      const fresh = action.files.filter((file) => !existing.has(file.path));
      return fresh.length ? { ...draft, files: [...draft.files, ...fresh] } : draft;
    }
    case "update-file":
      return {
        ...draft,
        files: draft.files.map((file) =>
          file.path === action.path ? { ...file, content: action.content } : file,
        ),
      };
    case "remove-file":
      return { ...draft, files: draft.files.filter((file) => file.path !== action.path) };
    case "set-approval":
      return { ...draft, approvals: { ...(draft.approvals ?? {}), [action.key]: action.value } };
    case "update-node": {
      const at = locate(draft, action.uid);
      if (!at) return draft;
      return {
        ...draft,
        subagents: updateAt(draft.subagents, at.path, (node) => ({ ...node, ...action.patch })),
      };
    }
    case "set-node-tools": {
      const at = locate(draft, action.uid);
      if (!at) return draft;
      return withTools({
        ...draft,
        subagents: updateAt(draft.subagents, at.path, (node) => ({
          ...node,
          tools: [...new Set(action.tools)],
        })),
      });
    }
    case "add-child": {
      const child = { ...emptySubagent(), uid: action.uid };
      if (action.parentUid === ROOT_UID) {
        return { ...draft, subagents: [...draft.subagents, child] };
      }
      const at = locate(draft, action.parentUid);
      // Three levels is the most: a node at the last level has no team.
      if (!at || at.depth >= MAX_SUBAGENT_DEPTH) return draft;
      return {
        ...draft,
        subagents: updateAt(draft.subagents, at.path, (node) => ({
          ...node,
          subagents: [...(node.subagents ?? []), child],
        })),
      };
    }
    case "duplicate-node": {
      const at = locate(draft, action.uid);
      if (!at) return draft;
      const index = at.path[at.path.length - 1];
      return {
        ...draft,
        subagents: updateChildrenAt(draft.subagents, at.path.slice(0, -1), (siblings) => {
          const copy = { ...copyNode(at.node, action.newUid), name: copyName(at.node.name, siblings) };
          return [...siblings.slice(0, index + 1), copy, ...siblings.slice(index + 1)];
        }),
      };
    }
    case "remove-node": {
      const at = locate(draft, action.uid);
      if (!at) return draft;
      const index = at.path[at.path.length - 1];
      return {
        ...draft,
        subagents: updateChildrenAt(draft.subagents, at.path.slice(0, -1), (siblings) =>
          siblings.filter((_, i) => i !== index),
        ),
      };
    }
    default:
      return draft;
  }
}

/** Give any node that came in without one (an autosaved draft from an older page) a uid. */
export function ensureUids(draft: AgentDraft): AgentDraft {
  const fix = (nodes: AgentDraftSubAgent[] | undefined): AgentDraftSubAgent[] =>
    (nodes ?? []).map((node) => ({
      ...node,
      uid: typeof node.uid === "string" && node.uid ? node.uid : newUid(),
      tools: Array.isArray(node.tools) ? node.tools : [],
      subagents: fix(node.subagents),
    }));
  return {
    ...draft,
    hitl: draft.hitl ?? {},
    approvals: draft.approvals ?? {},
    subagents: fix(draft.subagents),
  };
}

/**
 * A draft's content as one comparable string — what "unsaved changes" compares.
 * Without the uids: they are fresh on every load, and say nothing about content.
 */
export const draftSignature = (draft: AgentDraft): string =>
  JSON.stringify(draft, (key, value) => (key === "uid" ? undefined : value));

/**
 * The draft plus whether it differs from what was last loaded or saved. The
 * baseline moves on `markSaved` (after a save) and on a clean `reset`, never on
 * an edit.
 */
export function useAgentDraft(initial: AgentDraft, savedAs: AgentDraft = initial) {
  const [draft, dispatch] = useReducer(draftReducer, initial);
  // `savedAs` differs from `initial` for a draft that starts out unsaved — an
  // imported YAML opened in the builder: nothing of it exists yet.
  const [baseline, setBaseline] = useState(() => draftSignature(savedAs));
  const signature = useMemo(() => draftSignature(draft), [draft]);
  const dirty = signature !== baseline;

  const reset = useCallback((next: AgentDraft, { clean = true }: { clean?: boolean } = {}) => {
    dispatch({ type: "replace", draft: next });
    if (clean) setBaseline(draftSignature(next));
  }, []);
  const markSaved = useCallback(() => setBaseline(signature), [signature]);

  return { draft, dispatch, dirty, reset, markSaved };
}
