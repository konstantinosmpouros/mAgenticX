import * as React from "react";
import {
  BoxSelect,
  Copy,
  Eraser,
  LayoutGrid,
  Maximize,
  Pencil,
  Redo2,
  Shapes,
  Trash2,
  Undo2,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/shared/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import type { WorkflowCanvasMenu } from "@/shared/lib/types";

/** What the canvas's right-click menu can do; each closes the menu after. */
export type CanvasMenuActions = {
  openPalette: () => void;
  tidy: () => void;
  fit: () => void;
  selectAll: () => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  clear: () => void;
  isEmpty: boolean;
  editNode: (nodeId: string) => void;
  duplicateNode: (nodeId: string) => void;
  remove: (nodeIds: string[], edgeIds: string[]) => void;
};

function MenuRow({
  icon: Icon,
  label,
  hint,
  shortcut,
  destructive = false,
  disabled = false,
  onSelect,
}: {
  icon: LucideIcon;
  label: string;
  /** One quiet line under the label: what it does. */
  hint?: string;
  shortcut?: string;
  destructive?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem
      disabled={disabled}
      onSelect={onSelect}
      className={cn(
        "items-start gap-2.5 rounded-lg px-2.5 py-2",
        destructive && "text-destructive focus:bg-destructive/[0.08] focus:text-destructive",
      )}
    >
      <Icon className={cn("mt-0.5 h-3.5 w-3.5 flex-shrink-0", destructive ? "" : "text-muted-foreground")} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] leading-5">{label}</span>
        {hint ? <span className="block text-[11px] leading-4 text-muted-foreground">{hint}</span> : null}
      </span>
      {shortcut ? (
        <kbd className="mt-0.5 flex-shrink-0 rounded border border-border/70 bg-muted/50 px-1 py-px font-sans text-[10px] text-muted-foreground">
          {shortcut}
        </kbd>
      ) : null}
    </DropdownMenuItem>
  );
}

/**
 * The canvas's right-click menu, at the pointer: on the empty canvas the
 * graph's actions (add a step, Tidy up, fit, select all, undo / redo, clear),
 * on a step its own (edit, duplicate, delete), on a connection or a
 * multi-selection their delete. A dropdown opened on a point (no new
 * dependency): an empty trigger placed where the click was.
 */
export function CanvasContextMenu({
  menu,
  open,
  onClose,
  actions,
}: {
  /** Where and on what (kept while the menu closes, so its exit stays in place). */
  menu: WorkflowCanvasMenu | null;
  /** Shown: set a frame after `menu`, once the anchor is at the pointer. */
  open: boolean;
  onClose: () => void;
  actions: CanvasMenuActions;
}) {
  const run = (action: () => void) => () => {
    onClose();
    action();
  };
  return (
    <DropdownMenu open={open && menu !== null} onOpenChange={(next) => (next ? null : onClose())} modal={false}>
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden
          className="pointer-events-none absolute h-px w-px"
          style={{ left: menu?.x ?? 0, top: menu?.y ?? 0 }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="bottom"
        sideOffset={2}
        className="w-64 rounded-xl p-1"
        data-testid="workflow-canvas-menu"
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        {menu?.target.type === "node" ? (
          <>
            <DropdownMenuLabel className="truncate px-2.5 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              {menu.target.label}
            </DropdownMenuLabel>
            <MenuRow icon={Pencil} label="Edit step" hint="Open its settings" shortcut="Enter" onSelect={run(() => actions.editNode((menu.target as { id: string }).id))} />
            <MenuRow icon={Copy} label="Duplicate" hint="A copy beside it, settings included" onSelect={run(() => actions.duplicateNode((menu.target as { id: string }).id))} />
            <DropdownMenuSeparator />
            <MenuRow icon={Trash2} label="Delete step" hint="Its connections go with it" shortcut="Del" destructive onSelect={run(() => actions.remove([(menu.target as { id: string }).id], []))} />
          </>
        ) : menu?.target.type === "edge" ? (
          <MenuRow icon={Trash2} label="Delete connection" shortcut="Del" destructive onSelect={run(() => actions.remove([], [(menu.target as { id: string }).id]))} />
        ) : menu?.target.type === "selection" ? (
          <MenuRow
            icon={Trash2}
            label="Delete selection"
            hint={`${menu.target.nodeIds.length} steps, ${menu.target.edgeIds.length} connections`}
            shortcut="Del"
            destructive
            onSelect={run(() => {
              const target = menu.target as { nodeIds: string[]; edgeIds: string[] };
              actions.remove(target.nodeIds, target.edgeIds);
            })}
          />
        ) : (
          <>
            <MenuRow icon={Shapes} label="Add a step" hint="Open the step list" onSelect={run(actions.openPalette)} />
            <MenuRow icon={LayoutGrid} label="Tidy up" hint="Line the steps up, left to right" disabled={actions.isEmpty} onSelect={run(actions.tidy)} />
            <MenuRow icon={Maximize} label="Fit to view" hint="Frame the whole workflow" disabled={actions.isEmpty} onSelect={run(actions.fit)} />
            <MenuRow icon={BoxSelect} label="Select all" disabled={actions.isEmpty} onSelect={run(actions.selectAll)} />
            <DropdownMenuSeparator />
            <MenuRow icon={Undo2} label="Undo" shortcut="Ctrl+Z" disabled={!actions.canUndo} onSelect={run(actions.undo)} />
            <MenuRow icon={Redo2} label="Redo" shortcut="Ctrl+Shift+Z" disabled={!actions.canRedo} onSelect={run(actions.redo)} />
            <DropdownMenuSeparator />
            <MenuRow icon={Eraser} label="Clear canvas" hint="Remove every step (asks first)" destructive disabled={actions.isEmpty} onSelect={run(actions.clear)} />
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
