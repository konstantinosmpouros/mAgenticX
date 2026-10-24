import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ListTodo } from "lucide-react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { planProgressLabel, type ConversationPlans } from "@/features/chat/lib/conversationPlans";
import { PlanPanel } from "./PlanPanel";

type PlanButtonProps = {
  plans: ConversationPlans;
  agentName: string;
  /** False on an empty conversation; the button also waits for a plan. */
  visible: boolean;
};

/**
 * The composer's plan button, right of the agent map's: the plan icon alone,
 * a soft glow behind it while a step is being worked on, and the panel with
 * the plan. The progress is in its label and the panel, not on the button.
 * Shown once the conversation has a plan on the branch the user sees.
 */
export function PlanButton({ plans, agentName, visible }: PlanButtonProps) {
  const [open, setOpen] = React.useState(false);
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const panelId = React.useId();
  const reduceMotion = useReducedMotion();
  const current = plans.current;
  const shown = visible && current !== null;
  const working = Boolean(current && current.activeIndex >= 0);
  const label = current ? `Plan · ${planProgressLabel(current)}` : "Plan";

  React.useEffect(() => {
    if (!shown) setOpen(false);
  }, [shown]);

  return (
    <>
      <AnimatePresence initial={false}>
        {shown && current ? (
          <motion.span
            key="plan-button"
            className="inline-flex"
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.6 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            <Tooltip delayDuration={0}>
              <TooltipTrigger asChild>
                <button
                  ref={buttonRef}
                  type="button"
                  aria-label={label}
                  aria-haspopup="dialog"
                  aria-expanded={open}
                  aria-controls={open ? panelId : undefined}
                  data-active={working}
                  onClick={() => setOpen(true)}
                  className="plan-glow group/plan relative flex h-10 w-10 cursor-pointer items-center justify-center rounded-full transition-[background-color,transform] duration-150 hover:bg-[hsl(var(--hover-surface))] active:scale-[0.94] focus-visible:bg-[hsl(var(--hover-surface-strong))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70 motion-reduce:active:scale-100"
                >
                  <ListTodo
                    size={20}
                    aria-hidden
                    className="text-muted-foreground transition-[color,transform] duration-300 ease-out group-hover/plan:text-foreground motion-safe:supports-[hover:hover]:group-hover/plan:scale-110"
                  />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" align="center">
                <p>{label}</p>
              </TooltipContent>
            </Tooltip>
          </motion.span>
        ) : null}
      </AnimatePresence>
      <PlanPanel
        open={open && shown}
        onOpenChange={setOpen}
        plans={plans}
        agentName={agentName}
        anchorRef={buttonRef}
        id={panelId}
      />
    </>
  );
}
