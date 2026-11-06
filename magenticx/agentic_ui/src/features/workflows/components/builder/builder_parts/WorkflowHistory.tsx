import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { AlertCircle, ChevronDown, Eye, EyeOff, History, Loader2, RotateCcw, X } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import { Skeleton } from "@/shared/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/select";
import { VersionGraphRail } from "@/shared/ui/version-graph-rail";
import { formatVersionTime, layoutVersionGraph, railWidth } from "@/shared/lib/versionHistory";
import type { WorkflowVersionSummary } from "@/shared/lib/types";
import type { WorkflowHistoryHandlers } from "@/features/workflows/hooks/useWorkflowHistory";
import { HISTORY_PANEL as PANEL, HISTORY_ROW_BUTTON as ROW_BUTTON } from "@/features/workflows/lib/consts";
import {
  compareWorkflowSpecs,
  isEmptyWorkflowComparison,
  isLayoutOnlyComparison,
  toGraphVersions,
  workflowVersionKindLabel,
  workflowVersionSummary,
} from "@/features/workflows/lib/workflowHistory";
import { WorkflowVersionChanges } from "./WorkflowVersionChanges";

/**
 * The workflow builder's History panel (the custom agent's History tab, for
 * workflows): every saved version newest first, on the version graph rail,
 * each row a one-line summary (how it came to be, when, its steps and
 * connections and how they moved). Opening a row shows what that version
 * changed against the one before it — or any other loaded version the user
 * picks — computed by diffing the two specs; from there, Preview shows it
 * read-only on the canvas and Restore makes it the newest version again.
 *
 * Restoring never rewrites history: the old spec is saved as a NEW version on
 * top. The confirmation (which warns about unsaved edits) belongs to the
 * builder, which also offers Restore from the preview banner.
 */
export function WorkflowHistory({
  history,
  workflowName,
  currentVersionNo,
  previewing,
  onPreview,
  onRequestRestore,
}: {
  history: WorkflowHistoryHandlers;
  workflowName: string;
  /** The newest version (what the builder last saved or loaded). */
  currentVersionNo: number | null;
  /** The version shown on the canvas read-only, if any. */
  previewing: number | null;
  onPreview: (versionNo: number | null) => void;
  onRequestRestore: (versionNo: number) => void;
}) {
  const reduceMotion = useReducedMotion();
  const { versions, error, reload, loading } = history;
  // One row open at a time, and none until the user asks — except the one
  // being previewed, which opens with it.
  const [opened, setOpened] = useState<number | null>(previewing);
  // The version the opened one is compared with; null means the one below it.
  const [against, setAgainst] = useState<number | null>(null);

  const openIndex = useMemo(
    () => (opened === null || !versions ? -1 : versions.findIndex((v) => v.versionNo === opened)),
    [versions, opened],
  );
  const selected = openIndex >= 0 && versions ? versions[openIndex] : null;
  const below = selected && versions ? (versions[openIndex + 1] ?? null) : null;
  const picked =
    against !== null && selected && against !== selected.versionNo
      ? (versions?.find((v) => v.versionNo === against) ?? null)
      : null;
  const previous = picked ?? below;
  const current =
    versions?.find((v) => v.versionNo === currentVersionNo) ?? versions?.[0] ?? null;
  const graph = useMemo(() => layoutVersionGraph(toGraphVersions(versions ?? [])), [versions]);
  // Row text starts after the rail: its left inset, its width and a gap.
  const indent = 12 + railWidth(graph.lanes) + 12;

  const { loadVersion } = history;
  useEffect(() => {
    if (selected) void loadVersion(selected.versionNo);
    if (previous) void loadVersion(previous.versionNo);
  }, [selected, previous, loadVersion]);

  if (!versions) {
    if (error) {
      return (
        <div className={cn(PANEL, "flex flex-col items-center px-6 py-10 text-center")}>
          <span className="mb-2 flex h-10 w-10 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
            <AlertCircle size={18} aria-hidden />
          </span>
          <p className="text-sm font-semibold text-foreground">Could not load the history</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">{error}</p>
          <button
            type="button"
            onClick={() => void reload()}
            disabled={loading}
            className={cn(ROW_BUTTON, "mt-4")}
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            Try again
          </button>
        </div>
      );
    }
    return <HistorySkeleton />;
  }

  if (versions.length === 0) {
    return (
      <div className={cn(PANEL, "flex flex-col items-center px-6 py-10 text-center")}>
        <span className="mb-2 flex h-10 w-10 items-center justify-center rounded-2xl bg-muted/50 text-muted-foreground">
          <History size={18} aria-hidden />
        </span>
        <p className="text-sm font-semibold text-foreground">No history yet</p>
        <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
          Every save of {workflowName} is kept here, so you can see what changed and go back to an
          earlier version.
        </p>
      </div>
    );
  }

  const failure = history.restoreFailure;

  return (
    <div className="space-y-3">
      {failure ? (
        <div className={cn(PANEL, "flex items-start gap-3 px-4 py-3")}>
          <AlertCircle size={16} className="mt-0.5 shrink-0 text-destructive" aria-hidden />
          <div className="min-w-0 flex-1" role="alert">
            <p className="text-sm font-medium text-foreground">
              Version {failure.versionNo} could not be restored
            </p>
            <p className="mt-0.5 text-sm text-muted-foreground">{failure.message}</p>
            {failure.issues.length ? (
              <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
                {failure.issues.map((issue) => (
                  <li key={issue} className="break-words [overflow-wrap:anywhere]">
                    {issue}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <button
            type="button"
            onClick={history.clearRestoreFailure}
            aria-label="Dismiss"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-[hsl(var(--hover-surface))] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
      ) : null}

      <div className={cn(PANEL, "p-1.5")}>
        <ol aria-label="Versions">
          {versions.map((version, index) => {
            const isOpen = version === selected;
            const isCurrent = version === current;
            const restoring = history.restoringVersion === version.versionNo;
            const isPreviewed = previewing === version.versionNo;
            return (
              <li
                key={version.versionNo}
                className={cn(
                  "relative rounded-2xl transition-[background-color,box-shadow] duration-150",
                  isOpen && "bg-background/80 shadow-sm ring-1 ring-border/60",
                )}
              >
                <VersionGraphRail row={graph.rows[index]} lanes={graph.lanes} current={isCurrent} />
                <VersionRow
                  version={version}
                  older={versions[index + 1] ?? null}
                  isCurrent={isCurrent}
                  isPreviewed={isPreviewed}
                  indent={indent}
                  open={isOpen}
                  onToggle={() => {
                    setOpened(isOpen ? null : version.versionNo);
                    setAgainst(null);
                    history.clearRestoreFailure();
                  }}
                />
                <AnimatePresence initial={false}>
                  {isOpen ? (
                    <motion.div
                      key="body"
                      id={`workflow-version-${version.versionNo}-body`}
                      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
                      animate={reduceMotion ? { opacity: 1 } : { opacity: 1, height: "auto" }}
                      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
                      transition={{ duration: 0.18, ease: "easeOut" }}
                      className="overflow-hidden"
                    >
                      <div className="space-y-4 pb-4 pr-3 pt-1" style={{ paddingLeft: indent }}>
                        {versions.length > 1 ? (
                          <CompareWith
                            versionNo={version.versionNo}
                            versions={versions}
                            currentVersionNo={current?.versionNo ?? null}
                            value={previous?.versionNo ?? null}
                            onChange={setAgainst}
                          />
                        ) : null}
                        <VersionBody
                          history={history}
                          workflowName={workflowName}
                          selected={version}
                          previous={previous}
                        />
                        <div className="flex flex-wrap justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => onPreview(isPreviewed ? null : version.versionNo)}
                            aria-pressed={isPreviewed}
                            className={cn(ROW_BUTTON, isPreviewed && "border-primary/40 bg-primary/[0.08] text-primary")}
                          >
                            {isPreviewed ? (
                              <EyeOff className="h-4 w-4" aria-hidden />
                            ) : (
                              <Eye className="h-4 w-4" aria-hidden />
                            )}
                            {isPreviewed ? "Stop preview" : "Preview"}
                          </button>
                          {!isCurrent ? (
                            <button
                              type="button"
                              onClick={() => onRequestRestore(version.versionNo)}
                              disabled={history.restoringVersion !== null}
                              aria-busy={restoring}
                              className={ROW_BUTTON}
                            >
                              {restoring ? (
                                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                              ) : (
                                <RotateCcw className="h-4 w-4" aria-hidden />
                              )}
                              Restore this version
                            </button>
                          ) : null}
                        </div>
                      </div>
                    </motion.div>
                  ) : null}
                </AnimatePresence>
              </li>
            );
          })}
        </ol>
        {history.hasMore ? (
          <div className="flex justify-center px-3 pb-2 pt-1">
            <button
              type="button"
              onClick={() => void history.loadMore()}
              disabled={history.loadingMore}
              className={ROW_BUTTON}
            >
              {history.loadingMore ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              Show older versions
            </button>
          </div>
        ) : null}
      </div>

      <p className="flex items-start gap-2 px-1 pt-1 text-xs text-muted-foreground">
        <History className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary/70" aria-hidden />
        Every save of {workflowName} is kept. Restoring one saves it again as a new version; nothing
        is deleted.
      </p>
    </div>
  );
}

/** Which loaded version the opened one is compared with; any of the others. */
function CompareWith({
  versionNo,
  versions,
  currentVersionNo,
  value,
  onChange,
}: {
  versionNo: number;
  versions: WorkflowVersionSummary[];
  currentVersionNo: number | null;
  value: number | null;
  onChange: (versionNo: number) => void;
}) {
  const id = `workflow-version-${versionNo}-compare`;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        Compare with
      </label>
      <Select value={value === null ? "" : String(value)} onValueChange={(next) => onChange(Number(next))}>
        <SelectTrigger
          id={id}
          className="h-8 w-auto min-w-[10rem] gap-2 rounded-full border-border/60 bg-background/80 px-3 text-xs"
        >
          <SelectValue placeholder="Choose a version" />
        </SelectTrigger>
        <SelectContent className="rounded-xl border border-border/60 bg-popover text-popover-foreground shadow-lg">
          {versions
            .filter((v) => v.versionNo !== versionNo)
            .map((v) => (
              <SelectItem key={v.versionNo} value={String(v.versionNo)} className="rounded-lg">
                <span className="flex items-baseline gap-2">
                  <span className="font-medium">Version {v.versionNo}</span>
                  <span className="text-xs text-muted-foreground">
                    {v.versionNo === currentVersionNo ? "Current" : workflowVersionKindLabel(v)}
                  </span>
                </span>
              </SelectItem>
            ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function VersionRow({
  version,
  older,
  isCurrent,
  isPreviewed,
  indent,
  open,
  onToggle,
}: {
  version: WorkflowVersionSummary;
  older: WorkflowVersionSummary | null;
  isCurrent: boolean;
  isPreviewed: boolean;
  /** Where the text starts, past the graph rail. */
  indent: number;
  open: boolean;
  onToggle: () => void;
}) {
  const when = formatVersionTime(version.createdAt);
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={`workflow-version-${version.versionNo}-body`}
      aria-current={isCurrent ? "true" : undefined}
      className={cn(
        "group flex w-full items-start gap-3 rounded-2xl py-2.5 pr-3 text-left transition-colors duration-150",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
        !open && "hover:bg-[hsl(var(--hover-surface))]",
      )}
      style={{ paddingLeft: indent }}
    >
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-sm font-semibold text-foreground">Version {version.versionNo}</span>
          {isCurrent ? (
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
              Current
            </span>
          ) : null}
          {isPreviewed ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-foreground">
              <Eye className="h-3 w-3" aria-hidden />
              Previewing
            </span>
          ) : null}
        </span>
        <span className="mt-0.5 block text-xs text-muted-foreground">
          {workflowVersionKindLabel(version)}
          {when ? ` · ${when}` : ""}
        </span>
        <span className="mt-0.5 block truncate text-sm text-muted-foreground">
          {version.name ? <span className="text-foreground/90">{version.name} · </span> : null}
          {workflowVersionSummary(version, older)}
        </span>
      </span>
      <span className="mt-0.5 flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground transition-colors group-hover:text-foreground">
        <ChevronDown
          className={cn("h-4 w-4 transition-transform duration-150", open && "rotate-180")}
          aria-hidden
        />
      </span>
    </button>
  );
}

/** What the selected version changed, or why there is nothing to compare it with. */
function VersionBody({
  history,
  workflowName,
  selected,
  previous,
}: {
  history: WorkflowHistoryHandlers;
  workflowName: string;
  selected: WorkflowVersionSummary;
  previous: WorkflowVersionSummary | null;
}) {
  const mine = history.details[selected.versionNo];
  const other = previous ? history.details[previous.versionNo] : undefined;
  // Older on the left, newer on the right, whichever of the two was opened.
  const otherIsOlder = !previous || previous.versionNo < selected.versionNo;
  const comparison = useMemo(() => {
    if (!mine || !other) return null;
    return otherIsOlder
      ? compareWorkflowSpecs(other.spec, mine.spec)
      : compareWorkflowSpecs(mine.spec, other.spec);
  }, [mine, other, otherIsOlder]);

  if (!previous) {
    return (
      <p className="text-sm text-muted-foreground">
        {selected.versionNo === 1
          ? `The first version of ${workflowName}, as it was created. There is nothing earlier to compare it with.`
          : "Show older versions to compare this one with the version before it."}
      </p>
    );
  }

  const needed = [selected.versionNo, previous.versionNo];
  const failed = needed.filter((no) => !history.details[no] && history.failedVersions.has(no));
  if (failed.length) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm text-muted-foreground">Could not load this version&apos;s changes.</p>
        <button
          type="button"
          onClick={() => failed.forEach((no) => void history.loadVersion(no))}
          className={ROW_BUTTON}
        >
          Try again
        </button>
      </div>
    );
  }

  if (!comparison) {
    return (
      <div className="space-y-2.5" aria-busy="true" aria-label="Loading changes">
        <Skeleton className="h-4 w-1/3 bg-muted/70" />
        <Skeleton className="h-16 w-full rounded-2xl bg-muted/60" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {otherIsOlder
          ? `Changes since version ${previous.versionNo}.`
          : `Changes from this version to version ${previous.versionNo}.`}
      </p>
      {isEmptyWorkflowComparison(comparison) ? (
        <p className="text-sm text-muted-foreground">
          Nothing in the workflow differs from version {previous.versionNo}.
        </p>
      ) : (
        <>
          {isLayoutOnlyComparison(comparison) ? (
            <p className="text-sm text-muted-foreground">
              Only the layout changed — the workflow runs the same as version {previous.versionNo}.
            </p>
          ) : null}
          <WorkflowVersionChanges comparison={comparison} />
        </>
      )}
    </div>
  );
}

function HistorySkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading history">
      <div className={cn(PANEL, "space-y-1 p-1.5")}>
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex gap-3 px-3 py-2.5">
            <Skeleton className="mt-1.5 h-2.5 w-2.5 rounded-full bg-muted/70" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-4 w-40 bg-muted/70" />
              <Skeleton className="h-3 w-56 bg-muted/60" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
