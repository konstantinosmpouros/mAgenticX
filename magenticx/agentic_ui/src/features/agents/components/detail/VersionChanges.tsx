import { useMemo, useState } from "react";
import { ArrowRight, ChevronDown, ChevronsUpDown, FileText, Minus, Plus } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import type { FileChange, VersionComparison } from "@/features/agents/lib/agentHistory";
import { collapseUnchanged, diffLines, type DiffLine } from "@/features/agents/lib/textDiff";

/**
 * What one saved version changed, compared with the version kept before it —
 * the body of a version on the agent's History tab. Fields side by side, list
 * fields as added / removed chips, and each changed file as a line diff with
 * long unchanged stretches folded away.
 *
 * Added and removed are told apart by a sign and a screen-reader word, not by
 * colour alone.
 */

const STATUS_LABEL: Record<FileChange["status"], string> = {
  added: "Added",
  removed: "Removed",
  changed: "Changed",
};

function Heading({ children }: { children: string }) {
  return (
    <h4 className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </h4>
  );
}

const shown = (value: string) =>
  value ? value : <span className="italic text-muted-foreground">none</span>;

export function VersionChanges({ comparison }: { comparison: VersionComparison }) {
  const { fields, lists, files } = comparison;
  return (
    <div className="space-y-5">
      {fields.length ? (
        <section className="space-y-2" aria-label="Details changed">
          <Heading>Details</Heading>
          <dl className="divide-y divide-border/40 overflow-hidden rounded-2xl bg-background/50">
            {fields.map((f) => (
              <div key={f.label} className="grid gap-1.5 px-4 py-3 sm:grid-cols-[9rem_1fr]">
                <dt className="text-sm text-muted-foreground">{f.label}</dt>
                <dd className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
                  <span className="sr-only">Before:</span>
                  <span className="min-w-0 break-words text-muted-foreground line-through decoration-muted-foreground/50 [overflow-wrap:anywhere]">
                    {shown(f.before)}
                  </span>
                  <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="sr-only">After:</span>
                  <span className="min-w-0 break-words font-medium text-foreground [overflow-wrap:anywhere]">
                    {shown(f.after)}
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      {lists.length ? (
        <section className="space-y-2" aria-label="Lists changed">
          <Heading>Tools, skills and sub-agents</Heading>
          <dl className="divide-y divide-border/40 overflow-hidden rounded-2xl bg-background/50">
            {lists.map((l) => (
              <div key={l.label} className="grid gap-1.5 px-4 py-3 sm:grid-cols-[9rem_1fr]">
                <dt className="text-sm text-muted-foreground">{l.label}</dt>
                <dd className="flex min-w-0 flex-wrap gap-1.5">
                  {l.added.map((item) => (
                    <span
                      key={`+${item.key}`}
                      title={item.key}
                      className="inline-flex max-w-full items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-xs font-medium text-foreground"
                    >
                      <Plus className="h-3 w-3 shrink-0 text-success" aria-hidden />
                      <span className="sr-only">Added</span>
                      <span className="truncate">{item.label}</span>
                    </span>
                  ))}
                  {l.removed.map((item) => (
                    <span
                      key={`-${item.key}`}
                      title={item.key}
                      className="inline-flex max-w-full items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-muted-foreground"
                    >
                      <Minus className="h-3 w-3 shrink-0 text-destructive" aria-hidden />
                      <span className="sr-only">Removed</span>
                      <span className="truncate line-through">{item.label}</span>
                    </span>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      {files.length ? (
        <section className="space-y-2" aria-label="Files changed">
          <Heading>Instructions and files</Heading>
          <div className="space-y-2">
            {files.map((file) => (
              <FileDiff key={file.path} file={file} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function FileDiff({ file }: { file: FileChange }) {
  const [open, setOpen] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const diff = useMemo(
    () => (file.binary ? null : diffLines(file.before, file.after)),
    [file.binary, file.before, file.after],
  );
  const segments = useMemo(
    () =>
      diff && !diff.tooLarge
        ? showAll
          ? diff.lines.map((line) => ({ type: "line" as const, line }))
          : collapseUnchanged(diff.lines)
        : [],
    [diff, showAll],
  );
  const bodyId = `file-diff-${file.path.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

  return (
    <div className="overflow-hidden rounded-2xl bg-background/50">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={bodyId}
        className="flex min-h-11 w-full items-center gap-2.5 px-4 py-2.5 text-left transition-colors hover:bg-[hsl(var(--hover-surface))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/60"
      >
        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate font-mono text-sm text-foreground">
          {file.path}
        </span>
        <span
          className={cn(
            "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium",
            file.status === "added" && "bg-success/10 text-success",
            file.status === "removed" && "bg-destructive/10 text-destructive",
            file.status === "changed" && "bg-muted/70 text-muted-foreground",
          )}
        >
          {STATUS_LABEL[file.status]}
        </span>
        {diff && !diff.tooLarge ? (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            <span className="text-success">+{diff.added}</span>{" "}
            <span className="text-destructive">−{diff.removed}</span>
          </span>
        ) : null}
        <ChevronDown
          className={cn(
            "h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-150",
            open && "rotate-180",
          )}
          aria-hidden
        />
      </button>

      {open ? (
        <div id={bodyId} className="border-t border-border/40">
          {file.binary ? (
            <p className="px-4 py-3 text-xs text-muted-foreground">
              A binary file — its contents can't be compared line by line.
            </p>
          ) : !diff || diff.tooLarge ? (
            <p className="px-4 py-3 text-xs text-muted-foreground">
              This file is too large to compare here.
            </p>
          ) : diff.lines.length === 0 ? (
            <p className="px-4 py-3 text-xs text-muted-foreground">(empty)</p>
          ) : (
            <div className="scrollbar-muted max-h-[28rem] overflow-auto py-1 font-mono text-xs leading-relaxed">
              {segments.map((seg, i) =>
                seg.type === "skip" ? (
                  <button
                    key={`skip-${i}`}
                    type="button"
                    onClick={() => setShowAll(true)}
                    className="flex w-full items-center gap-2 bg-muted/40 px-4 py-1 text-left font-sans text-[11px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/60"
                  >
                    <ChevronsUpDown className="h-3 w-3 shrink-0" aria-hidden />
                    {seg.count} unchanged lines — show all
                  </button>
                ) : (
                  <DiffRow
                    key={`${seg.line.oldNo ?? ""}-${seg.line.newNo ?? ""}`}
                    line={seg.line}
                  />
                ),
              )}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function DiffRow({ line }: { line: DiffLine }) {
  return (
    <div
      className={cn(
        "grid grid-cols-[2.5rem_2.5rem_1rem_1fr]",
        line.kind === "added" && "bg-success/10",
        line.kind === "removed" && "bg-destructive/10",
      )}
    >
      <span className="select-none pr-2 text-right tabular-nums text-muted-foreground/70">
        {line.oldNo ?? ""}
      </span>
      <span className="select-none pr-2 text-right tabular-nums text-muted-foreground/70">
        {line.newNo ?? ""}
      </span>
      <span
        className={cn(
          "select-none",
          line.kind === "added" && "text-success",
          line.kind === "removed" && "text-destructive",
        )}
        aria-hidden
      >
        {line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}
      </span>
      <span className="min-w-0 whitespace-pre-wrap break-words pr-4 text-foreground [overflow-wrap:anywhere]">
        {line.kind === "added" ? <span className="sr-only">Added: </span> : null}
        {line.kind === "removed" ? <span className="sr-only">Removed: </span> : null}
        <span>{line.text || " "}</span>
      </span>
    </div>
  );
}
