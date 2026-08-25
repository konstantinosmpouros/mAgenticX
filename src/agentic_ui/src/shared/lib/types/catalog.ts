// ------------------------------------------------------
// Tool Schemas
// ------------------------------------------------------
import type { ToolMetadata } from "../schemas";

// `ToolMetadata` is inferred from `ToolMetadataSchema` (see `../schemas`).
export type { ToolMetadata } from "../schemas";

// Tools no longer carry a global enabled/disabled status — enablement is
// per-agent (Settings → Agents), resolved server-side. This stays as an alias
// so the read-only catalog views keep a stable prop name.
export type ToolWithStatus = ToolMetadata;

// Profile panel — a documentation/support entry on the Help tab.
export type HelpCard = {
  title: string;
  desc: string;
  href?: string;
  external?: boolean;
};

// Profile panel — a single label/value row rendered inside InfoRowsCard.
export type InfoRow = {
  label: string;
  value: string;
  hint?: string;
};
