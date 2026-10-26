import { useMemo } from "react";
import { AlertTriangle, Loader2, Lock, MessageCircleQuestion, RotateCcw, RotateCw } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import { ROOT_UID, fieldId } from "@/features/agents/lib/agentIssues";
import {
  groupApprovalRows,
  riskNote,
  type ApprovalRow,
} from "@/features/agents/lib/agentApprovals";
import { useBuilder } from "../builderContext";
import { EmptyNote, FieldIssues, SectionHeading } from "./fields";

/**
 * Ask / Don't ask for every tool the agent will have — the built-ins and the MCP
 * tools picked in Tools — saved after the agent itself as this user's choices
 * for it (the same rows as its page's Approvals tab).
 *
 * Each starts where it stands now (the platform's default, an imported YAML's
 * `hitl`, or, editing, the agent's current setting); a row that differs from
 * the default is marked, with a way back. `execute` stays on Ask; `ask_user`
 * is itself a question and never asks.
 */
export function ApprovalsSection({
  saveFailed,
  retrying,
  onRetry,
}: {
  /** The agent was saved but these choices were not: offer them again. */
  saveFailed: boolean;
  retrying: boolean;
  onRetry: () => void;
}) {
  const { approvalRows, dispatch, issuesFor, catalogs, mode } = useBuilder();
  const issues = issuesFor(ROOT_UID, "approvals");
  const groups = useMemo(() => groupApprovalRows(approvalRows), [approvalRows]);
  const changed = approvalRows.filter((row) => row.changed).length;

  return (
    <div className="flex flex-col gap-4">
      {saveFailed ? (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-2xl border border-destructive/40 bg-destructive/[0.06] px-4 py-3"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-destructive" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold text-foreground">
              The agent is saved, but these choices aren&apos;t yet
            </p>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              Until they are, it asks before the tools the platform asks about by default.
            </p>
          </div>
          <button
            type="button"
            onClick={onRetry}
            disabled={retrying}
            className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:opacity-60"
          >
            {retrying ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <RotateCw className="h-3.5 w-3.5" aria-hidden />
            )}
            Retry
          </button>
        </div>
      ) : null}

      <SectionHeading
        title="Ask before running"
        description={
          mode === "edit"
            ? "Which tools pause for your approval first. Saved for you when you save the agent."
            : "Which tools pause for your approval first. Saved for you once the agent is created."
        }
        aside={
          changed ? (
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary tabular-nums">
              {changed} changed
            </span>
          ) : null
        }
      />
      <div id={fieldId(ROOT_UID, "approvals")} tabIndex={-1} className="focus-visible:outline-none">
        <FieldIssues issues={issues} />
      </div>

      {!approvalRows.length ? (
        <EmptyNote>
          {catalogs.loaded
            ? "The list of tools couldn't be loaded. Every tool starts on the platform's default; you can change them on the agent's page once it is saved."
            : "Loading the tools…"}
        </EmptyNote>
      ) : (
        groups.map((group) => (
          <section key={`${group.builtin}:${group.id}`} aria-label={group.id}>
            <p className="mb-1.5 flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              {group.id}
              {group.builtin ? null : (
                <span className="rounded bg-muted/70 px-1 py-px text-[9px] tracking-[0.1em]">MCP</span>
              )}
            </p>
            <ul className="divide-y divide-border/40 overflow-hidden rounded-2xl border border-border/60 bg-background/50">
              {group.rows.map((row) => (
                <ApprovalItem
                  key={row.key}
                  row={row}
                  onChange={(value) => dispatch({ type: "set-approval", key: row.key, value })}
                />
              ))}
            </ul>
          </section>
        ))
      )}
      <p className="px-1 text-xs leading-relaxed text-muted-foreground">
        A tool set to ask pauses the run each time it is called. Scheduled runs have nobody to ask,
        and wait until they time out.
      </p>
    </div>
  );
}

function ApprovalItem({ row, onChange }: { row: ApprovalRow; onChange: (value: boolean) => void }) {
  const risk = riskNote(row);
  return (
    <li className="px-3.5 py-2.5">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5">
            <code className="truncate font-mono text-[12px] font-medium text-foreground">{row.name}</code>
            {row.changed && !row.locked && row.gateable ? (
              <span
                className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-primary"
                title="Changed from the default"
                aria-label="changed from the default"
              />
            ) : null}
          </p>
          {row.description ? (
            <p className="mt-0.5 truncate text-[11.5px] text-muted-foreground" title={row.description}>
              {row.description}
            </p>
          ) : null}
        </div>
        {row.locked ? (
          <span
            className="inline-flex flex-shrink-0 items-center gap-1 rounded-full bg-muted/70 px-2 py-1 text-[11px] font-medium text-muted-foreground"
            title="Running code always asks first; it can't be turned off."
          >
            <Lock className="h-3 w-3" aria-hidden /> Always asks
          </span>
        ) : !row.gateable ? (
          <span
            className="inline-flex flex-shrink-0 items-center gap-1 rounded-full bg-muted/50 px-2 py-1 text-[11px] font-medium text-muted-foreground"
            title="It is itself a question to you, so there is nothing to approve."
          >
            <MessageCircleQuestion className="h-3 w-3" aria-hidden /> Never asks
          </span>
        ) : (
          <AskSwitch name={row.name} value={row.value} onChange={onChange} />
        )}
      </div>
      {row.changed && !row.locked && row.gateable ? (
        <div className="mt-1.5 flex items-center justify-between gap-3">
          {risk ? (
            <p className="flex items-start gap-1.5 text-[11.5px] leading-snug text-[hsl(var(--warning))]" role="note">
              <AlertTriangle className="mt-px h-3.5 w-3.5 flex-shrink-0" aria-hidden />
              {risk}
            </p>
          ) : (
            <p className="text-[11.5px] text-muted-foreground">
              Default: {row.defaultValue ? "asks" : "doesn't ask"}
            </p>
          )}
          <button
            type="button"
            onClick={() => onChange(row.defaultValue)}
            className="inline-flex flex-shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
          >
            <RotateCcw className="h-3 w-3" aria-hidden /> Default
          </button>
        </div>
      ) : null}
    </li>
  );
}

/** A two-way switch reading "Ask | Don't ask", so the state is a word, not a colour. */
function AskSwitch({
  name,
  value,
  onChange,
}: {
  name: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={`${name}: ask before running`}
      className="inline-flex flex-shrink-0 items-center rounded-full border border-border/70 bg-muted/30 p-0.5"
    >
      {(
        [
          { on: true, label: "Ask" },
          { on: false, label: "Don't ask" },
        ] as const
      ).map(({ on, label }) => (
        <button
          key={label}
          type="button"
          role="radio"
          aria-checked={value === on}
          onClick={() => onChange(on)}
          className={cn(
            "rounded-full px-2.5 py-1 text-[11.5px] font-medium transition-[background-color,color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
            value === on
              ? on
                ? "bg-primary text-primary-foreground shadow-sm"
                : "bg-background text-foreground shadow-[0_1px_3px_hsl(var(--foreground)/0.16)] ring-1 ring-border"
              : "text-muted-foreground/80 hover:text-foreground",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
