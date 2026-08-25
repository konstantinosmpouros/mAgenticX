/**
 * Shared primitive used by every transform in this folder.
 *
 * Exported so the sibling transform modules can reach it, but not re-exported
 * from the consts barrel — it stays folder-private to the transforms.
 */
export const toDate = (value: any): Date => (value ? new Date(value) : new Date());
