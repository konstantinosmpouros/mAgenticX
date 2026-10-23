import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Network } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import type { AgentMap } from "@/features/chat/lib/agentMap";
import { AgentMapPanel } from "./AgentMapPanel";

type AgentMapButtonProps = {
  map: AgentMap;
  agentName: string;
  /** False on an empty conversation: there is nothing to map yet. */
  visible: boolean;
};

/**
 * The composer's agent-map button, right of the context ring: the sub-agents
 * this conversation used, counted on a badge (lit while one works), and the
 * panel that maps them. Shown once the conversation has messages; muted, but
 * still opening the panel's empty state, until a sub-agent has run.
 */
export function AgentMapButton({ map, agentName, visible }: AgentMapButtonProps) {
  const [open, setOpen] = React.useState(false);
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const reduceMotion = useReducedMotion();
  const count = map.subagentCount;
  const working = map.runningCount > 0;
  const label = count
    ? `Agent map, ${count} sub-agent${count === 1 ? "" : "s"}${working ? `, ${map.runningCount} working` : ""}`
    : "Agent map, no sub-agents yet";

  React.useEffect(() => {
    if (!visible) setOpen(false);
  }, [visible]);

  return (
    <>
      <AnimatePresence initial={false}>
        {visible ? (
          <motion.span
            key="agent-map-button"
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
                  data-empty={count ? undefined : "true"}
                  onClick={() => setOpen(true)}
                  className="group/map relative flex h-10 w-10 cursor-pointer items-center justify-center rounded-full transition-[background-color,transform] duration-150 hover:bg-[hsl(var(--hover-surface))] active:scale-[0.94] focus-visible:bg-[hsl(var(--hover-surface-strong))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70 motion-reduce:active:scale-100"
                >
                  <Network
                    size={20}
                    aria-hidden
                    className={cn(
                      "transition-[color,transform] duration-300 ease-out motion-safe:supports-[hover:hover]:group-hover/map:scale-110",
                      count
                        ? "text-muted-foreground group-hover/map:text-foreground"
                        : "text-muted-foreground/45",
                    )}
                  />
                  <AnimatePresence initial={false}>
                    {count ? (
                      <motion.span
                        key={count}
                        aria-hidden
                        initial={reduceMotion ? { opacity: 0 } : { scale: 0.4, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ opacity: 0, transition: { duration: 0.1 } }}
                        transition={{ type: "spring", stiffness: 520, damping: 26 }}
                        className={cn(
                          "pointer-events-none absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none tabular-nums ring-2 ring-card",
                          working
                            ? "bg-[hsl(var(--subagent-active))] text-background shadow-[0_0_10px_hsl(var(--subagent-active-glow)/0.8)]"
                            : "bg-primary text-primary-foreground",
                        )}
                      >
                        {count > 99 ? "99+" : count}
                      </motion.span>
                    ) : null}
                  </AnimatePresence>
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" align="center">
                <p>Agent map</p>
              </TooltipContent>
            </Tooltip>
          </motion.span>
        ) : null}
      </AnimatePresence>
      <AgentMapPanel
        open={open && visible}
        onOpenChange={setOpen}
        map={map}
        agentName={agentName}
        anchorRef={buttonRef}
      />
    </>
  );
}
