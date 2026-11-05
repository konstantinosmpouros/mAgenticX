import { motion, type Variants } from "framer-motion";
import { useNavigate, useParams } from "react-router-dom";

import WorkflowBuilderPage from "@/features/workflows/components/builder/WorkflowBuilderPage";
import { automationsAreaPath } from "@/features/automations/lib/routes";
import { workflowEditPath, workflowPath } from "@/features/workflows/lib/routes";

import { useChatWorkspaceContext } from "@/app/workspaceContext";

const EASE = [0.22, 1, 0.36, 1] as const;

// The workflow view's entrance (WorkflowView): over the chat, rising in.
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
 * The workflow builder's route view, for "/workflows/new" and
 * "/workflows/:workflowId/edit": fills the shell's content area (the builder
 * collapses the sidebar while it is open, restoring it on leave) and only
 * wires the route — the id in; after a save the sidebar's
 * list reloads, a create moves to the edit route (replacing "new", so Back
 * does not reopen an empty builder), Run opens the workflow's view, and a
 * delete — or leaving a workflow never saved — returns to the Automations
 * page's Workflows area, where workflows are listed and created. Leaving a
 * saved workflow opens its view (the back button is labelled with its name).
 */
export default function WorkflowBuilderView() {
  const { reduceMotion, workflows } = useChatWorkspaceContext();
  const navigate = useNavigate();
  const { workflowId } = useParams();

  return (
    <motion.div
      // z-30 like the other pages: under the mobile sidebar (z-40/50).
      className="absolute inset-0 z-30 origin-top bg-background"
      variants={reduceMotion ? PAGE_FADE : PAGE}
      initial="hidden"
      animate="shown"
      exit="exit"
    >
      <WorkflowBuilderPage
        workflowId={workflowId ?? null}
        onSaved={workflows.refresh}
        onCreated={(id) => navigate(workflowEditPath(id), { replace: true })}
        onOpenView={(id) => navigate(workflowPath(id))}
        onDeleted={() => navigate(automationsAreaPath("workflows"), { replace: true })}
        onExit={(id) => navigate(id ? workflowPath(id) : automationsAreaPath("workflows"))}
      />
    </motion.div>
  );
}
