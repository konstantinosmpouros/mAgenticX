import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ArrowLeft, ChevronUp, Code2, History, Loader2, X } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import { mapIcon } from "@/shared/lib/consts";
import { setAgentToolApprovals } from "@/shared/lib/api";
import { toastError } from "@/shared/lib/toast";
import { useToast } from "@/shared/hooks/use-toast";
import { useIsMobile } from "@/shared/hooks/use-mobile";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { SidebarTrigger } from "@/shared/ui/sidebar";
import type { Agent, AgentDraft, AgentToolRow, UserSkill } from "@/shared/lib/types";
import type { UserAgentsHandlers } from "@/features/agents/hooks/useUserAgents";
import type { AgentCatalogs } from "@/features/agents/hooks/useAgentCatalogs";
import { depthOf, ensureUids, locate, useAgentDraft } from "@/features/agents/hooks/useAgentDraft";
import { useDraftAutosave } from "@/features/agents/hooks/useDraftAutosave";
import { useLeaveGuard } from "@/features/agents/hooks/useLeaveGuard";
import { useServerValidation } from "@/features/agents/hooks/useServerValidation";
import {
  buildAgentPayload,
  emptyDraft,
  modelLabel as labelOf,
  newUid,
  slugify,
} from "@/features/agents/lib/agentSpec";
import { canAddChild, checkDraft } from "@/features/agents/lib/agentRules";
import {
  ROOT_UID,
  countByNode,
  fieldId,
  mergeIssues,
  placeIssues,
  type IssueField,
  type PlacedIssue,
} from "@/features/agents/lib/agentIssues";
import {
  approvalChanges,
  approvalRows as buildApprovalRows,
} from "@/features/agents/lib/agentApprovals";
import { formatSavedAt } from "@/features/agents/lib/draftStorage";
import type { BuilderSection } from "@/features/agents/lib/routes";
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from "@/features/agents/lib/styles";
import { BuilderContext, type BuilderContextValue } from "./builderContext";
import { Inspector } from "./inspector/Inspector";
import { IssuesMenu } from "./IssuesMenu";
import { YamlPanel } from "./YamlPanel";

// The canvas brings React Flow along: its own chunk, fetched when the builder opens.
const loadBuilderCanvas = () => import("./canvas/BuilderCanvas");
const BuilderCanvas = React.lazy(loadBuilderCanvas);

export type BuilderSaved = { agentId: string; created: boolean };

/**
 * The agent builder: a canvas of the agent and its team, the inspector for the
 * picked node, and the bar on top (the name, unsaved state, issues, YAML, Save).
 *
 * It owns the draft (`useAgentDraft`) and everything that watches it: the
 * builder's own checks on every change, the server's ~800 ms later, the
 * autosave and the leave guard. Save is: check, validate, create or update,
 * then the approval choices in one batch — and if that last step fails the
 * agent exists already, so the page stays on Approvals with Retry.
 */
export function BuilderWorkspace({
  mode,
  agentId,
  initialDraft,
  initialServerIssues = [],
  unsaved = false,
  offerRestore = true,
  userId,
  agents,
  mySkills,
  userAgents,
  catalogs,
  liveRows,
  section,
  onSection,
  backLabel,
  onExit,
  onSaved,
  onDownloadZip,
  downloading = false,
}: {
  mode: "create" | "edit";
  /** The agent being edited; null when creating. */
  agentId: string | null;
  initialDraft: AgentDraft;
  /** Issues already known for the initial draft (an import's), placed on its nodes. */
  initialServerIssues?: PlacedIssue[];
  /** The initial draft is itself unsaved work (an imported YAML): guard and autosave it. */
  unsaved?: boolean;
  /** Offer a draft an earlier visit left behind (not when opening an import). */
  offerRestore?: boolean;
  userId: string | null;
  agents: Agent[];
  mySkills: UserSkill[];
  userAgents: UserAgentsHandlers;
  catalogs: AgentCatalogs;
  liveRows: AgentToolRow[] | null;
  section: BuilderSection;
  onSection: (section: BuilderSection) => void;
  backLabel: string;
  onExit: () => void;
  onSaved: (saved: BuilderSaved) => void;
  onDownloadZip: (() => void) | null;
  downloading?: boolean;
}) {
  const { toast } = useToast();
  const mobile = useIsMobile();
  const reduceMotion = useReducedMotion();
  const [savedAs] = React.useState(() => (unsaved ? emptyDraft(initialDraft.model) : initialDraft));
  const { draft, dispatch, dirty, reset, markSaved } = useAgentDraft(initialDraft, savedAs);
  const [selectedUid, setSelectedUid] = React.useState(ROOT_UID);
  const [reveal, setReveal] = React.useState<{ uid: string; at: number } | null>(null);
  const [touched, setTouched] = React.useState<ReadonlySet<string>>(() => new Set());
  const [attempted, setAttempted] = React.useState(false);
  const [yamlOpen, setYamlOpen] = React.useState(false);
  const [openFile, setOpenFile] = React.useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState<"checking" | "saving" | "approvals" | null>(null);
  const [approvalsFailed, setApprovalsFailed] = React.useState(false);
  const [sheetOpen, setSheetOpen] = React.useState(false);
  // Once created, every later save (a Retry, a further edit) is an update.
  const savedRef = React.useRef<{ id: string; created: boolean } | null>(
    agentId ? { id: agentId, created: false } : null,
  );
  const inspectorRef = React.useRef<HTMLDivElement>(null);

  const modelLabel = React.useCallback(
    (id: string) => labelOf(id, catalogs.models),
    [catalogs.models],
  );
  const payload = React.useMemo(() => buildAgentPayload(draft), [draft]);

  // ---- issues --------------------------------------------------------------
  const takenSlugs = React.useMemo(
    () =>
      new Set(
        agents.filter((a) => a.kind === "custom" && a.id !== agentId).map((a) => slugify(a.name)),
      ),
    [agents, agentId],
  );
  const skillPool = React.useMemo(
    () => (mySkills.length ? new Set(mySkills.map((s) => s.name)) : null),
    [mySkills],
  );
  const clientIssues = React.useMemo(
    () =>
      placeIssues(
        checkDraft(draft, {
          mode: savedRef.current?.created ? "edit" : mode,
          takenSlugs,
          skillPool,
        }),
        draft,
      ),
    [draft, mode, takenSlugs, skillPool],
  );
  // The server checks on Create / Save only; between saves the builder's own rules run live.
  const server = useServerValidation({ userId, draft, payload });
  // An import's issues stand until the server's own first answer replaces them.
  const serverIssues = server.checked ? server.issues : initialServerIssues;
  const allIssues = React.useMemo(
    () => mergeIssues(clientIssues, serverIssues),
    [clientIssues, serverIssues],
  );
  // "Still empty" shows once the field was left or a save was tried.
  const visibleIssues = React.useMemo(
    () =>
      allIssues.filter(
        (item) =>
          !item.required || attempted || touched.has(`${item.target.uid}:${item.target.field}`),
      ),
    [allIssues, attempted, touched],
  );
  const issueCounts = React.useMemo(() => countByNode(visibleIssues), [visibleIssues]);
  const errorNodes = React.useMemo(
    () => new Set(visibleIssues.filter((i) => i.severity === "error").map((i) => i.target.uid)),
    [visibleIssues],
  );
  const issuesFor = React.useCallback(
    (uid: string, field: IssueField) =>
      visibleIssues.filter((item) => item.target.uid === uid && item.target.field === field),
    [visibleIssues],
  );
  const touch = React.useCallback((uid: string, field: IssueField) => {
    setTouched((prev) => {
      const key = `${uid}:${field}`;
      if (prev.has(key)) return prev;
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  }, []);

  const approvalRows = React.useMemo(
    () =>
      buildApprovalRows({ draft, builtins: catalogs.builtins, catalog: catalogs.tools, liveRows }),
    [draft, catalogs.builtins, catalogs.tools, liveRows],
  );

  // ---- autosave and leaving ------------------------------------------------
  const autosave = useDraftAutosave({
    userId,
    agentId,
    draft,
    dirty,
    initial: savedAs,
    offerStored: offerRestore,
  });
  const guard = useLeaveGuard(dirty && saving === null);
  const leave = () => guard.confirmLeave(onExit);

  // ---- selection and the tree ----------------------------------------------
  const focusField = React.useCallback(
    (uid: string, field: IssueField) => {
      // After the inspector has rendered the node (and its tab, and the motion).
      window.setTimeout(
        () => {
          const element = document.getElementById(fieldId(uid, field));
          element?.focus({ preventScroll: false });
          element?.scrollIntoView?.({
            block: "center",
            behavior: reduceMotion ? "auto" : "smooth",
          });
        },
        reduceMotion ? 30 : 230,
      );
    },
    [reduceMotion],
  );

  const select = React.useCallback((uid: string) => {
    setSelectedUid(uid);
    setSheetOpen(true);
  }, []);

  const addChild = React.useCallback(
    (parentUid: string) => {
      if (!canAddChild(depthOf(draft, parentUid))) return;
      const uid = newUid();
      dispatch({ type: "add-child", parentUid, uid });
      setSelectedUid(uid);
      setSheetOpen(true);
      if (!mobile) focusField(uid, "name");
    },
    [draft, dispatch, focusField, mobile],
  );

  const duplicate = React.useCallback(
    (uid: string) => {
      const copy = newUid();
      dispatch({ type: "duplicate-node", uid, newUid: copy });
      setSelectedUid(copy);
    },
    [dispatch],
  );

  const removeNode = React.useCallback(
    (uid: string) => {
      const parent = locate(draft, uid)?.ancestors.slice(-1)[0] ?? ROOT_UID;
      dispatch({ type: "remove-node", uid });
      setSelectedUid((current) => {
        if (current === uid) return parent;
        // A node inside the removed branch goes with it.
        return locate(draft, current)?.ancestors.includes(uid) ? parent : current;
      });
    },
    [draft, dispatch],
  );

  const requestDelete = React.useCallback(
    (uid: string, options: { keyboard: boolean } = { keyboard: false }) => {
      const node = locate(draft, uid)?.node;
      if (!node) return;
      if (node.subagents.length || options.keyboard) setPendingDelete(uid);
      else removeNode(uid);
    },
    [draft, removeNode],
  );

  const activate = React.useCallback(() => {
    window.setTimeout(() => {
      const body = inspectorRef.current?.querySelector<HTMLElement>("[data-inspector-body]");
      body?.querySelector<HTMLElement>("input, textarea, [role=combobox], button")?.focus();
    }, 40);
  }, []);

  const goToIssue = React.useCallback(
    (item: PlacedIssue) => {
      setSelectedUid(item.target.uid);
      setSheetOpen(true);
      if (item.target.uid === ROOT_UID && item.target.section) onSection(item.target.section);
      if (item.target.file) setOpenFile(item.target.file);
      setReveal({ uid: item.target.uid, at: Date.now() });
      focusField(item.target.uid, item.target.field);
    },
    [focusField, onSection],
  );

  const nodeName = React.useCallback(
    (uid: string) =>
      uid === ROOT_UID
        ? draft.name.trim() || "Untitled agent"
        : locate(draft, uid)?.node.name.trim() || "Unnamed sub-agent",
    [draft],
  );

  // ---- save ----------------------------------------------------------------
  const applyApprovals = React.useCallback(
    async (id: string): Promise<boolean> => {
      const changes = approvalChanges(approvalRows);
      if (!Object.keys(changes).length || !userId) return true;
      try {
        await setAgentToolApprovals(userId, id, changes);
        return true;
      } catch (error) {
        toastError(toast, "The approval choices weren't saved", error, {
          description: "The agent is saved. Retry from Approvals.",
        });
        return false;
      }
    },
    [approvalRows, userId, toast],
  );

  const finish = React.useCallback(
    (id: string, created: boolean) => {
      autosave.clear();
      onSaved({ agentId: id, created });
    },
    [autosave, onSaved],
  );

  const save = async () => {
    if (saving) return;
    setAttempted(true);
    const blocking = allIssues.find(
      (item) => item.source === "client" && item.severity === "error",
    );
    if (blocking) {
      goToIssue(blocking);
      return;
    }
    setSaving("checking");
    const checked = await server.validateNow();
    if (checked && !checked.valid) {
      setSaving(null);
      const first = checked.issues.find((item) => item.severity === "error");
      if (first) goToIssue(first);
      return;
    }
    setSaving("saving");
    const existing = savedRef.current;
    const agent = existing
      ? await userAgents.updateAgent(existing.id, payload, { quiet: true })
      : await userAgents.createAgent(payload, { quiet: true });
    if (!agent) {
      setSaving(null);
      return;
    }
    const created = existing ? existing.created : mode === "create";
    savedRef.current = { id: agent.id, created };
    markSaved();
    setSaving("approvals");
    const ok = await applyApprovals(agent.id);
    setSaving(null);
    if (!ok) {
      setApprovalsFailed(true);
      setSelectedUid(ROOT_UID);
      onSection("approvals");
      return;
    }
    finish(agent.id, created);
  };

  const retryApprovals = async () => {
    const saved = savedRef.current;
    if (!saved || saving) return;
    setSaving("approvals");
    const ok = await applyApprovals(saved.id);
    setSaving(null);
    if (ok) {
      setApprovalsFailed(false);
      finish(saved.id, saved.created);
    }
  };

  const confirmDelete = pendingDelete ? locate(draft, pendingDelete) : null;
  const countBelow = (uid: string): number => {
    const node = locate(draft, uid)?.node;
    const walk = (list: typeof draft.subagents): number =>
      list.reduce((sum, child) => sum + 1 + walk(child.subagents ?? []), 0);
    return node ? walk(node.subagents) : 0;
  };

  const context: BuilderContextValue = {
    draft,
    dispatch,
    mode: savedRef.current?.created ? "edit" : mode,
    catalogs,
    mySkills,
    liveRows,
    approvalRows,
    issuesFor,
    touch,
    modelLabel,
    select,
    addChild,
    duplicate,
    requestDelete: (uid) => requestDelete(uid),
    openFile,
    setOpenFile,
  };

  const Glyph = mapIcon(draft.icon || "Bot");
  const busyLabel =
    saving === "checking"
      ? "Checking…"
      : saving === "saving"
        ? "Saving…"
        : saving === "approvals"
          ? "Saving choices…"
          : null;
  const isNew = mode === "create" && !savedRef.current;

  return (
    <BuilderContext.Provider value={context}>
      <div className="flex h-full min-h-0 flex-col">
        {/* ---- top bar ---- */}
        <header className="relative z-10 flex flex-shrink-0 items-center gap-2 border-b border-border/50 bg-background/80 px-3 py-2.5 backdrop-blur sm:gap-3 sm:px-4">
          <SidebarTrigger
            aria-label="Toggle sidebar"
            className="inline-flex h-9 w-9 flex-shrink-0 rounded-xl bg-transparent text-foreground hover:bg-[hsl(var(--hover-surface))] md:hidden [&_svg]:size-5"
          />
          <button
            type="button"
            onClick={leave}
            className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-[hsl(var(--hover-surface))] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
            <span className="sr-only max-w-[10rem] truncate sm:not-sr-only">{backLabel}</span>
          </button>
          <span className="hidden h-5 w-px flex-shrink-0 bg-border/70 sm:block" aria-hidden />
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <span className="hidden h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl bg-primary/[0.12] text-primary sm:flex">
              <Glyph className="h-4 w-4" aria-hidden />
            </span>
            <input
              value={draft.name}
              onChange={(event) =>
                dispatch({
                  type: "set-name",
                  value: event.target.value,
                  followSlug: isNew && (!draft.slug || draft.slug === slugify(draft.name)),
                })
              }
              onBlur={() => touch(ROOT_UID, "name")}
              placeholder="Untitled agent"
              aria-label="Agent name"
              maxLength={120}
              className="min-w-0 flex-1 truncate rounded-lg border border-transparent bg-transparent px-1.5 py-1 text-[15px] font-semibold tracking-tight text-foreground transition-colors placeholder:font-medium placeholder:text-muted-foreground/70 hover:border-border/60 focus-visible:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20 sm:max-w-[22rem]"
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
          <IssuesMenu issues={visibleIssues} nodeName={nodeName} onPick={goToIssue} />
          <button
            type="button"
            onClick={() => setYamlOpen((open) => !open)}
            aria-pressed={yamlOpen}
            className={cn(
              SECONDARY_BUTTON,
              "px-3 py-1.5 text-xs",
              yamlOpen && "border-primary/40 text-primary",
            )}
          >
            <Code2 className="h-3.5 w-3.5" aria-hidden />
            <span className="hidden sm:inline">YAML</span>
            <span className="sr-only sm:hidden">YAML view</span>
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving !== null}
            className={cn(PRIMARY_BUTTON, "px-3.5 py-1.5 text-[13px]")}
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
            {busyLabel ?? (isNew ? "Create" : "Save")}
          </button>
        </header>

        {/* ---- restore banner ---- */}
        <AnimatePresence initial={false}>
          {autosave.offer ? (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: reduceMotion ? 0 : 0.22, ease: "easeOut" }}
              className="flex-shrink-0 overflow-hidden border-b border-primary/20 bg-primary/[0.06]"
              role="status"
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
                <History className="h-4 w-4 flex-shrink-0 text-primary" aria-hidden />
                <p className="min-w-0 flex-1 text-[13px] text-foreground">
                  Restore unsaved changes from {formatSavedAt(autosave.offer.savedAt)}?
                </p>
                <button
                  type="button"
                  className={cn(PRIMARY_BUTTON, "px-3 py-1 text-xs")}
                  onClick={() => {
                    const stored = autosave.offer;
                    if (!stored) return;
                    reset(ensureUids(stored.draft), { clean: false });
                    setSelectedUid(ROOT_UID);
                    autosave.dismiss({ discard: false });
                  }}
                >
                  Restore
                </button>
                <button
                  type="button"
                  className={cn(SECONDARY_BUTTON, "px-3 py-1 text-xs")}
                  onClick={() => autosave.dismiss({ discard: true })}
                >
                  Discard
                </button>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>

        {/* ---- canvas + inspector ---- */}
        <div className="relative flex min-h-0 flex-1 flex-col md:flex-row">
          <div
            className={cn(
              "relative min-h-0 min-w-0 flex-1 bg-[radial-gradient(ellipse_at_top,hsl(var(--primary)/0.05),transparent_60%)]",
            )}
          >
            <React.Suspense fallback={<CanvasLoading />}>
              <BuilderCanvas
                draft={draft}
                selectedUid={selectedUid}
                modelLabel={modelLabel}
                issueCounts={issueCounts}
                errorNodes={errorNodes}
                onSelect={select}
                onAddChild={addChild}
                onDuplicate={duplicate}
                onDelete={requestDelete}
                onActivate={activate}
                reveal={reveal}
                refit={mobile ? String(sheetOpen) : null}
              />
            </React.Suspense>
          </div>
          <aside
            className={cn(
              "flex min-h-0 flex-shrink-0 flex-col",
              mobile
                ? cn(
                    // A bottom sheet below the canvas, which keeps the rest.
                    "relative z-20 -mt-5 rounded-t-[1.5rem] border-t border-border/60 bg-card shadow-[0_-18px_40px_-24px_hsl(var(--foreground)/0.45)] transition-[height] duration-300 ease-out motion-reduce:transition-none",
                    sheetOpen ? "h-[62%]" : "h-[4.25rem]",
                  )
                : "w-[400px] border-l border-border/50 bg-card/60 xl:w-[420px]",
            )}
            aria-label="Edit the selected agent"
          >
            {mobile ? (
              <button
                type="button"
                onClick={() => setSheetOpen((open) => !open)}
                aria-expanded={sheetOpen}
                className="flex flex-shrink-0 flex-col items-center gap-1 pb-1 pt-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/60"
              >
                <span className="h-1 w-10 rounded-full bg-muted-foreground/25" aria-hidden />
                <span className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
                  {sheetOpen ? (
                    <X className="h-3 w-3" aria-hidden />
                  ) : (
                    <ChevronUp className="h-3 w-3" aria-hidden />
                  )}
                  {sheetOpen ? "Hide details" : `Edit ${nodeName(selectedUid)}`}
                </span>
              </button>
            ) : null}
            <div className={cn("min-h-0 flex-1", mobile && !sheetOpen && "hidden")}>
              <Inspector
                ref={inspectorRef}
                selectedUid={selectedUid}
                section={section}
                onSection={onSection}
                issues={visibleIssues}
                approvalsFailed={approvalsFailed}
                retryingApprovals={saving === "approvals"}
                onRetryApprovals={() => void retryApprovals()}
              />
            </div>
          </aside>
        </div>
      </div>

      <YamlPanel
        open={yamlOpen}
        onOpenChange={setYamlOpen}
        userId={userId}
        payload={payload}
        models={catalogs.models}
        builtins={catalogs.builtins}
        onDownloadZip={agentId || savedRef.current ? onDownloadZip : null}
        downloading={downloading}
        dirty={dirty}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title={`Delete ${confirmDelete?.node.name ? `“${confirmDelete.node.name}”` : "this sub-agent"}?`}
        description={
          pendingDelete && countBelow(pendingDelete)
            ? `Its team goes with it: ${countBelow(pendingDelete)} sub-agent${countBelow(pendingDelete) === 1 ? "" : "s"} below it, and their instructions.`
            : "Its instructions go with it."
        }
        confirmLabel="Delete"
        onConfirm={() => {
          if (pendingDelete) removeNode(pendingDelete);
          setPendingDelete(null);
        }}
      />

      <ConfirmDialog
        open={guard.pending}
        onOpenChange={(open) => {
          if (!open) guard.stay();
        }}
        title="Leave without saving?"
        description="Your changes stay on this device as a draft: open the builder again to restore them."
        confirmLabel="Leave"
        cancelLabel="Keep editing"
        destructive={false}
        onConfirm={guard.leave}
      />
    </BuilderContext.Provider>
  );
}

function CanvasLoading() {
  return (
    <div
      className="flex h-full items-center justify-center text-muted-foreground"
      aria-busy="true"
      aria-label="Loading the canvas"
    >
      <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
    </div>
  );
}
