import type { AgentTemplate } from "./shared";
import { RESEARCH_TEMPLATE } from "./research";
import { REPORT_STUDIO_TEMPLATE } from "./reports";
import { CODE_REVIEW_TEMPLATE } from "./codeReview";
import { PRODUCT_TEMPLATE } from "./product";
import { CONTENT_STUDIO_TEMPLATE } from "./content";
import { SUPPORT_DESK_TEMPLATE } from "./support";
import { CONTRACT_REVIEW_TEMPLATE } from "./contract";
import { TUTOR_TEMPLATE } from "./tutor";
import { SALES_OUTREACH_TEMPLATE } from "./sales";
import { HIRING_TEMPLATE } from "./hiring";
import { EXPERIMENT_LAB_TEMPLATE } from "./experiment";
import { TRIP_PLANNER_TEMPLATE } from "./trip";

/**
 * The starter templates on the New agent screen, in the order they show.
 * Each lives in its own file; `shared.ts` holds what they are built from.
 */
export const AGENT_TEMPLATES: readonly AgentTemplate[] = [
  RESEARCH_TEMPLATE,
  REPORT_STUDIO_TEMPLATE,
  CODE_REVIEW_TEMPLATE,
  PRODUCT_TEMPLATE,
  CONTENT_STUDIO_TEMPLATE,
  SUPPORT_DESK_TEMPLATE,
  CONTRACT_REVIEW_TEMPLATE,
  EXPERIMENT_LAB_TEMPLATE,
  HIRING_TEMPLATE,
  SALES_OUTREACH_TEMPLATE,
  TUTOR_TEMPLATE,
  TRIP_PLANNER_TEMPLATE,
];

export const findTemplate = (id: string | null): AgentTemplate | null =>
  AGENT_TEMPLATES.find((t) => t.id === id) ?? null;

export { teamSize } from "./shared";
export type { AgentTemplate } from "./shared";
