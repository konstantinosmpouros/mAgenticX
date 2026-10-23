import { useState, type ReactNode } from "react";
import type { BundledLanguage } from "shiki";

import { MarkdownRenderer } from "@/shared/ui/markdownRenderer";
import { cn } from "@/shared/lib/utils";
import {
  hasApprovalDetail,
  isLongField,
  type ApprovalField,
  type ApprovalSummary,
} from "@/features/chat/lib/approvalPresentation";
import { useApprovalSummaries } from "@/features/chat/hooks/useApprovalSummaries";
import { COMPACT_MARKDOWN, CodePane } from "./ToolCallViews";

/**
 * The body of an approval: the fields `presentApproval` chose, each in its
 * natural form — labelled values, the sub-agent brief as Markdown, a command or
 * file as highlighted code. Shared by the approval bar (pending) and the
 * approval's record in the conversation (resolved), so both read the same.
 *
 * A long block starts clipped behind "Show more": the first lines are enough to
 * recognise what is being approved, and the bar must not push the conversation
 * off the screen.
 */

const Clipped = ({ long, children }: { long: boolean; children: ReactNode }) => {
  const [open, setOpen] = useState(false);
  if (!long) return <>{children}</>;
  return (
    <div>
      <div className={cn("relative", !open && "max-h-36 overflow-hidden")}>
        {children}
        {!open ? (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-background to-transparent"
          />
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="mt-1 rounded text-[11.5px] font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        {open ? "Show less" : "Show more"}
      </button>
    </div>
  );
};

const BlockLabel = ({ label }: { label?: string }) =>
  label ? (
    <p className="mb-1 text-[11px] font-medium text-muted-foreground">{label}</p>
  ) : null;

const Block = ({ field }: { field: Exclude<ApprovalField, { kind: "text" }> }) => {
  const long = isLongField(field.value);
  let body: ReactNode;
  if (field.kind === "markdown") {
    body = (
      <div className="rounded-md bg-muted/50 px-3 py-2 text-foreground">
        <MarkdownRenderer
          className={cn(COMPACT_MARKDOWN, "[&_:not(pre)>code]:text-[11px]")}
          content={field.value}
        />
      </div>
    );
  } else if (field.kind === "code") {
    body = <CodePane code={field.value} language={field.language as BundledLanguage} />;
  } else {
    body = (
      <p className="whitespace-pre-wrap break-words rounded-md bg-muted/50 px-3 py-2 text-xs leading-5 text-foreground">
        {field.value}
      </p>
    );
  }
  return (
    <div className="min-w-0">
      <BlockLabel label={field.label} />
      <Clipped long={long}>{body}</Clipped>
    </div>
  );
};

type TextField = Extract<ApprovalField, { kind: "text" }>;

const ValueList = ({ fields }: { fields: TextField[] }) => (
  <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs leading-5">
    {fields.map((field) => (
      <div key={field.label} className="contents">
        <dt className="text-muted-foreground">{field.label}</dt>
        <dd className={cn("break-words text-foreground", field.mono && "font-mono text-[11.5px]")}>
          {field.value}
        </dd>
      </div>
    ))}
  </dl>
);

/** Consecutive short values share one aligned list; blocks stand alone. */
const group = (fields: ApprovalField[]): (TextField[] | ApprovalField)[] => {
  const groups: (TextField[] | ApprovalField)[] = [];
  for (const field of fields) {
    const last = groups[groups.length - 1];
    if (field.kind === "text") {
      if (Array.isArray(last)) last.push(field);
      else groups.push([field]);
    } else {
      groups.push(field);
    }
  }
  return groups;
};

export function HitlActionSummary({
  summary,
  className,
}: {
  summary: ApprovalSummary;
  className?: string;
}) {
  if (!hasApprovalDetail(summary)) return null;
  return (
    <div className={cn("min-w-0 space-y-2.5", className)}>
      {summary.note ? (
        <p className="whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground">
          {summary.note}
        </p>
      ) : null}
      {group(summary.fields).map((item, index) =>
        Array.isArray(item) ? (
          <ValueList key={`values-${index}`} fields={item} />
        ) : (
          <Block key={`${item.kind}-${index}`} field={item as Exclude<ApprovalField, { kind: "text" }>} />
        ),
      )}
    </div>
  );
}

/**
 * Several actions' summaries in a column. Each is titled only when there is
 * more than one — a lone action's title is already the line above it.
 */
export function HitlSummaryList({
  summaries,
  titled = summaries.length > 1,
  className,
}: {
  summaries: ApprovalSummary[];
  titled?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0 space-y-3", className)}>
      {summaries.map((summary, index) => (
        <div key={`${summary.title}-${index}`} className="min-w-0 space-y-1.5">
          {titled ? (
            <p className="text-xs font-medium text-foreground">{summary.title}</p>
          ) : null}
          <HitlActionSummary summary={summary} />
        </div>
      ))}
    </div>
  );
}

/** A raw HITL interrupt payload, presented — for a surface that holds only the payload. */
export function HitlRequestSummary({ content, className }: { content: unknown; className?: string }) {
  const summaries = useApprovalSummaries(content);
  return <HitlSummaryList summaries={summaries} titled className={className} />;
}
