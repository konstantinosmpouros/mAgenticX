/**
 * Which branch of a conversation's message tree is on screen, across a reload.
 *
 * A branch is a map `{ parentId | "__root__": siblingIndex }` — the sibling
 * picked under each fork (useMessageInteraction). It is remembered per
 * conversation in sessionStorage, so a reload of the tab lands on the branch
 * the user was reading; a new tab starts fresh. Storage can be missing or
 * throw (private mode, blocked site data): every access is guarded and the
 * chat simply falls back to its default branch.
 */
import type { MessageOut } from "@/shared/lib/types";

export type BranchSelections = Record<string, number>;

const ROOT_KEY = "__root__";
const STORAGE_PREFIX = "mx.branch.";

function siblingsByParent(messages: MessageOut[]): Map<string | null, MessageOut[]> {
  const byParent = new Map<string | null, MessageOut[]>();
  for (const message of messages) {
    const key = message.parentMessageId ?? null;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(message);
  }
  return byParent;
}

/**
 * The selections that put `messageId` on the visible branch: walk its parent
 * links to the root and record its sibling index under every fork. Null when
 * the message is not in `messages` or its chain is broken. Siblings are taken
 * in `messages` order, as the active-run snap does.
 */
export function branchSelectionsForMessage(
  messages: MessageOut[],
  messageId: string | null | undefined,
): BranchSelections | null {
  if (!messageId || !messages.length) return null;
  const byId = new Map(messages.map((message) => [message.id, message]));
  const chain: MessageOut[] = [];
  const seen = new Set<string>();
  let cursor = byId.get(messageId);
  while (cursor) {
    if (seen.has(cursor.id)) return null;
    seen.add(cursor.id);
    chain.unshift(cursor);
    const parentId = cursor.parentMessageId ?? null;
    if (parentId === null) break;
    cursor = byId.get(parentId);
    if (!cursor) return null;
  }
  if (!chain.length) return null;
  const byParent = siblingsByParent(messages);
  const result: BranchSelections = {};
  for (const step of chain) {
    const parentId = step.parentMessageId ?? null;
    const index = (byParent.get(parentId) ?? []).findIndex((message) => message.id === step.id);
    if (index < 0) return null;
    result[parentId ?? ROOT_KEY] = index;
  }
  return result;
}

/** `stored` without the forks that no longer exist or are out of range. */
export function reconcileBranchSelections(
  messages: MessageOut[],
  stored: BranchSelections,
): BranchSelections {
  const byParent = siblingsByParent(messages);
  const result: BranchSelections = {};
  for (const [key, index] of Object.entries(stored)) {
    const siblings = byParent.get(key === ROOT_KEY ? null : key);
    if (siblings && Number.isInteger(index) && index >= 0 && index < siblings.length) {
      result[key] = index;
    }
  }
  return result;
}

export function loadBranchSelections(conversationId: string): BranchSelections | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_PREFIX + conversationId);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const result: BranchSelections = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "number") result[key] = value;
    }
    return result;
  } catch {
    return null;
  }
}

export function saveBranchSelections(conversationId: string, selections: BranchSelections): void {
  try {
    window.sessionStorage.setItem(STORAGE_PREFIX + conversationId, JSON.stringify(selections));
  } catch {
    // Storage unavailable: the reload just lands on the default branch.
  }
}

/** Whether this page load is a reload of the tab (not a link, a new tab or history). */
export function isPageReload(): boolean {
  try {
    const entry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    return entry?.type === "reload";
  } catch {
    return false;
  }
}
