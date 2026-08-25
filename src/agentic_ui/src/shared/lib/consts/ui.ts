/**
 * Shared display + layout constants used across the profile/settings surfaces.
 */

// Profile panel — shared display + layout constants.
export const NA = "N/A";

// Skills tab catalog search: how many ranked results to show for a query, and
// how many to show as an alphabetical browse slice when there is no query.
export const CATALOG_RESULT_LIMIT = 10;
export const CATALOG_BROWSE_LIMIT = 6;

// Below this viewport width the profile sidebar collapses into the compact
// horizontal mobile nav.
export const MOBILE_PROFILE_NAV_BREAKPOINT = 640;

export const MCP_ICON_SRCS = {
  grey: "/mcp-server-stroke-rounded (3).png",
  darkGrey: "/mcp-server-stroke-rounded (4).png",
  white: "/mcp-server-Stroke-Rounded (2).png",
  magenta: "/mcp-server-Stroke-Rounded (1).png",
  black: "/mcp-server-Stroke-Rounded.png",
} as const;

export type McpIconVariant = keyof typeof MCP_ICON_SRCS;

export const MCP_VARIANTS = {
  idleLight: "grey" as const,
  idleDark: "darkGrey" as const,
  hoverLight: "black" as const,
  hoverDark: "white" as const,
  // White, not magenta: the settings-nav Lucide icons render white when their
  // item is selected, and the MCP PNG must match them.
  active: "white" as const,
};
