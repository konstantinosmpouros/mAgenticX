import { useCallback, useEffect } from "react";
import { motion, type Variants } from "framer-motion";
import { useSearchParams } from "react-router-dom";

import ScheduledTasksPage from "@/features/tasks/components/ScheduledTasksPage";

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
const PAGE_FADE: Variants = {
  hidden: { opacity: 0 },
  shown: { opacity: 1, transition: { duration: 0.15 } },
  exit: { opacity: 0, transition: { duration: 0.12 } },
};

/**
 * The scheduled-tasks page for the "/tasks" route. Fills the shell's content
 * area (the sidebar stays) and slides in over the chat, and out again (PAGE).
 * All data/actions come from the workspace context built by ChatShell;
 * navigation drives open/close.
 */
export default function TasksView() {
  const { reduceMotion, navigate, scheduledTasks } = useChatWorkspaceContext();
  // Store-backed: selecting it here keeps this view out of the bundle's
  // per-render churn (see ChatView for the same move).
  const agents = useWorkspaceStore((s) => s.agents);
  // "/tasks?agent=<id>": an agent's "Schedule it" — the new-task form opens
  // with that agent chosen, and the parameter is dropped once it has.
  const [searchParams, setSearchParams] = useSearchParams();
  const createForAgentId = searchParams.get("agent");
  const clearAgentParam = useCallback(
    () =>
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete("agent");
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
    document.title = "Schedules · mAgenticX";
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
      <ScheduledTasksPage
        onClose={() => navigate("/")}
        tasks={scheduledTasks.tasks}
        loading={scheduledTasks.loading}
        error={scheduledTasks.error}
        agents={agents}
        onCreate={scheduledTasks.create}
        onUpdate={scheduledTasks.update}
        onDelete={scheduledTasks.remove}
        onOpenResult={(conversationId) => navigate("/c/" + conversationId)}
        onRetry={() => void scheduledTasks.refresh()}
        createForAgentId={createForAgentId}
        onCreateForAgentHandled={clearAgentParam}
      />
    </motion.div>
  );
}
