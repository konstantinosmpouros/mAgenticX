import {
  BookOpen,
  Brain,
  FolderOpen,
  Image,
  Pencil,
  Search,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react";

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
  /** Shown instead of the raw tool name. Omit to keep the name as-is. */
  label?: string;
  /**
   * Strip the card back to its payload: no Parameters pane and no "Result"
   * heading. For a tool whose whole output is one artifact, the scaffolding
   * says less than the artifact does.
   */
  bare?: boolean;
  /**
   * Icon for the chain-of-thought step, replacing the generic wrench. Only
   * worth setting where the glyph says something the label does not — a row of
   * identical wrenches gives the eye nothing to scan by.
   */
  icon?: LucideIcon;
};

export const TOOL_PRESENTATION: Record<string, ToolPresentation> = {
  // Icon only: these names are already what an engineer wants to read, so
  // there is nothing to relabel — the glyph is the whole addition.
  //
  // Grouped by what the step *did*, not by tool name: both searches share one
  // glyph, both writes share another, and everything that touches durable
  // memory shares a third. Scanning a long chain of thought is the job.
  read_file: { icon: BookOpen },
  ls: { icon: FolderOpen },
  // Searching the filesystem — `grep` by content, `glob` by name.
  grep: { icon: Search },
  glob: { icon: Search },
  // Writing to it.
  write_file: { icon: Pencil },
  edit_file: { icon: Pencil },
  execute: { icon: SquareTerminal },
  // Durable memory across conversations.
  remember: { icon: Brain },
  forget: { icon: Brain },
  search_past_conversations: { icon: Brain },
  // The one that needs all three: a human label, no arguments, just the image.
  view_image: { label: "View image", bare: true, icon: Image },
};

export const toolLabel = (name: string): string => TOOL_PRESENTATION[name]?.label ?? name;

export const toolIsBare = (name: string): boolean => TOOL_PRESENTATION[name]?.bare ?? false;

/** Icon for this tool's step, or undefined to keep the generic one. */
export const toolIcon = (name: string): LucideIcon | undefined => TOOL_PRESENTATION[name]?.icon;
