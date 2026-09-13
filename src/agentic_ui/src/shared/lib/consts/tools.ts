/**
 * How a tool call is presented in the chain of thought.
 *
 * Most tools render generically: the raw tool name, the arguments, then the
 * result. A few read better with a human label and without their arguments —
 * `view_image` is the clear case, where the path is noise and the picture is
 * the whole point.
 *
 * Keyed by the tool name the agents service emits, so an unlisted tool keeps
 * the generic treatment and nothing has to be registered here to work.
 */
export type ToolPresentation = {
  /** Shown instead of the raw tool name. */
  label: string;
  /**
   * Strip the card back to its payload: no Parameters pane and no "Result"
   * heading. For a tool whose whole output is one artifact, the scaffolding
   * says less than the artifact does.
   */
  bare?: boolean;
};

export const TOOL_PRESENTATION: Record<string, ToolPresentation> = {
  view_image: { label: "View image", bare: true },
};

export const toolLabel = (name: string): string => TOOL_PRESENTATION[name]?.label ?? name;

export const toolIsBare = (name: string): boolean => TOOL_PRESENTATION[name]?.bare ?? false;
