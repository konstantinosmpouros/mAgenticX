import { motion, type Variants } from "framer-motion";
import { useNavigate, useParams } from "react-router-dom";

import { automationsAreaPath } from "@/features/automations/lib/routes";
import WorkflowViewPage from "@/features/workflows/components/WorkflowViewPage";
import {
  workflowEditPath,
  workflowHistoryPath,
  workflowRunPath,
} from "@/features/workflows/lib/routes";

import { useChatWorkspaceContext } from "@/app/workspaceContext";

const EASE = [0.22, 1, 0.36, 1] as const;

// Same entrance as the Automations page: over the chat, which holds still
// underneath (WorkspaceShell), it rises and settles while fading in, and sinks
// a little and fades on the way out. Reduced motion: a plain fade.
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
 * The workflow view for "/workflows/:workflowId" (the latest run) and
 * "/workflows/:workflowId/runs/:runId" (that run). Fills the shell's content
 * area — the chat body is replaced, the sidebar stays — and only wires the
 * route: the params in, and picking a run back out as a URL. Moving between
 * workflows or runs never remounts it (WorkspaceShell keys by surface).
 */
export default function WorkflowView() {
  const { reduceMotion, navigate, workflows } = useChatWorkspaceContext();
  const routerNavigate = useNavigate();
  const { workflowId = "", runId } = useParams();

  return (
    <motion.div
      // z-30 like the other pages: under the mobile sidebar (z-40/50).
      className="absolute inset-0 z-30 origin-top bg-background"
      variants={reduceMotion ? PAGE_FADE : PAGE}
      initial="hidden"
      animate="shown"
      exit="exit"
    >
      <WorkflowViewPage
        workflowId={workflowId}
        runId={runId ?? null}
        onSelectRun={(id) => navigate(workflowRunPath(workflowId, id))}
        onEdit={() => navigate(workflowEditPath(workflowId))}
        onHistory={() => navigate(workflowHistoryPath(workflowId))}
        onDeleted={() => {
          // The sidebar's list drops it; the view leaves for the Workflows
          // area, as a delete from the builder does.
          workflows.refresh();
          routerNavigate(automationsAreaPath("workflows"), { replace: true });
        }}
      />
    </motion.div>
  );
}
