import { useOutletContext } from "react-router-dom";

import type { Agent, UserSkill } from "@/shared/lib/types";
import type { UserAgentsHandlers } from "@/features/agents/hooks/useUserAgents";

/**
 * What the Agents pages get from their route container (`pages/AgentsView`).
 *
 * Handed down as the `<Outlet>` context rather than read from the workspace
 * bundle here, so this feature stays below `app/` (features never import it);
 * the container is the one place that knows the bundle's shape.
 */
export type AgentsPageContext = {
  userId: string | null;
  /** The shared catalog: platform agents and the user's own, each with `kind`. */
  agents: Agent[];
  /** The user's skill pool, for the builder's Skills section. */
  mySkills: UserSkill[];
  userAgents: UserAgentsHandlers;
  /** Re-pull the catalog — used when a linked agent id is not in it (yet). */
  refreshCatalog: () => Promise<void>;
  /** Start a new chat with this agent selected. */
  onChatWith: (agentId: string) => void;
  /** Open Schedules with a new task for this agent. */
  onSchedule: (agentId: string) => void;
  /** Leave the Agents section for the chat. */
  onClose: () => void;
};

export const useAgentsPage = () => useOutletContext<AgentsPageContext>();
