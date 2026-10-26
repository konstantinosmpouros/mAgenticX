import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion, type Variants } from "framer-motion";
import { useLocation, useOutlet } from "react-router-dom";

import type { AgentsPageContext } from "@/features/agents/context";

import { useChatWorkspaceContext } from "@/app/workspaceContext";
import { useWorkspaceStore } from "@/shared/stores/workspaceStore";

const EASE = [0.22, 1, 0.36, 1] as const;

// The same entrance and exit as Schedules (TasksView): over the chat, which
// holds still underneath, it rises and settles in, and sinks and fades out.
const PAGE: Variants = {
  hidden: { opacity: 0, y: 18, scale: 0.985 },
  shown: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.42, ease: EASE } },
  exit: { opacity: 0, y: 12, scale: 0.99, transition: { duration: 0.26, ease: "easeIn" } },
};
const PAGE_FADE: Variants = {
  hidden: { opacity: 0 },
  shown: { opacity: 1, transition: { duration: 0.15 } },
  exit: { opacity: 0, transition: { duration: 0.12 } },
};
// Between two Agents pages (gallery → an agent → its builder) only the inner
// page changes, so it is a quick cross-fade rather than the section's entrance.
const INNER: Variants = {
  hidden: { opacity: 0, y: 6 },
  shown: { opacity: 1, y: 0, transition: { duration: 0.2, ease: EASE } },
  exit: { opacity: 0, transition: { duration: 0.1 } },
};

/**
 * The route container for the Agents section ("/agents", "/agents/new",
 * "/agents/:agentId", "/agents/:agentId/edit"): the TasksView pattern — fills
 * the shell's content area (the sidebar stays) and slides in over the chat.
 *
 * It is the section's layout route. It reads the workspace once and hands the
 * pages what they need as the `<Outlet>` context (AgentsPageContext), so the
 * pages themselves live in `features/agents` without knowing the bundle.
 */
export default function AgentsView() {
  const ws = useChatWorkspaceContext();
  const { reduceMotion, navigate, userId, mySkills, userAgents, refreshAgentCatalog } = ws;
  const { handleAgentChange } = ws;
  const agents = useWorkspaceStore((s) => s.agents);
  const location = useLocation();
  const outlet = useOutlet(
    useMemo<AgentsPageContext>(
      () => ({
        userId,
        agents,
        mySkills: mySkills ?? [],
        userAgents,
        refreshCatalog: () => refreshAgentCatalog(),
        // A new chat ("/") with the agent picked: the selection is what the
        // empty composer sends to, and it is kept because it names an agent in
        // the catalog.
        onChatWith: (agentId) => {
          handleAgentChange(agentId);
          navigate("/");
        },
        // Schedules opens its new-task form with this agent chosen.
        onSchedule: (agentId) => navigate(`/tasks?agent=${encodeURIComponent(agentId)}`),
        onClose: () => navigate("/"),
      }),
      [userId, agents, mySkills, userAgents, refreshAgentCatalog, handleAgentChange, navigate],
    ),
  );

  // The chat's own title comes back when the section is left. Captured during
  // the first render, before any page's effect has renamed the tab — a child's
  // effects run before this component's.
  const [previousTitle] = useState(() => document.title);
  useEffect(() => {
    return () => {
      document.title = previousTitle;
    };
  }, [previousTitle]);

  // One key per page *kind*, so switching between two agents' pages (or an
  // agent's tabs, which only change the query) does not replay the fade.
  const pageKey = pageKindOf(location.pathname);

  return (
    <motion.div
      // z-30, not z-50 — see TasksView: the mobile sidebar is a fixed sibling at
      // z-40/z-50 and must paint over this page. Dialogs and menus portal out.
      className="absolute inset-0 z-30 origin-top bg-background"
      variants={reduceMotion ? PAGE_FADE : PAGE}
      initial="hidden"
      animate="shown"
      exit="exit"
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={pageKey}
          className="h-full"
          variants={reduceMotion ? PAGE_FADE : INNER}
          initial="hidden"
          animate="shown"
          exit="exit"
        >
          {outlet}
        </motion.div>
      </AnimatePresence>
    </motion.div>
  );
}

/** "gallery" | "new" | "agent:<id>" | "edit:<id>" — what the inner fade keys on. */
const pageKindOf = (pathname: string): string => {
  const [, , id, sub] = pathname.split("/");
  if (!id) return "gallery";
  if (id === "new") return "new";
  return sub === "edit" ? `edit:${id}` : `agent:${id}`;
};
