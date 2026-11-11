import type { EffortLevel } from "@/shared/lib/types";

/**
 * The effort the composer uses for an agent: the level last picked for it
 * while the agent still lists that level, else the agent's default, else the
 * middle listed level. Null when the agent lists none (no picker, no effort).
 */
export function resolveEffort(
  efforts: readonly EffortLevel[],
  defaultEffort: EffortLevel | null,
  stored: EffortLevel | null,
): EffortLevel | null {
  if (efforts.length === 0) return null;
  if (stored && efforts.includes(stored)) return stored;
  if (defaultEffort && efforts.includes(defaultEffort)) return defaultEffort;
  return efforts[Math.floor(efforts.length / 2)];
}
