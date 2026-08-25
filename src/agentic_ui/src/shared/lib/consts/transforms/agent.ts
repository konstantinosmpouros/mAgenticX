import type { Agent, AgentPublic } from "../../types/agents";
import { mapIcon } from "../icons";

/**
 * Pick the first candidate that is actually a string.
 *
 * Wire validation guarantees "this row is an object", not the type of each
 * field, so a malformed payload can carry a number or null where a name is
 * expected. Falling through on the wrong type (rather than `??`, which only
 * skips null/undefined) is what keeps a bad field from reaching the UI typed
 * as a string when it isn't one.
 */
const firstString = (...candidates: unknown[]): string | null => {
  for (const candidate of candidates) {
    if (typeof candidate === "string") return candidate;
  }
  return null;
};

const firstBoolean = (...candidates: unknown[]): boolean | null => {
  for (const candidate of candidates) {
    if (typeof candidate === "boolean") return candidate;
  }
  return null;
};

/**
 * The single wire→`Agent` mapper.
 *
 * Every path that receives an agent from the backend goes through here — the
 * catalog listing, the user-authored agent CRUD, and the agent embedded in a
 * conversation summary/detail. It previously existed twice (the catalog call
 * hand-rolled its own copy), which is the kind of split where one side quietly
 * gains a field the other never learns about.
 *
 * `fallback` supplies values for the conversation transforms, where the agent
 * may be absent from the payload and the surrounding row carries the id/name.
 */
export const transformAgent = (
  agent: AgentPublic | Record<string, any> | undefined,
  fallback?: Partial<AgentPublic> | Record<string, any>,
): Agent => {
  const source = (agent ?? {}) as Record<string, any>;
  const fb = (fallback ?? {}) as Record<string, any>;

  const resolvedIcon = firstString(source.icon, source.iconName, fb.icon, fb.iconName);
  const resolvedIsActive =
    firstBoolean(source.isActive, source.is_active, fb.isActive, fb.is_active) ?? true;

  return {
    // Coerced rather than type-guarded: ids are opaque and a numeric id in a
    // payload should still address the right agent, not collapse to "".
    id: String(source.id ?? fb.id ?? ""),
    name: firstString(source.name, fb.name) ?? "Unknown Agent",
    description: firstString(source.description, fb.description) ?? "",
    icon: mapIcon(resolvedIcon),
    // Kept alongside the resolved component: the IndexedDB snapshot can only
    // persist the name, and a Lucide icon is a forwardRef object whose `.name`
    // is not the icon's name — so without this the icon degrades to the
    // fallback glyph on every reload.
    iconName: resolvedIcon,
    version: firstString(source.version, fb.version) ?? undefined,
    // Carried through because consumers filter on it (`type === "deep agent"`
    // gates the Tools/Skills/Memories per-agent lists); dropping it here made
    // agents from this path invisible to those filters.
    type: firstString(source.type, fb.type) ?? undefined,
    isActive: resolvedIsActive,
  };
};
