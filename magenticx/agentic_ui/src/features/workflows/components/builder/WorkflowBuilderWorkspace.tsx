import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  ArrowLeft,
  Eye,
  History,
  Loader2,
  MoreHorizontal,
  PanelLeft,
  Play,
  Redo2,
  RotateCcw,
  Settings2,
  Shapes,
  Trash2,
  Undo2,
  Workflow as WorkflowIcon,
  X,
} from "lucide-react";

import { cn } from "@/shared/lib/utils";
import { toastError } from "@/shared/lib/toast";
import { useToast } from "@/shared/hooks/use-toast";
import { useIsMobile } from "@/shared/hooks/use-mobile";
import { useLeaveGuard } from "@/shared/hooks/useLeaveGuard";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTitle } from "@/shared/ui/sheet";
import { SidebarTrigger } from "@/shared/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import type {
  Workflow,
  WorkflowBuilderIssue,
  WorkflowBuilderSelection,
  WorkflowCasesChange,
  WorkflowNodeKindInfo,
  WorkflowSchedule,
  WorkflowSpec,
} from "@/shared/lib/types";
import { usePaletteOpen } from "@/features/workflows/hooks/usePaletteOpen";
import { useWorkflowDraft } from "@/features/workflows/hooks/useWorkflowDraft";
import { useWorkflowDraftAutosave } from "@/features/workflows/hooks/useWorkflowDraftAutosave";
import { useWorkflowHistory } from "@/features/workflows/hooks/useWorkflowHistory";
import { useWorkflowUserId } from "@/features/workflows/hooks/useWorkflowUserId";
import { formatSavedAt } from "@/shared/lib/savedAt";
import { useWorkflowMutations } from "@/features/workflows/hooks/useWorkflowMutations";
import { useWorkflowValidation } from "@/features/workflows/hooks/useWorkflowValidation";
import { useWorkflowTools } from "@/features/workflows/hooks/useWorkflowTools";
import { nodeLabel } from "@/features/workflows/lib/kinds";
import {
  BAR_PRIMARY,
  BAR_SECONDARY,
  ICON_BUTTON,
  INSPECTOR_DRAWER_WIDTH,
  PALETTE_MOTION,
  PALETTE_WIDTH_REM,
} from "@/features/workflows/lib/builder/consts";
import { createNode, normalizeSpec } from "@/features/workflows/lib/builder/draft";
import { layoutSpec, nextNodePosition } from "@/features/workflows/lib/builder/flow";
import { NODE_CARD } from "@/features/workflows/lib/nodeCard";
import { TOOL_KIND, canConnect, kindInfoOf } from "@/features/workflows/lib/builder/graph";
import { fieldDomId, newEdgeId } from "@/features/workflows/lib/builder/ids";
import { checkSpec, issueCountByNode, mergeIssues } from "@/features/workflows/lib/builder/validate";
import { IssuesMenu } from "./builder_parts/IssuesMenu";
import { NodeInspector } from "./builder_parts/NodeInspector";
import { NodePalette } from "./builder_parts/NodePalette";
import { WorkflowHistory } from "./builder_parts/WorkflowHistory";
import { WorkflowSettings } from "./builder_parts/WorkflowSettings";

// The canvas brings React Flow along: its own chunk, fetched when the builder opens.
const BuilderCanvas = React.lazy(() => import("./builder_parts/BuilderCanvas"));
// A previewed version is drawn read-only by the workflow view's graph (its own chunk).
const PreviewGraph = React.lazy(() => import("../workflow_view_parts/WorkflowGraph"));
/** The preview graph's node clicks go nowhere: it is read-only. */
const ignoreNodePick = () => undefined;

const NO_SELECTION: WorkflowBuilderSelection = { nodes: [], edges: [] };
const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, index) => id === b[index]);

/**
 * The inspector drawer's motion, fixed once: it slides in when it opens and
 * out when it closes, and nothing else (a keystroke, an issue arriving, a
 * tooltip) hands it new targets.
 */
const DRAWER_MOTION = {
  initial: { x: "100%", opacity: 0.6 },
  animate: { x: 0, opacity: 1 },
  exit: { x: "100%", opacity: 0.6, transition: { duration: 0.22, ease: [0.4, 0, 1, 1] } },
  transition: { duration: 0.3, ease: [0.22, 1, 0.36, 1] },
} as const;
const DRAWER_MOTION_REDUCED = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0, transition: { duration: 0.12 } },
  transition: { duration: 0.3, ease: [0.22, 1, 0.36, 1] },
} as const;
/** The drawer's content swapping (another step picked): a short fade. */
const SWAP_MOTION = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, transition: { duration: 0.08 } },
  transition: { duration: 0.18, ease: "easeOut" },
} as const;
const SWAP_MOTION_REDUCED = { ...SWAP_MOTION, initial: { opacity: 0 } } as const;

/** The root font size (px): the palette's width is in rem, the canvas's insets in px. */
const rootFontPx = () => {
  if (typeof window === "undefined") return 16;
  return Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16;
};

/**
 * Scroll `element` into view inside `container` only. `scrollIntoView` (and a
 * plain `focus()`) scroll every scrollable ancestor, and an `overflow: hidden`
 * box is one: a field focused while the drawer was still sliding in used to
 * scroll the canvas frame sideways, dragging the whole graph with it.
 */
function scrollWithin(container: HTMLElement | null, element: HTMLElement, smooth: boolean) {
  if (!container || !container.contains(element)) return;
  const box = container.getBoundingClientRect();
  const target = element.getBoundingClientRect();
  const top = container.scrollTop + (target.top - box.top) - (container.clientHeight - target.height) / 2;
  container.scrollTo?.({ top: Math.max(0, top), behavior: smooth ? "smooth" : "auto" });
}

const isTextTarget = (target: EventTarget | null) => {
  const element = target as HTMLElement | null;
  if (!element) return false;
  return element.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName);
};

/**
 * The workflow builder (plan 38, step 3), in the agent builder's manners: a
 * top bar (back, name, unsaved state, issues, undo / redo, Settings, Run,
 * Save, more), the step palette — a panel over the canvas's left edge, opened
 * from the canvas's Steps button (remembered per device), shut by default —
 * (remembered per device) — and the canvas taking the rest. The inspector is
 * no column of its own: it slides over the canvas from the right as a drawer
 * when a step is picked (its form) or Settings is pressed (the workflow's
 * settings), and goes on Esc or × (a click on the empty canvas drops the
 * pick, which closes it too). On a phone
 * the palette and the inspector are bottom sheets.
 *
 * It owns the draft (`useWorkflowDraft`) and what watches it: the builder's
 * own checks on every change, the server's ~800 ms later, the leave guard.
 * Save is: the builder's checks, the server's validate, then create (and the
 * page moves to the edit route) or update (a new version only if changed).
 *
 * History (a saved workflow only) is the drawer's third face, opened from the
 * `vN` badge or the ⋯ menu: the kept versions with what each changed
 * (`WorkflowHistory`). Preview lays a version read-only over the canvas (the
 * draft underneath is untouched); Restore — confirmed, with a warning when
 * there are unsaved edits — saves that version again as the newest one and
 * loads it into the builder.
 */
export function WorkflowBuilderWorkspace({
  workflowId,
  initialSpec,
  savedVersion,
  initialSchedule = null,
  catalog,
  catalogLoading,
  catalogError,
  onRetryCatalog,
  backLabel,
  onExit,
  onSaved,
  onCreated,
  onOpenView,
  onDeleted,
  initialPanel = null,
}: {
  /** The saved workflow; null until the first save. */
  workflowId: string | null;
  initialSpec: WorkflowSpec;
  /** The version the initial spec is (null for a new workflow). */
  savedVersion: number | null;
  /** The saved workflow's live schedule (its start node's), for the trigger card's next run. */
  initialSchedule?: WorkflowSchedule | null;
  catalog: WorkflowNodeKindInfo[];
  catalogLoading: boolean;
  catalogError: string | null;
  onRetryCatalog: () => void;
  backLabel: string;
  onExit: () => void;
  /** Any save (and a delete): the sidebar's list reloads. */
  onSaved: (workflow: Workflow | null) => void;
  onCreated: (workflowId: string) => void;
  onOpenView: (workflowId: string) => void;
  onDeleted: () => void;
  /** Open with the History panel showing (the workflow view's History link). */
  initialPanel?: "history" | null;
}) {
  const { toast } = useToast();
  const mobile = useIsMobile();
  const reduceMotion = useReducedMotion();
  const { spec, dispatch, undo, redo, canUndo, canRedo, dirty, markSaved, reset, restore } = useWorkflowDraft(
    initialSpec,
    workflowId ? initialSpec : null,
  );
  const { save: saveWorkflow, remove } = useWorkflowMutations();
  const [savedId, setSavedId] = React.useState<string | null>(workflowId);
  const [version, setVersion] = React.useState<number | null>(savedVersion);
  // The schedule as the bridge last synced it: every save answers with it.
  const [savedSchedule, setSavedSchedule] = React.useState<WorkflowSchedule | null>(initialSchedule);
  const [selection, setSelection] = React.useState<WorkflowBuilderSelection>(NO_SELECTION);
  const [saving, setSaving] = React.useState<"checking" | "saving" | null>(null);
  const [attempted, setAttempted] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [reveal, setReveal] = React.useState<{ nodeId: string; at: number } | null>(null);
  const [fitSignal, setFitSignal] = React.useState(0);
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  // A phone's inspector sheet.
  const [inspectorOpen, setInspectorOpen] = React.useState(false);
  // The workflow's settings in the drawer (nothing picked).
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  // The History panel in the drawer (a phone: a sheet), and the version laid
  // read-only over the canvas, if any.
  const [historyOpen, setHistoryOpen] = React.useState(initialPanel === "history" && Boolean(workflowId));
  const [preview, setPreview] = React.useState<number | null>(null);
  const [confirmRestore, setConfirmRestore] = React.useState<number | null>(null);
  const palette = usePaletteOpen();
  const [confirmClear, setConfirmClear] = React.useState(false);
  // The palette lies over the canvas's left edge: the canvas always starts
  // after the rail, and the expanded list covers part of it (its left edge
  // never moves; only its right edge comes and goes). Folding or opening it
  // never resizes the canvas, so the graph never moves; the canvas only
  // learns how much of it the palette covers (framing, reveal, its controls).
  const [remPx] = React.useState(rootFontPx);
  const paletteCover = !mobile && palette.open ? PALETTE_WIDTH_REM * remPx : 0;
  const inspectorRef = React.useRef<HTMLDivElement>(null);

  // ---- issues ---------------------------------------------------------------
  // A tool step's arguments are checked against its tool's schema once the tool list is in.
  const hasToolStep = spec.nodes.some((node) => node.kind === TOOL_KIND);
  const tools = useWorkflowTools(hasToolStep);
  const toolList = hasToolStep ? tools.data : null;
  const clientIssues = React.useMemo(() => checkSpec(spec, catalog, toolList), [spec, catalog, toolList]);
  const server = useWorkflowValidation(spec, catalog.length > 0);
  const allIssues = React.useMemo(() => mergeIssues(clientIssues, server.issues), [clientIssues, server.issues]);
  // "Still empty" on a field nobody touched yet waits for a save attempt;
  // everything else (a broken edge, a bad id) shows at once.
  const visibleIssues = React.useMemo(
    () => (attempted ? allIssues : allIssues.filter((issue) => !/is required\.|needs a name\.|Give the workflow a name\.|Add a trigger:|Pick a tool\./.test(issue.message))),
    [allIssues, attempted],
  );
  const issueCounts = React.useMemo(() => issueCountByNode(visibleIssues), [visibleIssues]);
  const errorNodes = React.useMemo(
    () => new Set(visibleIssues.filter((issue) => issue.severity === "error" && issue.nodeId).map((issue) => issue.nodeId as string)),
    [visibleIssues],
  );

  const nameMissing = attempted && !spec.name.trim();

  // ---- autosave: unsaved edits survive leaving, offered back on return ----
  const userId = useWorkflowUserId();
  const autosave = useWorkflowDraftAutosave({ userId, workflowId: savedId, spec, dirty, initial: initialSpec });

  // ---- leaving --------------------------------------------------------------
  const guard = useLeaveGuard(dirty && saving === null);

  // ---- history: kept versions, preview, restore ---------------------------
  // Nothing loads until the panel opens on a saved workflow.
  const history = useWorkflowHistory({ workflowId: savedId, enabled: historyOpen && Boolean(savedId) });
  const previewDetail = preview !== null ? (history.details[preview] ?? null) : null;
  const previewFailed = preview !== null && !previewDetail && history.failedVersions.has(preview);
  const previewRef = React.useRef(preview);
  previewRef.current = preview;
  const { loadVersion } = history;
  React.useEffect(() => {
    if (preview !== null) void loadVersion(preview);
  }, [preview, loadVersion]);

  const openHistory = React.useCallback(() => {
    if (!savedId) return;
    setSettingsOpen(false);
    setSelection(NO_SELECTION);
    setInspectorOpen(false);
    setHistoryOpen(true);
  }, [savedId]);

  const showPreview = React.useCallback(
    (versionNo: number | null) => {
      setPreview(versionNo);
      // The draft under the preview is not editable: no palette over it.
      if (versionNo !== null) {
        palette.setOpen(false);
        setPaletteOpen(false);
        // A phone: the sheet steps aside so the canvas shows.
        if (mobile) setHistoryOpen(false);
      }
    },
    [palette, mobile],
  );

  const restoreVersion = async (versionNo: number) => {
    const before = version;
    const workflow = await history.restore(versionNo);
    if (!workflow) return;
    // The restored spec is the newest version now: the builder loads it as
    // saved (undo history starts over; the autosaved draft is done with).
    const restoredSpec = workflow.spec ?? history.details[versionNo]?.spec ?? null;
    if (restoredSpec) reset(restoredSpec);
    autosave.clear();
    setAttempted(false);
    setPreview(null);
    changeSelection(NO_SELECTION);
    setVersion(workflow.latestVersionNo);
    setSavedSchedule(workflow.schedule ?? null);
    setFitSignal((n) => n + 1);
    onSaved(workflow);
    if (workflow.latestVersionNo !== null && workflow.latestVersionNo !== before) {
      toast({
        title: `Version ${versionNo} restored`,
        description: `Saved as version ${workflow.latestVersionNo}; new runs use it. Every earlier version is still in the history.`,
      });
    } else {
      toast({
        title: "Nothing to restore",
        description: `Version ${versionNo} is the same as the current version.`,
      });
    }
  };

  // ---- selection --------------------------------------------------------------
  const selectedNode =
    selection.nodes.length === 1 ? (spec.nodes.find((node) => node.id === selection.nodes[0]) ?? null) : null;
  const changeSelection = React.useCallback((next: WorkflowBuilderSelection) => {
    // A pick takes the drawer over from the settings (and the history).
    if (next.nodes.length || next.edges.length) {
      setSettingsOpen(false);
      setHistoryOpen(false);
      setPreview(null);
    }
    setSelection((current) =>
      sameIds(current.nodes, next.nodes) && sameIds(current.edges, next.edges) ? current : next,
    );
  }, []);
  const hasSelection = selection.nodes.length > 0 || selection.edges.length > 0;
  // Desktop: the drawer is open while something is picked, or the settings
  // (or the history) are.
  const drawerOpen = !mobile && (settingsOpen || historyOpen || hasSelection);

  // A step is brought into view only once the drawer has finished opening (one
  // move after the slide, never during it); with the drawer already open, or
  // on a phone (no drawer), at once.
  const drawerReady = React.useRef(false);
  const pendingReveal = React.useRef<string | null>(null);
  const requestReveal = React.useCallback(
    (nodeId: string) => {
      if (mobile || drawerReady.current) {
        pendingReveal.current = null;
        setReveal({ nodeId, at: Date.now() });
      } else {
        pendingReveal.current = nodeId;
      }
    },
    [mobile],
  );
  const drawerOpenRef = React.useRef(drawerOpen);
  drawerOpenRef.current = drawerOpen;
  React.useEffect(() => {
    if (drawerOpen) return;
    drawerReady.current = false;
    pendingReveal.current = null;
  }, [drawerOpen]);
  const onDrawerSettled = React.useCallback(() => {
    // The exit's completion too: only an open drawer is ready.
    if (!drawerOpenRef.current) return;
    drawerReady.current = true;
    const nodeId = pendingReveal.current;
    pendingReveal.current = null;
    if (nodeId) setReveal({ nodeId, at: Date.now() });
  }, []);

  const closeDrawer = React.useCallback(() => {
    setSettingsOpen(false);
    setHistoryOpen(false);
    setPreview(null);
    changeSelection(NO_SELECTION);
  }, [changeSelection]);

  const toggleSettings = React.useCallback(() => {
    if (mobile) {
      changeSelection(NO_SELECTION);
      setInspectorOpen(true);
      return;
    }
    if (settingsOpen) {
      setSettingsOpen(false);
      return;
    }
    changeSelection(NO_SELECTION);
    setHistoryOpen(false);
    setPreview(null);
    setSettingsOpen(true);
  }, [mobile, settingsOpen, changeSelection]);
  // A step that went away (deleted, undone) is no longer picked.
  React.useEffect(() => {
    const ids = new Set(spec.nodes.map((node) => node.id));
    const edgeIds = new Set(spec.edges.map((edge) => edge.id));
    if (selection.nodes.some((id) => !ids.has(id)) || selection.edges.some((id) => !edgeIds.has(id))) {
      changeSelection({
        nodes: selection.nodes.filter((id) => ids.has(id)),
        edges: selection.edges.filter((id) => edgeIds.has(id)),
      });
    }
  }, [spec.nodes, spec.edges, selection, changeSelection]);

  const focusField = React.useCallback(
    (nodeId: string | null, field: string) => {
      window.setTimeout(
        () => {
          const candidates = [field, field.replace(/\[\d+\].*$/, ""), field.split(".").slice(0, 2).join(".")];
          for (const candidate of candidates) {
            const element = document.getElementById(fieldDomId(nodeId, candidate));
            if (element) {
              // Never scroll anything but the inspector itself (see scrollWithin).
              element.focus({ preventScroll: true });
              scrollWithin(inspectorRef.current, element, !reduceMotion);
              return;
            }
          }
        },
        reduceMotion ? 30 : 220,
      );
    },
    [reduceMotion],
  );

  const goToIssue = React.useCallback(
    (issue: WorkflowBuilderIssue) => {
      changeSelection(issue.nodeId ? { nodes: [issue.nodeId], edges: [] } : NO_SELECTION);
      if (issue.nodeId) requestReveal(issue.nodeId);
      else setSettingsOpen(true);
      setInspectorOpen(true);
      focusField(issue.nodeId, issue.field);
    },
    [changeSelection, focusField, requestReveal],
  );

  // A step picked on a wide screen: keep it out from under the drawer.
  const pickedId = selectedNode?.id ?? null;
  React.useEffect(() => {
    if (pickedId && !mobile) requestReveal(pickedId);
  }, [pickedId, mobile, requestReveal]);

  const nodeName = React.useCallback(
    (nodeId: string) => nodeLabel(spec.nodes.find((node) => node.id === nodeId), nodeId),
    [spec.nodes],
  );

  // ---- editing ----------------------------------------------------------------
  // Any kind may be added, a trigger too: "exactly one trigger" is the
  // builder's check (and the engine's), not a lock on the palette. The one
  // refusal is a kind the server cannot run now (`available: false`): the
  // palette already disables it, this also covers a drop and any other path.
  const addNode = React.useCallback(
    (kind: string, position?: { x: number; y: number }) => {
      const info = kindInfoOf(catalog, kind);
      if (info && info.available === false) {
        toast({
          title: `${info.label} is unavailable`,
          description: info.unavailableReason ?? "This step can't run on this server.",
        });
        return;
      }
      const at = position ?? nextNodePosition(spec, selectedNode?.id ?? null);
      const node = createNode(spec, kind, info, at);
      dispatch({ type: "add-node", node });
      // The first step on an empty canvas: frame it (nothing was framed yet).
      if (!spec.nodes.length) setFitSignal((n) => n + 1);
      // Added by click after a step that leads nowhere yet: connect them. (A
      // second connection would start parallel paths — drawn by hand only.)
      const leadsSomewhere = spec.edges.some((edge) => edge.source === selectedNode?.id);
      if (!position && selectedNode && !leadsSomewhere) {
        const branch = null;
        const check = canConnect({ nodes: [...spec.nodes, node], edges: spec.edges }, catalog, {
          source: selectedNode.id,
          target: node.id,
          branch,
        });
        if (check.ok) {
          dispatch({
            type: "add-edge",
            edge: { id: newEdgeId(new Set(spec.edges.map((edge) => edge.id))), source: selectedNode.id, target: node.id, branch },
          });
        }
      }
      // Added by click: picked (the next click adds after it). Dropped from
      // the palette: placed only; the inspector opens on a click on the step.
      if (!position) changeSelection({ nodes: [node.id], edges: [] });
      setPaletteOpen(false);
    },
    [catalog, spec, selectedNode, dispatch, changeSelection, toast],
  );

  const connect = React.useCallback(
    (connection: { source: string; target: string; branch: string | null }) => {
      const check = canConnect(spec, catalog, connection);
      if (!check.ok) {
        toast({ title: "Can't connect these", description: check.reason });
        return;
      }
      dispatch({
        type: "add-edge",
        edge: { id: newEdgeId(new Set(spec.edges.map((edge) => edge.id))), ...connection },
      });
    },
    [spec, catalog, dispatch, toast],
  );

  const removeElements = React.useCallback(
    (nodeIds: string[], edgeIds: string[]) => dispatch({ type: "remove", nodeIds, edgeIds }),
    [dispatch],
  );

  const moveNodes = React.useCallback(
    (positions: Record<string, { x: number; y: number }>) => dispatch({ type: "move-nodes", positions }),
    [dispatch],
  );

  const refuse = React.useCallback(
    (reason: string) => toast({ title: "Can't connect these", description: reason }),
    [toast],
  );

  // A copy of a step beside it (its config and label too), picked.
  const duplicateNode = React.useCallback(
    (nodeId: string) => {
      const source = spec.nodes.find((node) => node.id === nodeId);
      if (!source) return;
      const copy = createNode(spec, source.kind, kindInfoOf(catalog, source.kind), {
        x: source.position.x + 32,
        y: source.position.y + NODE_CARD.headerHeight + 48,
      });
      const node = { ...copy, label: source.label ?? null, config: structuredClone(source.config) };
      dispatch({ type: "add-node", node });
      changeSelection({ nodes: [node.id], edges: [] });
    },
    [spec, catalog, dispatch, changeSelection],
  );

  // Every step and connection goes; Undo brings them back (asked first).
  const clearCanvas = React.useCallback(() => {
    changeSelection(NO_SELECTION);
    dispatch({ type: "remove", nodeIds: spec.nodes.map((node) => node.id), edgeIds: spec.edges.map((edge) => edge.id) });
  }, [spec.nodes, spec.edges, dispatch, changeSelection]);

  const tidy = React.useCallback(() => {
    dispatch({ type: "move-nodes", positions: layoutSpec(spec, catalog) });
    setFitSignal((n) => n + 1);
  }, [dispatch, spec, catalog]);

  const activate = React.useCallback(() => {
    setInspectorOpen(true);
    window.setTimeout(() => {
      inspectorRef.current
        ?.querySelector<HTMLElement>("input, textarea, [role=combobox], button")
        ?.focus({ preventScroll: true });
    }, 60);
  }, []);

  // ---- save ---------------------------------------------------------------------
  const save = async () => {
    if (saving) return;
    setAttempted(true);
    const blocking = allIssues.find((issue) => issue.source === "client" && issue.severity === "error");
    if (blocking) {
      goToIssue(blocking);
      return;
    }
    setSaving("checking");
    const checked = await server.validateNow();
    const first = checked?.find((issue) => issue.severity === "error");
    if (first) {
      setSaving(null);
      goToIssue(first);
      return;
    }
    setSaving("saving");
    const sent = normalizeSpec(spec);
    const result = await saveWorkflow(savedId, sent);
    setSaving(null);
    if (!result.ok) {
      if (result.invalid) {
        const placed = server.adopt(result.invalid, sent);
        const firstPlaced = placed[0];
        if (firstPlaced) goToIssue(firstPlaced);
        toast({ title: "Not saved", description: result.message });
      } else {
        toastError(toast, "The workflow wasn't saved", result.error, { description: result.message });
      }
      return;
    }
    const workflow = result.workflow;
    // Saved: the autosaved copy (under this key: `new` before a first save) is done with.
    autosave.clear();
    markSaved(spec);
    const before = version;
    setVersion(workflow.latestVersionNo);
    // The save's answer is the workflow as the bridge synced it, its schedule
    // (next run) included: the trigger card reads it from here on.
    setSavedSchedule(workflow.schedule ?? null);
    onSaved(workflow);
    // A new version may have joined the list the panel shows.
    if (historyOpen) void history.reload();
    if (!savedId) {
      setSavedId(workflow.id);
      toast({ title: "Workflow created", description: "Version 1 is saved. Run it from the top bar." });
      onCreated(workflow.id);
    } else if (workflow.latestVersionNo !== null && workflow.latestVersionNo !== before) {
      toast({ title: `Saved as version ${workflow.latestVersionNo}`, description: "New runs use this version." });
    } else {
      toast({ title: "No changes to save", description: `Still version ${workflow.latestVersionNo ?? before ?? 1}.` });
    }
  };
  const saveRef = React.useRef(save);
  saveRef.current = save;

  // ---- keyboard: save, undo, redo ---------------------------------------------
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "s") {
        event.preventDefault();
        void saveRef.current();
        return;
      }
      // In a text field, undo is the field's own; under a preview the draft is out of sight.
      if (isTextTarget(event.target) || previewRef.current !== null) return;
      if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        undo();
      } else if ((key === "z" && event.shiftKey) || key === "y") {
        event.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [undo, redo]);

  const deleteWorkflow = async () => {
    if (!savedId) return;
    try {
      await remove(savedId);
    } catch (error) {
      toastError(toast, "The workflow wasn't deleted", error);
      throw error;
    }
    autosave.clear();
    markSaved(spec);
    onSaved(null);
    toast({ title: "Workflow deleted" });
    onDeleted();
  };

  // ---- the inspector ------------------------------------------------------------
  const updateSelected = (config: Record<string, unknown>, cases?: WorkflowCasesChange) => {
    if (!selectedNode) return;
    dispatch(
      {
        type: "update-node",
        id: selectedNode.id,
        patch: { config },
        ...(cases?.rename ? { renameBranches: [cases.rename] } : {}),
        ...(cases?.drop ? { dropBranches: [cases.drop] } : {}),
      },
      { coalesce: cases ? undefined : `config:${selectedNode.id}` },
    );
  };

  const historyBody = savedId ? (
    <WorkflowHistory
      history={history}
      workflowName={spec.name.trim() || "this workflow"}
      currentVersionNo={version}
      previewing={preview}
      onPreview={showPreview}
      onRequestRestore={setConfirmRestore}
    />
  ) : null;

  const inspectorBody = historyOpen && !mobile ? (
    historyBody
  ) : selectedNode ? (
    <NodeInspector
      key={selectedNode.id}
      node={selectedNode}
      info={kindInfoOf(catalog, selectedNode.kind)}
      spec={spec}
      issues={visibleIssues.filter((issue) => issue.nodeId === selectedNode.id)}
      onRename={(to) => {
        dispatch({ type: "rename-node", from: selectedNode.id, to });
        changeSelection({ nodes: [to], edges: [] });
      }}
      onLabel={(label) =>
        dispatch({ type: "update-node", id: selectedNode.id, patch: { label } }, { coalesce: `label:${selectedNode.id}` })
      }
      onConfig={updateSelected}
    />
  ) : selection.nodes.length > 1 || selection.edges.length ? (
    <div className="space-y-3 text-sm text-muted-foreground">
      <p>
        {selection.nodes.length ? `${selection.nodes.length} steps` : null}
        {selection.nodes.length && selection.edges.length ? " and " : null}
        {selection.edges.length ? `${selection.edges.length} connection${selection.edges.length === 1 ? "" : "s"}` : null}{" "}
        selected.
      </p>
      <button
        type="button"
        className={cn(BAR_SECONDARY, "hover:border-destructive/40 hover:text-destructive")}
        onClick={() => removeElements(selection.nodes, selection.edges)}
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden />
        Delete selection
      </button>
      <p className="text-xs">Backspace or Delete does the same. Settings in the top bar opens the workflow&apos;s settings.</p>
    </div>
  ) : mobile || settingsOpen ? (
    <WorkflowSettings spec={spec} dispatch={dispatch} issues={visibleIssues.filter((issue) => !issue.nodeId)} />
  ) : null;
  const inspectorKey =
    historyOpen && !mobile
      ? "history"
      : selectedNode
        ? `node:${selectedNode.id}`
        : hasSelection
          ? "many"
          : inspectorBody
            ? "workflow"
            : "none";
  const inspectorTitle =
    historyOpen && !mobile ? "History" : selectedNode ? "Edit the step" : hasSelection ? "Selection" : "Workflow settings";

  const inspector = (
    // A steady scrollbar gutter: a form growing past the drawer's height (an
    // issue line, a hint) never brings a scrollbar in that narrows and re-wraps it.
    <div
      ref={inspectorRef}
      className="scrollbar-muted h-full min-h-0 overflow-y-auto overscroll-contain px-5 py-5 [scrollbar-gutter:stable]"
      role="region"
      aria-label="Inspector"
    >
      {/* Keyed by what is picked: it swaps on a new pick, never on an edit. */}
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={inspectorKey} {...(reduceMotion ? SWAP_MOTION_REDUCED : SWAP_MOTION)}>
          {inspectorBody}
        </motion.div>
      </AnimatePresence>
    </div>
  );

  const paletteProps = {
    catalog,
    isLoading: catalogLoading,
    error: catalogError,
    onRetry: onRetryCatalog,
    onAdd: (kind: string) => addNode(kind),
  };

  const busyLabel = saving === "checking" ? "Checking…" : saving === "saving" ? (savedId ? "Saving…" : "Creating…") : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ---- top bar ---- */}
      <header className="relative z-10 flex flex-shrink-0 items-center gap-2 border-b border-border/50 bg-background/80 px-3 py-2.5 backdrop-blur sm:gap-3 sm:px-4">
        <SidebarTrigger
          aria-label="Toggle sidebar"
          className="inline-flex h-9 w-9 flex-shrink-0 rounded-xl bg-transparent text-foreground hover:bg-[hsl(var(--hover-surface))] md:hidden [&_svg]:size-5"
        />
        <button
          type="button"
          onClick={() => guard.confirmLeave(onExit)}
          className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-[hsl(var(--hover-surface))] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          <span className="sr-only max-w-[10rem] truncate sm:not-sr-only">{backLabel}</span>
        </button>
        <span className="hidden h-5 w-px flex-shrink-0 bg-border/70 sm:block" aria-hidden />
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <span className="hidden h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl bg-primary/[0.12] text-primary sm:flex">
            <WorkflowIcon className="h-4 w-4" aria-hidden />
          </span>
          <input
            value={spec.name}
            onChange={(event) => dispatch({ type: "set-name", value: event.target.value }, { coalesce: "name" })}
            placeholder="Name this workflow"
            aria-label="Workflow name"
            aria-invalid={nameMissing || undefined}
            maxLength={120}
            className={cn(
              "min-w-0 flex-1 truncate rounded-lg border border-transparent bg-transparent px-1.5 py-1 text-[15px] font-semibold tracking-tight text-foreground transition-colors placeholder:font-medium placeholder:text-muted-foreground/70 hover:border-border/60 focus-visible:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20 sm:max-w-[22rem]",
              // Every workflow has a title: after a save attempt without one, the field says so.
              nameMissing && "border-destructive/50 bg-destructive/[0.04] placeholder:text-destructive/70",
            )}
          />
          <AnimatePresence initial={false}>
            {dirty ? (
              <motion.span
                key="dirty"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="hidden flex-shrink-0 items-center gap-1.5 text-xs text-muted-foreground lg:inline-flex"
                aria-live="polite"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-[hsl(var(--warning))]" aria-hidden />
                Unsaved changes
              </motion.span>
            ) : null}
          </AnimatePresence>
        </div>
        <IssuesMenu issues={visibleIssues} checking={server.checking} nodeName={nodeName} onPick={goToIssue} />
        <div className="hidden items-center gap-0.5 rounded-full border border-border/60 bg-background/60 p-0.5 sm:flex">
          <Tooltip>
            <TooltipTrigger asChild>
              {/* A span keeps the tooltip on a disabled button. */}
              <span className="inline-flex">
                <button type="button" className={cn(ICON_BUTTON, "rounded-full")} onClick={undo} disabled={!canUndo} aria-label="Undo">
                  <Undo2 className="h-4 w-4" aria-hidden />
                </button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              Undo (Ctrl+Z)
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <button type="button" className={cn(ICON_BUTTON, "rounded-full")} onClick={redo} disabled={!canRedo} aria-label="Redo">
                  <Redo2 className="h-4 w-4" aria-hidden />
                </button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              Redo (Ctrl+Shift+Z)
            </TooltipContent>
          </Tooltip>
        </div>
        {/* A phone has Settings once, under the canvas (beside Add step). */}
        {mobile ? null : (
          <button
            type="button"
            onClick={toggleSettings}
            className={cn(BAR_SECONDARY, settingsOpen && "border-primary/40 bg-primary/[0.08] text-primary")}
            aria-label="Workflow settings"
            aria-pressed={settingsOpen}
            title="The workflow's name, description, inputs and variables"
          >
            <Settings2 className="h-3.5 w-3.5" aria-hidden />
            <span className="hidden md:inline" aria-hidden>
              Settings
            </span>
          </button>
        )}
        {savedId ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => guard.confirmLeave(() => onOpenView(savedId))}
                className={BAR_SECONDARY}
                aria-label="Run"
              >
                <Play className="h-3.5 w-3.5" aria-hidden />
                <span className="hidden sm:inline" aria-hidden>
                  Run
                </span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              Open the workflow to run its saved version
            </TooltipContent>
          </Tooltip>
        ) : null}
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" onClick={() => void save()} disabled={saving !== null} className={BAR_PRIMARY}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
              {busyLabel ?? (savedId ? "Save" : "Create")}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            {savedId ? "Save as a new version (Ctrl+S)" : "Create the workflow; this is its first version (Ctrl+S)"}
          </TooltipContent>
        </Tooltip>
        {savedId ? (
          // Not modal: Delete opens a confirm dialog; a modal menu's body lock
          // could be left behind (AgentsIndex's card menu, same fix).
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <button type="button" className={cn(ICON_BUTTON, "h-8 w-8")} aria-label="More actions">
                <MoreHorizontal className="h-4 w-4" aria-hidden />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="rounded-xl p-1">
              <DropdownMenuItem onSelect={openHistory} className="gap-2 rounded-lg">
                <History className="h-3.5 w-3.5" aria-hidden />
                Version history
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => setConfirmDelete(true)}
                className="gap-2 rounded-lg text-destructive focus:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
                Delete workflow
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </header>

      {/* ---- restore banner: unsaved edits an earlier visit left ---- */}
      <AnimatePresence initial={false}>
        {autosave.offer ? (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.22, ease: "easeOut" }}
            className="flex-shrink-0 overflow-hidden border-b border-primary/20 bg-primary/[0.06]"
            role="status"
            data-testid="workflow-restore-banner"
          >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
              <History className="h-4 w-4 flex-shrink-0 text-primary" aria-hidden />
              <p className="min-w-0 flex-1 text-[13px] text-foreground">
                Restore unsaved changes from {formatSavedAt(autosave.offer.savedAt)}?
              </p>
              <button
                type="button"
                className={cn(BAR_PRIMARY, "px-3 py-1 text-xs")}
                onClick={() => {
                  const stored = autosave.offer;
                  if (!stored) return;
                  changeSelection(NO_SELECTION);
                  setSettingsOpen(false);
                  restore(stored.spec);
                  autosave.dismiss({ discard: false });
                  setFitSignal((n) => n + 1);
                }}
              >
                Restore
              </button>
              <button
                type="button"
                className={cn(BAR_SECONDARY, "px-3 py-1 text-xs")}
                onClick={() => autosave.dismiss({ discard: true })}
              >
                Discard
              </button>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* ---- preview banner: a kept version is shown read-only ---- */}
      <AnimatePresence initial={false}>
        {preview !== null ? (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.12 } }}
            transition={{ duration: reduceMotion ? 0 : 0.2, ease: "easeOut" }}
            className="flex-shrink-0 border-b border-border/60 bg-muted/40"
            role="status"
            data-testid="workflow-preview-banner"
          >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
              <Eye className="h-4 w-4 flex-shrink-0 text-primary" aria-hidden />
              <p className="min-w-0 flex-1 text-[13px] text-foreground">
                <span className="font-semibold">Previewing version {preview}</span>
                <span className="text-muted-foreground">
                  {" "}
                  · read-only{dirty ? ". Your unsaved changes are kept underneath." : "."}
                </span>
              </p>
              {preview !== version ? (
                <button
                  type="button"
                  className={cn(BAR_PRIMARY, "px-3 py-1 text-xs")}
                  onClick={() => setConfirmRestore(preview)}
                  disabled={history.restoringVersion !== null}
                >
                  {history.restoringVersion === preview ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  ) : (
                    <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                  )}
                  Restore this version
                </button>
              ) : null}
              {mobile ? (
                <button
                  type="button"
                  className={cn(BAR_SECONDARY, "px-3 py-1 text-xs")}
                  onClick={() => setHistoryOpen(true)}
                >
                  <History className="h-3.5 w-3.5" aria-hidden />
                  History
                </button>
              ) : null}
              <button
                type="button"
                className={cn(BAR_SECONDARY, "px-3 py-1 text-xs")}
                onClick={() => setPreview(null)}
              >
                Back to editing
              </button>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* ---- palette + canvas (the inspector slides over it) ----
          `overflow-clip`, not `hidden`: a clipping box that is no scroll
          container, so no focus(), caret or scrollIntoView inside the drawer
          or the palette can scroll the canvas sideways under the user. */}
      <div className="relative flex min-h-0 flex-1 overflow-clip">
        {/* The palette: over the canvas's left edge, sliding in from it, and not
            rendered at all while shut (the Steps button opens it). */}
        <AnimatePresence initial={false}>
          {!mobile && palette.open ? (
            <motion.aside
              key="palette"
              className="absolute inset-y-0 left-0 z-[25] hidden overflow-hidden border-r border-border/50 bg-card shadow-[24px_0_48px_-28px_hsl(var(--foreground)/0.45)] md:block"
              style={{ width: `${PALETTE_WIDTH_REM}rem` }}
              initial={reduceMotion ? { opacity: 0 } : { x: "-100%" }}
              animate={reduceMotion ? { opacity: 1 } : { x: 0 }}
              exit={reduceMotion ? { opacity: 0 } : { x: "-100%" }}
              transition={{ duration: reduceMotion ? 0 : PALETTE_MOTION.durationMs / 1000, ease: PALETTE_MOTION.ease }}
              data-testid="workflow-palette"
              onKeyDown={(event) => {
                if (event.key === "Escape" && !event.defaultPrevented) {
                  event.preventDefault();
                  palette.setOpen(false);
                }
              }}
            >
              <NodePalette {...paletteProps} onClose={() => palette.setOpen(false)} />
            </motion.aside>
          ) : null}
        </AnimatePresence>
        <div
          className="relative isolate min-h-0 min-w-0 flex-1 overflow-clip bg-[radial-gradient(ellipse_at_top,hsl(var(--primary)/0.05),transparent_60%)]"
          data-testid="workflow-canvas-frame"
          onKeyDown={(event) => {
            // A key from a portalled menu bubbles here through React too: it handles its own Esc.
            if (event.key === "Escape" && drawerOpen && !event.defaultPrevented) {
              event.preventDefault();
              closeDrawer();
            }
          }}
        >
          <React.Suspense fallback={<CanvasLoading />}>
            <BuilderCanvas
              spec={spec}
              catalog={catalog}
              issueCounts={issueCounts}
              errorNodes={errorNodes}
              selection={selection}
              onSelectionChange={changeSelection}
              onMove={moveNodes}
              onConnect={connect}
              onRefused={refuse}
              onRemove={removeElements}
              onDropKind={addNode}
              onActivate={activate}
              onTidy={tidy}
              onDuplicate={duplicateNode}
              onClear={() => setConfirmClear(true)}
              onUndo={undo}
              onRedo={redo}
              canUndo={canUndo}
              canRedo={canRedo}
              onOpenPalette={() => (mobile ? setPaletteOpen(true) : palette.setOpen(true))}
              mobile={mobile}
              fitSignal={fitSignal}
              reveal={reveal}
              rightInset={drawerOpen ? INSPECTOR_DRAWER_WIDTH : 0}
              leftInset={paletteCover}
              savedSchedule={savedSchedule}
            />
          </React.Suspense>
          {/* A previewed version, read-only over the draft (which stays mounted
              underneath, untouched: its pan, zoom and undo history survive). */}
          {preview !== null ? (
            <div
              className="absolute inset-0 z-[15] bg-background"
              data-testid="workflow-preview-canvas"
              aria-label={`Version ${preview}, read-only`}
              role="region"
            >
              {previewDetail ? (
                <React.Suspense fallback={<CanvasLoading />}>
                  <PreviewGraph
                    key={preview}
                    spec={previewDetail.spec}
                    view={null}
                    catalog={catalog}
                    selectedNodeId={null}
                    onSelectNode={ignoreNodePick}
                    rightInset={drawerOpen ? INSPECTOR_DRAWER_WIDTH : 0}
                  />
                </React.Suspense>
              ) : previewFailed ? (
                <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted-foreground">
                  <p>Version {preview} could not be loaded.</p>
                  <button type="button" className={BAR_SECONDARY} onClick={() => void loadVersion(preview)}>
                    Try again
                  </button>
                </div>
              ) : (
                <CanvasLoading />
              )}
            </div>
          ) : null}
          {!mobile && !palette.open && preview === null ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => palette.setOpen(true)}
                  className={cn(BAR_SECONDARY, "absolute left-3 top-3 z-10 bg-card/90 shadow-sm backdrop-blur")}
                  aria-label="Open the steps"
                  aria-expanded={false}
                  data-testid="workflow-palette-open"
                >
                  <Shapes className="h-3.5 w-3.5" aria-hidden />
                  Steps
                </button>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={8} className="max-w-[15rem] text-xs">
                <span className="block font-medium">Add a step</span>
                <span className="mt-0.5 block text-muted-foreground">Open the step list, then drag a step onto the canvas.</span>
              </TooltipContent>
            </Tooltip>
          ) : null}
          {mobile && preview === null ? (
            <div className="absolute bottom-3 right-3 z-10 flex gap-2">
              <button type="button" className={cn(BAR_SECONDARY, "bg-card shadow-sm")} onClick={() => setPaletteOpen(true)}>
                <PanelLeft className="h-3.5 w-3.5" aria-hidden />
                Add step
              </button>
              <button type="button" className={cn(BAR_SECONDARY, "bg-card shadow-sm")} onClick={() => setInspectorOpen(true)}>
                <Settings2 className="h-3.5 w-3.5" aria-hidden />
                {selectedNode ? "Edit step" : "Settings"}
              </button>
            </div>
          ) : mobile ? null : (
            // Over the canvas from the right. Shut, it is not rendered at all
            // (unmounted once it has slid out), so nothing of it — its shadow,
            // its border, its header — is left at the canvas's edge.
            <AnimatePresence initial={false}>
              {drawerOpen ? (
                <motion.aside
                  key="inspector-drawer"
                  className="absolute inset-y-0 right-0 z-20 flex flex-col border-l border-border/60 bg-card shadow-[-24px_0_48px_-28px_hsl(var(--foreground)/0.5)] will-change-transform dark:shadow-[-24px_0_48px_-24px_hsl(0_0%_0%/0.7)]"
                  style={{ width: `min(${INSPECTOR_DRAWER_WIDTH}px, calc(100% - 2.5rem))` }}
                  {...(reduceMotion ? DRAWER_MOTION_REDUCED : DRAWER_MOTION)}
                  onAnimationComplete={onDrawerSettled}
                  data-state="open"
                  data-testid="workflow-inspector-drawer"
                  aria-label="Edit the selection"
                >
                  <div className="flex h-12 flex-shrink-0 items-center justify-between gap-2 border-b border-border/50 pl-5 pr-2.5">
                    <p className="truncate text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                      {inspectorTitle}
                    </p>
                    <div className="flex flex-shrink-0 items-center gap-1.5">
                      <kbd className="hidden rounded-md border border-border/70 bg-muted/50 px-1.5 py-px font-sans text-[10px] font-medium text-muted-foreground lg:inline">
                        Esc
                      </kbd>
                      <button
                        type="button"
                        onClick={closeDrawer}
                        aria-label="Close the inspector"
                        title="Close (Esc)"
                        className={cn(ICON_BUTTON, "h-8 w-8")}
                      >
                        <X className="h-4 w-4" aria-hidden />
                      </button>
                    </div>
                  </div>
                  <div className="min-h-0 flex-1">{inspector}</div>
                </motion.aside>
              ) : null}
            </AnimatePresence>
          )}
        </div>
      </div>

      {mobile ? (
        <>
          <Sheet open={paletteOpen} onOpenChange={setPaletteOpen}>
            <SheetContent side="bottom" aria-describedby={undefined} className="h-[70dvh] rounded-t-[1.5rem] p-0">
              <SheetTitle className="sr-only">Add a step</SheetTitle>
              <NodePalette {...paletteProps} />
            </SheetContent>
          </Sheet>
          <Sheet open={inspectorOpen} onOpenChange={setInspectorOpen}>
            <SheetContent side="bottom" aria-describedby={undefined} className="h-[75dvh] rounded-t-[1.5rem] p-0">
              <SheetTitle className="sr-only">{selectedNode ? "Edit the step" : "Workflow settings"}</SheetTitle>
              <button
                type="button"
                onClick={() => setInspectorOpen(false)}
                aria-label="Close"
                className={cn(ICON_BUTTON, "absolute right-3 top-3 z-10 h-8 w-8")}
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
              {inspector}
            </SheetContent>
          </Sheet>
          <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
            <SheetContent side="bottom" aria-describedby={undefined} className="h-[75dvh] rounded-t-[1.5rem] p-0">
              <SheetTitle className="sr-only">Version history</SheetTitle>
              <button
                type="button"
                onClick={() => setHistoryOpen(false)}
                aria-label="Close"
                className={cn(ICON_BUTTON, "absolute right-3 top-3 z-10 h-8 w-8")}
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
              <div className="scrollbar-muted h-full min-h-0 overflow-y-auto overscroll-contain px-5 py-5">
                {historyBody}
              </div>
            </SheetContent>
          </Sheet>
        </>
      ) : null}

      <ConfirmDialog
        open={confirmRestore !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmRestore(null);
        }}
        title={`Restore version ${confirmRestore ?? ""}?`}
        description={
          <>
            Version {confirmRestore} is saved again as a new version{version !== null ? ` (version ${version + 1})` : ""}{" "}
            and opens here; new runs use it. Nothing is deleted — version {version ?? ""} stays in the history.
            {dirty ? (
              <span className="mt-2 block font-medium text-destructive">
                Your unsaved changes in the builder will be discarded.
              </span>
            ) : null}
          </>
        }
        confirmLabel={dirty ? "Discard changes and restore" : "Restore"}
        destructive={dirty}
        onConfirm={async () => {
          if (confirmRestore === null) return;
          await restoreVersion(confirmRestore);
        }}
      />

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete “${spec.name.trim() || "this workflow"}”?`}
        description="Its versions and its whole run history go with it. Live runs are cancelled. This can't be undone."
        confirmLabel="Delete workflow"
        onConfirm={deleteWorkflow}
      />

      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title="Clear the canvas?"
        description="Every step and connection is removed. Undo (Ctrl+Z) brings them back until you leave."
        confirmLabel="Clear canvas"
        onConfirm={clearCanvas}
      />

      <ConfirmDialog
        open={guard.pending}
        onOpenChange={(open) => {
          if (!open) guard.stay();
        }}
        title="Leave without saving?"
        description="Your changes stay on this device as a draft: open this workflow in the builder again to restore them."
        confirmLabel="Leave"
        cancelLabel="Keep editing"
        destructive={false}
        onConfirm={guard.leave}
      />
    </div>
  );
}

function CanvasLoading() {
  return (
    <div className="flex h-full items-center justify-center text-muted-foreground" aria-busy="true" aria-label="Loading the canvas">
      <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
    </div>
  );
}
