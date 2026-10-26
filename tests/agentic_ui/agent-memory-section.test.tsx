import { describe, expect, it } from "vitest";

import { agentPath, DETAIL_SECTIONS } from "@/features/agents/lib/routes";
import { resolveSettingsTab } from "@/features/settings/lib/settingsTabs";
import { NAV_ITEMS } from "@/features/settings/components/profile_parts/ProfileSidebar";

/**
 * Memories left Settings for each agent's page: an agent's Memory section is a
 * section of `/agents/:agentId`, and an old "memories" tab (a stored snapshot,
 * a link) opens Personalization, where memory is switched on and off.
 */
describe("an agent's memory", () => {
  it("is a section of the agent's page", () => {
    expect(DETAIL_SECTIONS).toContain("memory");
    expect(agentPath("a1", "memory")).toBe("/agents/a1?section=memory");
  });

  it("is no longer a Settings tab", () => {
    expect(NAV_ITEMS.map((item) => item.id)).not.toContain("memories");
    expect(resolveSettingsTab("memories")).toBe("personalization");
  });
});
