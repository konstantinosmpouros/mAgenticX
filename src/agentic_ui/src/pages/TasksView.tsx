import { motion } from "framer-motion";

import ScheduledTasksPage from "@/components/chat/ScheduledTasksPage";

import { useChatWorkspaceContext } from "@/stores/workspaceStore";

/**
 * The scheduled-tasks page for the "/tasks" route. Fills the shell's content
 * area (the sidebar stays); fades in on mount. All data/actions come from the
 * workspace context built by ChatShell; navigation drives open/close.
 */
export default function TasksView() {
  const { reduceMotion, navigate, scheduledTasks, agents, enabledToolsForRequest } =
    useChatWorkspaceContext();

  return (
    <motion.div
      className="absolute inset-0 z-50 bg-background"
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
        defaultEnabledTools={enabledToolsForRequest}
        onCreate={scheduledTasks.create}
        onUpdate={scheduledTasks.update}
        onDelete={scheduledTasks.remove}
        onOpenResult={(conversationId) => navigate("/c/" + conversationId)}
      />
    </motion.div>
  );
}
