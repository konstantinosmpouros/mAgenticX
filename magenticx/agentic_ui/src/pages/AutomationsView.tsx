import { useCallback, useEffect } from "react";
import { motion, type Variants } from "framer-motion";
import { useSearchParams } from "react-router-dom";

import AutomationsPage from "@/features/automations/components/AutomationsPage";
import { AGENT_PARAM, TEMPLATE_PARAM } from "@/features/automations/lib/routes";

import { useChatWorkspaceContext } from "@/app/workspaceContext";
import { useWorkspaceStore } from "@/shared/stores/workspaceStore";

const EASE = [0.22, 1, 0.36, 1] as const;

// Over the chat, which holds still underneath (WorkspaceShell): in, it rises
// and settles from a touch smaller while it fades in; out, it sinks a little
// and fades, quicker, revealing the chat. Reduced motion: a plain fade.
const PAGE: Variants = {
  hidden: { opacity: 0, y: 18, scale: 0.985 },
  shown: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.42, ease: EASE } },
  exit: { opacity: 0, y: 12, scale: 0.99, transition: { duration: 0.26, ease: "easeIn" } },
};
/** The query parameters that open the create form (see the component's doc). */
const DEEP_LINK_PARAMS = [AGENT_PARAM, TEMPLATE_PARAM] as const;

const PAGE_FADE: Variants = {
  hidden: { opacity: 0 },
  shown: { opacity: 1, transition: { duration: 0.15 } },
  exit: { opacity: 0, transition: { duration: 0.12 } },
};

/**
 * The Automations page for the "/automations" route. Fills the shell's content
 * area (the sidebar stays) and slides in over the chat, and out again (PAGE).
 * All data/actions come from the workspace context built by ChatShell;
 * navigation drives open/close.
 *
 * Deep links, each dropped from the URL once used (so a refresh or Back does
 * not open the form again):
 *   - `?agent=<id>`    — an agent's "Schedule it": the form opens on that agent;
 *   - `?template=<id>` — the form opens filled in from that template.
 */
export default function AutomationsView() {
  const { reduceMotion, navigate, automations } = useChatWorkspaceContext();
  // Store-backed: selecting it here keeps this view out of the bundle's
  // per-render churn (see ChatView for the same move).
  const agents = useWorkspaceStore((s) => s.agents);
  const [searchParams, setSearchParams] = useSearchParams();
  const createForAgentId = searchParams.get(AGENT_PARAM);
  const createFromTemplateId = searchParams.get(TEMPLATE_PARAM);
  // Both links are dropped together: two separate updates in one commit would
  // each start from the same params, and the second would restore the first.
  const clearDeepLinks = useCallback(
    () =>
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const name of DEEP_LINK_PARAMS) next.delete(name);
          return next;
        },
        { replace: true },
      ),
    [setSearchParams],
  );

  // The tab reads like the sidebar entry while the page is open; the chat's own
  // title comes back on the way out.
  useEffect(() => {
    const previous = document.title;
    document.title = "Automations · mAgenticX";
    return () => {
      document.title = previous;
    };
  }, []);

  return (
    <motion.div
      // z-30, not z-50: this fills the sidebar's content pane, and the mobile
      // sidebar is a fixed sibling at z-40 (backdrop) / z-50 (panel). At an equal
      // z-50 the later DOM node won, so this opaque page painted straight over the
      // open sidebar — on mobile the toggle looked like it did nothing. Anything
      // that must sit above this (profile modal, dialogs) renders after it or
      // portals out.
      className="absolute inset-0 z-30 origin-top bg-background"
      variants={reduceMotion ? PAGE_FADE : PAGE}
      initial="hidden"
      animate="shown"
      exit="exit"
    >
      <AutomationsPage
        onClose={() => navigate("/")}
        items={automations.items}
        loading={automations.loading}
        error={automations.error}
        agents={agents}
        onCreate={automations.create}
        onUpdate={automations.update}
        onDelete={automations.remove}
        onOpenResult={(conversationId) => navigate("/c/" + conversationId)}
        onRetry={() => void automations.refresh()}
        createForAgentId={createForAgentId}
        onCreateForAgentHandled={clearDeepLinks}
        createFromTemplateId={createFromTemplateId}
        onCreateFromTemplateHandled={clearDeepLinks}
      />
    </motion.div>
  );
}
