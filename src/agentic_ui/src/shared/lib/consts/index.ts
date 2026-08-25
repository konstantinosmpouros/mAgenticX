/**
 * Barrel for the app's shared constants, catalogs and backend→frontend
 * transforms.
 *
 * Why this file exists: every consumer imports from `@/shared/lib/consts`, and
 * that must keep resolving to a single, stable surface no matter how the
 * modules below are sliced.
 *
 * RULES for anything inside this folder:
 *  - Never import this barrel from within the folder — reach for the sibling
 *    leaf directly (`./icons`, `./transforms/base`, …). A barrel self-import is
 *    a real module cycle.
 *  - `transforms/*` may import from `../../types/<leaf>`; nothing under
 *    `types/` may import this barrel (only the `consts/` leaves).
 *  - `toDate` and `transformAttachment` stay folder-private: they are exported
 *    from their modules for sibling use but deliberately not re-exported here.
 */

export * from "./icons";
export * from "./auth-events";
export * from "./http-init";
export * from "./voice";
export * from "./personalization";
export * from "./ui";

export { transformAgent } from "./transforms/agent";
export { transformMessage } from "./transforms/message";
export {
  transformConversationSummary,
  transformConversationDetail,
} from "./transforms/conversation";
export { transformSharedConversationDetail } from "./transforms/sharing";
export { transformInferenceRun } from "./transforms/inference";
export { transformScheduledTask } from "./transforms/task";
