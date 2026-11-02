import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { AlertCircle, ChevronDown, History, Loader2, Pencil, RotateCcw, X } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import { Skeleton } from "@/shared/ui/skeleton";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import type { AgentVersionSummary } from "@/shared/lib/types";
import type { AgentHistoryHandlers } from "@/features/agents/hooks/useAgentHistory";
import {
  compareVersions,
  currentVersion,
  formatVersionTime,
  isEmptyComparison,
  versionKindLabel,
  versionSummary,
} from "@/features/agents/lib/agentHistory";
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from "@/features/agents/lib/styles";
import { SoftPanel } from "@/features/settings/components/profile_parts/shared";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/select";
import { layoutVersionGraph } from "@/features/agents/lib/versionGraph";
import { VersionChanges } from "./VersionChanges";
import { VersionGraphRail, railWidth } from "./VersionGraphRail";

/**
 * The agent page's History section (your own agents only): every save kept as
 * a version, newest first, as a graph of one-line summaries: each version is
 * joined to the one it was saved on top of, so two edits of one version show
 * as two branches meeting at it. Opening
 * a row shows what that version changed compared with the one before it — or
 * with any other kept version the user picks — and a way back to it; nothing
 * is compared until a row is opened.
 *
 * The page owns the data (`useAgentHistory`) because the Overview's "Version"
 * row reads the same list. Restoring adds no version and deletes none: the
 * chosen version becomes the current one again, so restoring the version that
 * was current undoes it.
 */
export function AgentHistory({
  history,
  agentName,
  onEdit,
}: {
  history: AgentHistoryHandlers;
  agentName: string;
  onEdit: () => void;
}) {
  const reduceMotion = useReducedMotion();
  const { versions, error, reload, loading } = history;
  // One row open at a time, and none until the user asks.
  const [opened, setOpened] = useState<number | null>(null);
  // The version the opened one is compared with; null means the one before it.
  const [against, setAgainst] = useState<number | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);

  const openIndex = useMemo(
    () => (opened === null || !versions ? -1 : versions.findIndex((v) => v.versionNo === opened)),
    [versions, opened],
  );
  const selected = openIndex >= 0 && versions ? versions[openIndex] : null;
  // By default a version is compared with the one it was saved on top of,
  // which after a restore is not the one listed below it.
  const base =
    selected?.basedOn != null && selected.basedOn !== selected.versionNo
      ? (versions?.find((v) => v.versionNo === selected.basedOn) ?? null)
      : null;
  const before = base ?? (selected && versions ? (versions[openIndex + 1] ?? null) : null);
  // The picked version while it is still kept (and not the opened one itself).
  const picked =
    against !== null && selected && against !== selected.versionNo
      ? (versions?.find((v) => v.versionNo === against) ?? null)
      : null;
  const previous = picked ?? before;
  const current = currentVersion(versions);
  const graph = useMemo(() => layoutVersionGraph(versions ?? []), [versions]);
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
        <SoftPanel className="flex flex-col items-center px-6 py-10 text-center">
          <span className="mb-2 flex h-10 w-10 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
            <AlertCircle size={18} aria-hidden />
          </span>
          <p className="text-sm font-semibold text-foreground">Could not load the history</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">{error}</p>
          <button
            type="button"
            onClick={() => void reload()}
            disabled={loading}
            className={cn(SECONDARY_BUTTON, "mt-4")}
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            Try again
          </button>
        </SoftPanel>
      );
    }
    return <HistorySkeleton />;
  }

  if (versions.length === 0) {
    return (
      <SoftPanel className="flex flex-col items-center px-6 py-10 text-center">
        <span className="mb-2 flex h-10 w-10 items-center justify-center rounded-2xl bg-muted/50 text-muted-foreground">
          <History size={18} aria-hidden />
        </span>
        <p className="text-sm font-semibold text-foreground">No history yet</p>
        <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
          History starts with the next save. From then on every save of {agentName} is kept here, so
          you can see what changed and go back to an earlier version.
        </p>
        <button type="button" onClick={onEdit} className={cn(PRIMARY_BUTTON, "mt-4")}>
          <Pencil className="h-4 w-4" aria-hidden /> Edit agent
        </button>
      </SoftPanel>
    );
  }

  const failure = history.restoreFailure;
  const confirmingCurrent = current?.versionNo ?? 0;

  return (
    <div className="space-y-3">
      {failure ? (
        <SoftPanel className="flex items-start gap-3 px-4 py-3">
          <AlertCircle size={16} className="mt-0.5 shrink-0 text-destructive" aria-hidden />
          <div className="min-w-0 flex-1" role="alert">
            <p className="text-sm font-medium text-foreground">
              Version {failure.versionNo} could not be restored
            </p>
            <p className="mt-0.5 text-sm text-muted-foreground">{failure.message}</p>
            {failure.issues.length ? (
              <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
                {failure.issues.map((issue) => (
                  <li key={issue}>{issue}</li>
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
        </SoftPanel>
      ) : null}

      <SoftPanel className="p-1.5">
        <ol aria-label="Versions">
          {versions.map((version, index) => {
            const isOpen = version === selected;
            const restoring = history.restoringVersion === version.versionNo;
            return (
              <li
                key={version.versionNo}
                className={cn(
                  "relative rounded-2xl transition-[background-color,box-shadow] duration-150",
                  isOpen && "bg-background/80 shadow-sm ring-1 ring-border/60",
                )}
              >
                <VersionGraphRail
                  row={graph.rows[index]}
                  lanes={graph.lanes}
                  current={version === current}
                />
                <VersionRow
                  version={version}
                  isCurrent={version === current}
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
                      id={`version-${version.versionNo}-body`}
                      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
                      animate={reduceMotion ? { opacity: 1 } : { opacity: 1, height: "auto" }}
                      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
                      transition={{ duration: 0.18, ease: "easeOut" }}
                      className="overflow-hidden"
                    >
                      <div className="space-y-4 pb-4 pr-3 pt-1 sm:pr-4" style={{ paddingLeft: indent }}>
                        {versions.length > 1 ? (
                          <CompareWith
                            versionNo={version.versionNo}
                            versions={versions}
                            value={previous?.versionNo ?? null}
                            onChange={setAgainst}
                          />
                        ) : null}
                        <VersionBody
                          history={history}
                          agentName={agentName}
                          selected={version}
                          previous={previous}
                        />
                        {version !== current ? (
                          <div className="flex justify-end">
                            <button
                              type="button"
                              onClick={() => setConfirming(version.versionNo)}
                              disabled={history.restoringVersion !== null}
                              aria-busy={restoring}
                              className={SECONDARY_BUTTON}
                            >
                              {restoring ? (
                                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                              ) : (
                                <RotateCcw className="h-4 w-4" aria-hidden />
                              )}
                              Restore this version
                            </button>
                          </div>
                        ) : null}
                      </div>
                    </motion.div>
                  ) : null}
                </AnimatePresence>
              </li>
            );
          })}
        </ol>
      </SoftPanel>

      <p className="flex items-center gap-2 px-1 pt-1 text-xs text-muted-foreground">
        <History className="h-3.5 w-3.5 shrink-0 text-primary/70" aria-hidden />
        The last 20 saves of {agentName} are kept. Restoring one makes it current again without
        adding or deleting a version.
      </p>

      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        title={`Restore version ${confirming ?? ""}?`}
        description={
          <>
            {agentName} goes back to how it was in version {confirming}. No version is added or
            deleted — version {confirmingCurrent} stays in the history, so restore it to undo
            this.
          </>
        }
        confirmLabel="Restore"
        destructive={false}
        onConfirm={async () => {
          if (confirming === null) return;
          const restored = await history.restore(confirming);
          if (restored) setOpened(null);
        }}
      />
    </div>
  );
}

/** Which kept version the opened one is compared with; any of the others. */
function CompareWith({
  versionNo,
  versions,
  value,
  onChange,
}: {
  versionNo: number;
  versions: AgentVersionSummary[];
  value: number | null;
  onChange: (versionNo: number) => void;
}) {
  const id = `version-${versionNo}-compare`;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        Compare with
      </label>
      <Select
        value={value === null ? "" : String(value)}
        onValueChange={(next) => onChange(Number(next))}
      >
        <SelectTrigger
          id={id}
          className="h-8 w-auto min-w-[11rem] gap-2 rounded-full border-border/60 bg-background/80 px-3 text-xs"
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
                    {v === currentVersion(versions) ? "Current" : versionKindLabel(v)}
                  </span>
                </span>
              </SelectItem>
            ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function CurrentBadge() {
  return (
    <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
      Current
    </span>
  );
}

function VersionRow({
  version,
  isCurrent,
  indent,
  open,
  onToggle,
}: {
  version: AgentVersionSummary;
  isCurrent: boolean;
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
      aria-controls={`version-${version.versionNo}-body`}
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
          {isCurrent ? <CurrentBadge /> : null}
          <span className="text-xs text-muted-foreground">
            {versionKindLabel(version)}
            {when ? ` · ${when}` : ""}
          </span>
        </span>
        <span className="mt-0.5 block text-sm text-muted-foreground">{versionSummary(version)}</span>
      </span>
      <span className="mt-0.5 flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground transition-colors group-hover:text-foreground">
        <span className="hidden sm:inline">{open ? "Hide" : "View"}</span>
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
  agentName,
  selected,
  previous,
}: {
  history: AgentHistoryHandlers;
  agentName: string;
  selected: AgentVersionSummary;
  previous: AgentVersionSummary | null;
}) {
  const mine = history.details[selected.versionNo];
  const other = previous ? history.details[previous.versionNo] : undefined;
  // Older on the left, newer on the right, whichever of the two was opened.
  const otherIsOlder = !previous || previous.versionNo < selected.versionNo;
  const comparison = useMemo(() => {
    if (!mine || !other) return null;
    return otherIsOlder ? compareVersions(other, mine) : compareVersions(mine, other);
  }, [mine, other, otherIsOlder]);

  if (!previous) {
    return (
      <p className="text-sm text-muted-foreground">
        {selected.kind === "baseline"
          ? `How ${agentName} was before its history began. There is no earlier version to compare it with.`
          : selected.kind === "created"
            ? `The first version of ${agentName}, as it was created. There is nothing earlier to compare it with.`
            : "This is the oldest version still kept, so there is nothing earlier to compare it with."}
      </p>
    );
  }

  const needed = [selected.versionNo, previous.versionNo];
  const failed = needed.filter((no) => !history.details[no] && history.failedVersions.has(no));
  if (failed.length) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm text-muted-foreground">Could not load this version's changes.</p>
        <button
          type="button"
          onClick={() => failed.forEach((no) => void history.loadVersion(no))}
          className={SECONDARY_BUTTON}
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
        <Skeleton className="h-28 w-full rounded-2xl bg-muted/60" />
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
      {isEmptyComparison(comparison) ? (
        <p className="text-sm text-muted-foreground">
          Nothing in the definition differs from version {previous.versionNo}.
        </p>
      ) : (
        <VersionChanges comparison={comparison} />
      )}
    </div>
  );
}

function HistorySkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading history">
      <SoftPanel className="space-y-1 p-1.5">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex gap-3 px-3 py-2.5">
            <Skeleton className="mt-1.5 h-2.5 w-2.5 rounded-full bg-muted/70" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-4 w-48 bg-muted/70" />
              <Skeleton className="h-3 w-64 bg-muted/60" />
            </div>
          </div>
        ))}
      </SoftPanel>
    </div>
  );
}
