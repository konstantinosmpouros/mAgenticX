import { Check, CircleAlert, CircleDashed, CircleSlash, Clock, Loader2 } from "lucide-react";
import type { ReactNode } from "react";

import type { SubagentRunStatus } from "@/shared/lib/types";

// How each sub-agent status reads — label, chip colours, icon. Shared by the
// inline sub-agent card (SubagentContainer) and the agent map, so a status
// looks the same wherever it shows.
export const STATUS_META: Record<
  SubagentRunStatus,
  { label: string; chip: string; icon: ReactNode }
> = {
  pending: {
    label: "Starting",
    chip: "bg-muted text-muted-foreground",
    icon: <CircleDashed className="h-3 w-3" aria-hidden="true" />,
  },
  running: {
    label: "Running",
    chip: "bg-[hsl(var(--subagent-active)/0.12)] text-[hsl(var(--subagent-active))]",
    icon: <Loader2 className="h-3 w-3 motion-safe:animate-spin" aria-hidden="true" />,
  },
  awaiting_approval: {
    label: "Awaiting approval",
    chip: "bg-warning/15 text-warning",
    icon: <Clock className="h-3 w-3" aria-hidden="true" />,
  },
  done: {
    label: "Done",
    chip: "bg-success/15 text-success",
    icon: <Check className="h-3 w-3" aria-hidden="true" />,
  },
  failed: {
    label: "Failed",
    chip: "bg-destructive/[0.12] text-destructive",
    icon: <CircleAlert className="h-3 w-3" aria-hidden="true" />,
  },
  cancelled: {
    label: "Cancelled",
    chip: "bg-muted text-muted-foreground",
    icon: <CircleSlash className="h-3 w-3" aria-hidden="true" />,
  },
};
