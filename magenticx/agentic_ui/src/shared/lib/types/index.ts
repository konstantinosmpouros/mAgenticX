/**
 * Barrel for the app's TypeScript contracts.
 *
 * Why this file exists: every consumer imports from `@/shared/lib/types`, and
 * that must keep resolving to a single, stable surface no matter how the domain
 * modules below are sliced. The types themselves live in one file per domain;
 * this barrel only re-exports them.
 *
 * Some contracts are INFERRED from the Zod schemas in `../schemas` (the single
 * source of truth for wire shapes). Those are re-exported from the domain module
 * they belong to, so the runtime validator and the compile-time type can never
 * drift apart.
 *
 * RULE: nothing inside `types/` may import this barrel — domain modules import
 * each other directly (`./agents`, `./messages`, …). A barrel self-import is a
 * real module cycle.
 */

export type * from "./auth";
export type * from "./agents";
export type * from "./catalog";
export type * from "./skills";
export type * from "./memories";
export type * from "./preferences";
export type * from "./voice";
export type * from "./conversations";
export type * from "./sharing";
export type * from "./messages";
export type * from "./attachments";
export type * from "./inference";
export type * from "./timeline";
export type * from "./tasks";
export type * from "./search";
export type * from "./usage";
export type * from "./ui";
