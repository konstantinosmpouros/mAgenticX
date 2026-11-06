import type { ReactNode } from "react";
import { ArrowRight, Minus, Move, Pencil, Plus } from "lucide-react";

import type {
  WorkflowChangeItem,
  WorkflowComparison,
  WorkflowListDiff,
} from "@/features/workflows/lib/workflowHistory";

/**
 * What one kept workflow version changed compared with another — the body of
 * an opened row in the builder's History panel, in the agent history's
 * visual language: fields side by side (before struck through → after), list
 * changes as added / removed chips, and each changed step with its settings
 * before → after.
 *
 * Added and removed are told apart by a sign and a screen-reader word, not by
 * colour alone.
 */

function Heading({ children }: { children: string }) {
  return (
    <h4 className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </h4>
  );
}

const shown = (value: string) =>
  value ? value : <span className="italic text-muted-foreground">none</span>;

/** Before (struck) → after, wrapping anywhere: settings can be long URLs. */
function BeforeAfter({ before, after }: { before: string; after: string }) {
  return (
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
      <span className="sr-only">Before:</span>
      <span className="min-w-0 break-words text-muted-foreground line-through decoration-muted-foreground/50 [overflow-wrap:anywhere]">
        {shown(before)}
      </span>
      <ArrowRight className="h-3.5 w-3.5 shrink-0 self-center text-muted-foreground" aria-hidden />
      <span className="sr-only">After:</span>
      <span className="min-w-0 break-words font-medium text-foreground [overflow-wrap:anywhere]">
        {shown(after)}
      </span>
    </span>
  );
}

function AddedChip({ item }: { item: WorkflowChangeItem }) {
  return (
    <span
      title={item.detail ? `${item.label} — ${item.detail}` : item.label}
      className="inline-flex max-w-full items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-xs font-medium text-foreground"
    >
      <Plus className="h-3 w-3 shrink-0 text-success" aria-hidden />
      <span className="sr-only">Added</span>
      <span className="truncate">{item.label}</span>
      {item.detail ? <span className="truncate font-normal text-muted-foreground">· {item.detail}</span> : null}
    </span>
  );
}

function RemovedChip({ item }: { item: WorkflowChangeItem }) {
  return (
    <span
      title={item.detail ? `${item.label} — ${item.detail}` : item.label}
      className="inline-flex max-w-full items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-muted-foreground"
    >
      <Minus className="h-3 w-3 shrink-0 text-destructive" aria-hidden />
      <span className="sr-only">Removed</span>
      <span className="truncate line-through">{item.label}</span>
      {item.detail ? <span className="truncate font-normal">· {item.detail}</span> : null}
    </span>
  );
}

/** One labelled row of the change lists. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5 px-4 py-3">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-wrap gap-1.5">{children}</dd>
    </div>
  );
}

function AddedRemoved({ added, removed }: { added: WorkflowChangeItem[]; removed: WorkflowChangeItem[] }) {
  return (
    <>
      {added.map((item) => (
        <AddedChip key={`+${item.key}`} item={item} />
      ))}
      {removed.map((item) => (
        <RemovedChip key={`-${item.key}`} item={item} />
      ))}
    </>
  );
}

/** Inputs or variables: added / removed chips, then each changed one before → after. */
function NamedList({ title, diff }: { title: string; diff: WorkflowListDiff }) {
  if (!diff.added.length && !diff.removed.length && !diff.changed.length) return null;
  return (
    <section className="space-y-2" aria-label={`${title} changed`}>
      <Heading>{title}</Heading>
      <dl className="divide-y divide-border/40 overflow-hidden rounded-2xl bg-background/50">
        {diff.added.length || diff.removed.length ? (
          <Row label="Added and removed">
            <AddedRemoved added={diff.added} removed={diff.removed} />
          </Row>
        ) : null}
        {diff.changed.map((item) => (
          <div key={`~${item.key}`} className="grid gap-1 px-4 py-3">
            <dt className="flex items-center gap-1.5 text-sm font-medium text-foreground">
              <Pencil className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
              <span className="sr-only">Changed</span>
              <span className="truncate font-mono text-[13px]">{item.label}</span>
            </dt>
            <dd className="min-w-0">
              <BeforeAfter before={item.before} after={item.after} />
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function WorkflowVersionChanges({ comparison }: { comparison: WorkflowComparison }) {
  const { fields, steps, connections, inputs, variables } = comparison;
  const stepLists = steps.added.length || steps.removed.length;
  const hasSteps = stepLists || steps.renamed.length || steps.changed.length;
  return (
    <div className="space-y-5">
      {fields.length ? (
        <section className="space-y-2" aria-label="Details changed">
          <Heading>Details</Heading>
          <dl className="divide-y divide-border/40 overflow-hidden rounded-2xl bg-background/50">
            {fields.map((f) => (
              <div key={f.label} className="grid gap-1 px-4 py-3">
                <dt className="text-xs font-medium text-muted-foreground">{f.label}</dt>
                <dd className="min-w-0">
                  <BeforeAfter before={f.before} after={f.after} />
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      {hasSteps ? (
        <section className="space-y-2" aria-label="Steps changed">
          <Heading>Steps</Heading>
          <dl className="divide-y divide-border/40 overflow-hidden rounded-2xl bg-background/50">
            {stepLists ? (
              <Row label="Added and removed">
                <AddedRemoved added={steps.added} removed={steps.removed} />
              </Row>
            ) : null}
            {steps.renamed.map((rename) => (
              <div key={`r${rename.id}:${rename.from}`} className="grid gap-1 px-4 py-3">
                <dt className="text-xs font-medium text-muted-foreground">Renamed</dt>
                <dd className="min-w-0">
                  <BeforeAfter before={rename.from} after={rename.to} />
                </dd>
              </div>
            ))}
            {steps.changed.map((step) => (
              <div key={`c${step.id}`} className="grid gap-1.5 px-4 py-3">
                <dt className="flex min-w-0 items-baseline gap-2">
                  <span className="truncate text-sm font-medium text-foreground">{step.label}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{step.kind} · settings changed</span>
                </dt>
                <dd>
                  <ul className="space-y-1.5">
                    {step.settings.map((setting) => (
                      <li key={setting.key} className="grid gap-0.5">
                        <span className="font-mono text-[11.5px] text-muted-foreground">{setting.key}</span>
                        <BeforeAfter before={setting.before} after={setting.after} />
                      </li>
                    ))}
                  </ul>
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      {connections.added.length || connections.removed.length ? (
        <section className="space-y-2" aria-label="Connections changed">
          <Heading>Connections</Heading>
          <dl className="overflow-hidden rounded-2xl bg-background/50">
            <Row label="Added and removed">
              <AddedRemoved added={connections.added} removed={connections.removed} />
            </Row>
          </dl>
        </section>
      ) : null}

      <NamedList title="Inputs" diff={inputs} />
      <NamedList title="Variables" diff={variables} />

      {steps.moved.length ? (
        <p className="flex items-start gap-2 px-1 text-xs text-muted-foreground">
          <Move className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            Moved on the canvas: {steps.moved.map((item) => item.label).join(", ")}.
          </span>
        </p>
      ) : null}
    </div>
  );
}
