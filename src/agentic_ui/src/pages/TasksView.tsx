import { motion } from "framer-motion";

import ScheduledTasksPage from "@/features/tasks/components/ScheduledTasksPage";

import { useChatWorkspaceContext } from "@/app/workspaceContext";
import { useWorkspaceStore } from "@/shared/stores/workspaceStore";

/**
 * The scheduled-tasks page for the "/tasks" route. Fills the shell's content
 * area (the sidebar stays); fades in on mount. All data/actions come from the
 * workspace context built by ChatShell; navigation drives open/close.
 */
export default function TasksView() {
  const { reduceMotion, navigate, scheduledTasks } = useChatWorkspaceContext();
  // Store-backed: selecting it here keeps this view out of the bundle's
  // per-render churn (see ChatView for the same move).
  const agents = useWorkspaceStore((s) => s.agents);

  return (
    <motion.div
      // z-30, not z-50: this fills the sidebar's content pane, and the mobile
      // sidebar is a fixed sibling at z-40 (backdrop) / z-50 (panel). At an equal
      // z-50 the later DOM node won, so this opaque page painted straight over the
      // open sidebar — on mobile the toggle looked like it did nothing. Anything
      // that must sit above this (profile modal, dialogs) renders after it or
      // portals out.
      className="absolute inset-0 z-30 bg-background"
      initial={reduceMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
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
      />
    </motion.div>
  );
}
