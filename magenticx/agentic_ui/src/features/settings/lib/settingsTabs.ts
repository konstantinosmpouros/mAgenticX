import { NAV_ITEMS } from "@/features/settings/components/profile_parts/ProfileSidebar";

/** Pre-taxonomy tab ids (persisted in UI snapshots) → their new section. */
export const LEGACY_TAB_MAP: Record<string, string> = {
  profile: "account",
  appearance: "personalization",
  archived: "data-controls",
  // Agents left Settings for their own section (/agents). A stored or linked
  // "agents" tab opens on General: the panel cannot take you to a route, and
  // the sidebar's Agents entry is one click away.
  agents: "general",
  // Memories moved to each agent's page too (Agents → an agent → Memory); the
  // switches for memory stay in Personalization, so a stored tab opens there.
  memories: "personalization",
};

const VALID_SECTION_IDS = new Set<string>(NAV_ITEMS.map((item) => item.id));

/**
 * The section a stored or linked tab id opens. Persisted ids from before the
 * ChatGPT-taxonomy rename keep working — remapped to their new section — and
 * anything else that is not a section in the nav (an old snapshot's "agents", a
 * typo) opens General rather than an empty panel.
 */
export function resolveSettingsTab(tab: string): string {
  const remapped = LEGACY_TAB_MAP[tab] ?? tab;
  return VALID_SECTION_IDS.has(remapped) ? remapped : "general";
}
