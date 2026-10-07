/**
 * Shared primitive used by every transform in this folder.
 *
 * Exported so the sibling transform modules can reach it, but not re-exported
 * from the consts barrel — it stays folder-private to the transforms.
 */
/** A count or percentage from the wire, or undefined for anything else. */
export const toOptionalNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/** A non-empty string from the wire, or undefined. */
export const toOptionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value ? value : undefined;

export const toDate = (value: any): Date => (value ? new Date(value) : new Date());
