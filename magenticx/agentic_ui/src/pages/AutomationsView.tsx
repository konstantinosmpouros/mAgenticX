import { useCallback, useEffect } from "react";
import { motion, type Variants } from "framer-motion";
import { useSearchParams } from "react-router-dom";

import AutomationsPage from "@/features/automations/components/AutomationsPage";
import {
  AGENT_PARAM,
  TEMPLATE_PARAM,
  VIEW_PARAM,
  automationsAreaFromParam,
} from "@/features/automations/lib/routes";
import { useWorkflowMutations } from "@/features/workflows/hooks/useWorkflowMutations";
import { useWorkflowQuickRun } from "@/features/workflows/hooks/useWorkflowQuickRun";
import { useWorkflowSchedulePause } from "@/features/workflows/hooks/useWorkflowSchedulePause";
import {
  newWorkflowPath,
  workflowEditPath,
  workflowPath,
  workflowRunPath,
} from "@/features/workflows/lib/routes";
import type { AutomationsArea } from "@/shared/lib/types";

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
 * `?view=workflows` shows the Workflows area (`?view=schedules`, or none, the
 * Schedules area); switching areas rewrites it in place, so a refresh or a
 * link lands on the same area.
 *
 * Deep links, each dropped from the URL once used (so a refresh or Back does
 * not open the form again):
 *   - `?agent=<id>`    — an agent's "Schedule it": the form opens on that agent;
 *   - `?template=<id>` — the form opens filled in from that template.
 */
export default function AutomationsView() {
  const { reduceMotion, navigate, automations, workflows } = useChatWorkspaceContext();
  const { remove: removeWorkflow } = useWorkflowMutations();
  const quickRun = useWorkflowQuickRun();
  const setSchedulePaused = useWorkflowSchedulePause();
  // Store-backed: selecting it here keeps this view out of the bundle's
  // per-render churn (see ChatView for the same move).
  const agents = useWorkspaceStore((s) => s.agents);
  const [searchParams, setSearchParams] = useSearchParams();
  const createForAgentId = searchParams.get(AGENT_PARAM);
  const createFromTemplateId = searchParams.get(TEMPLATE_PARAM);
  const area = automationsAreaFromParam(searchParams.get(VIEW_PARAM));
  const changeArea = useCallback(
    (next: AutomationsArea) =>
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          if (next === "schedules") params.delete(VIEW_PARAM);
          else params.set(VIEW_PARAM, next);
          return params;
        },
        { replace: true },
      ),
    [setSearchParams],
  );
  const {
    refresh: refreshWorkflows,
    setSchedule: setWorkflowSchedule,
    workflows: workflowList,
  } = workflows;
  const runWorkflow = useCallback(
    async (workflowId: string) => {
      const result = await quickRun(workflowId);
      navigate(
        result.started ? workflowRunPath(workflowId, result.runId) : workflowPath(workflowId),
      );
    },
    [quickRun, navigate],
  );
  const deleteWorkflow = useCallback(
    async (workflowId: string) => {
      await removeWorkflow(workflowId);
      refreshWorkflows();
    },
    [removeWorkflow, refreshWorkflows],
  );
  // Pause / resume on a card: the card flips at once, the server's answer
  // (or, on failure, the old schedule) lands on the same list entry.
  const setWorkflowSchedulePaused = useCallback(
    async (workflowId: string, paused: boolean) => {
      const current = workflowList.find((workflow) => workflow.id === workflowId)?.schedule;
      if (!current) return;
      await setSchedulePaused(workflowId, current, paused, (schedule) =>
        setWorkflowSchedule(workflowId, schedule),
      );
    },
    [workflowList, setSchedulePaused, setWorkflowSchedule],
  );
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
        area={area}
        onAreaChange={changeArea}
        workflows={workflows.workflows}
        workflowsLoading={workflows.isLoading}
        workflowsError={workflows.error}
        onRetryWorkflows={refreshWorkflows}
        onNewWorkflow={() => navigate(newWorkflowPath())}
        onOpenWorkflow={(workflowId) => navigate(workflowPath(workflowId))}
        onEditWorkflow={(workflowId) => navigate(workflowEditPath(workflowId))}
        onRunWorkflow={runWorkflow}
        onDeleteWorkflow={deleteWorkflow}
        onSetWorkflowSchedulePaused={setWorkflowSchedulePaused}
      />
    </motion.div>
  );
}
