import type { EffortLevel } from "../types/agents";

/** The composer's effort picker: what each level is called. */
export const EFFORT_LABELS: Record<EffortLevel, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
};

/** The level as a phone-width composer shows it, where the full name would
 *  push the send button off screen. */
export const EFFORT_SHORT_LABELS: Record<EffortLevel, string> = {
  minimal: "Min",
  low: "Low",
  medium: "Med",
  high: "High",
  xhigh: "Max",
};

/** The one-line hint under each level in the picker's menu. */
export const EFFORT_HINTS: Record<EffortLevel, string> = {
  minimal: "Fastest",
  low: "Faster answers",
  medium: "Balanced",
  high: "Thinks longer",
  xhigh: "Deepest reasoning",
};
