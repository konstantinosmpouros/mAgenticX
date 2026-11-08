import * as React from "react";
import { Check, ChevronDown, X } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import { MarkdownRenderer } from "@/shared/ui/markdownRenderer";
import { hasContent } from "@/features/workflows/lib/format";
import {
  formatNumber,
  humanizeKey,
  READABLE_MAX_DEPTH,
  recordColumns,
  valueShape,
} from "@/features/workflows/lib/valueView";
import { CopyJsonButton } from "./JsonView";

/** Markdown at a panel's scale: the chat renderer's headings brought down to body size. */
const MARKDOWN_CLASS =
  "text-[13px] leading-6 text-foreground [&_h1]:mb-2 [&_h1]:mt-4 [&_h1]:text-[15px] [&_h1]:font-semibold [&_h2]:mb-1.5 [&_h2]:mt-3.5 [&_h2]:text-[14px] [&_h2]:font-semibold [&_h3]:mb-1 [&_h3]:mt-3 [&_h3]:text-[13px] [&_h3]:font-semibold [&_li]:my-0 [&_p]:mb-2 [&_ul]:mb-2 [&_ul]:pl-5 [&_ol]:mb-2 [&_ol]:pl-5";

/** A long rendered text shows this tall until "Show more" (px). */
const FOLDED_HEIGHT = 288;

export function MarkdownBlock({ text }: { text: string }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [full, setFull] = React.useState(0);
  const [open, setOpen] = React.useState(false);
  React.useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setFull(element.scrollHeight);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element.firstElementChild ?? element);
    return () => observer?.disconnect();
  }, [text]);
  const overflows = full > FOLDED_HEIGHT + 24;
  const folded = overflows && !open;
  return (
    <div className="min-w-0 rounded-xl border border-border/60 bg-card px-4 py-3">
      <div className="relative min-w-0">
        <div
          ref={ref}
          className="min-w-0 overflow-hidden break-words transition-[max-height] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] [overflow-wrap:anywhere] motion-reduce:transition-none"
          style={overflows ? { maxHeight: open ? full : FOLDED_HEIGHT } : undefined}
        >
          <MarkdownRenderer content={text} className={MARKDOWN_CLASS} />
        </div>
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-card to-transparent transition-opacity duration-300",
            folded ? "opacity-100" : "opacity-0",
          )}
        />
      </div>
      {overflows ? (
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
          className="mt-2 inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 supports-[hover:hover]:hover:bg-primary/10"
        >
          <ChevronDown
            className={cn("h-3.5 w-3.5 transition-transform duration-300", open && "rotate-180")}
            aria-hidden
          />
          {open ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}

function EmptyValue() {
  return <span className="text-[13px] text-muted-foreground/70">—</span>;
}

function BooleanValue({ value }: { value: boolean }) {
  const Icon = value ? Check : X;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-medium",
        value ? "bg-success/10 text-success" : "bg-muted text-muted-foreground",
      )}
    >
      <Icon className="h-3 w-3" aria-hidden />
      {value ? "Yes" : "No"}
    </span>
  );
}

function Chips({ items }: { items: readonly unknown[] }) {
  return (
    <span className="flex min-w-0 flex-wrap gap-1.5">
      {items.map((item, index) => (
        <span
          key={`${index}-${String(item)}`}
          className="max-w-full truncate rounded-md border border-border/60 bg-muted/40 px-2 py-0.5 text-[12px] text-foreground"
        >
          {item === null ? "—" : typeof item === "number" ? formatNumber(item) : String(item)}
        </span>
      ))}
    </span>
  );
}

function Records({ rows }: { rows: readonly Record<string, unknown>[] }) {
  const columns = recordColumns(rows);
  return (
    <div className="slim-scrollbar min-w-0 overflow-x-auto rounded-xl border border-border/60">
      <table className="w-full border-collapse text-left text-[12px]">
        <thead>
          <tr className="bg-muted/40">
            {columns.map((column) => (
              <th key={column} scope="col" className="whitespace-nowrap px-3 py-1.5 font-medium text-muted-foreground">
                {humanizeKey(column)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className="border-t border-border/50">
              {columns.map((column) => {
                const cell = row[column];
                return (
                  <td key={column} className="max-w-[16rem] truncate px-3 py-1.5 tabular-nums text-foreground">
                    {cell === null || cell === undefined || cell === ""
                      ? "—"
                      : typeof cell === "number"
                        ? formatNumber(cell)
                        : typeof cell === "boolean"
                          ? cell
                            ? "Yes"
                            : "No"
                          : String(cell)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Whether a field's value sits beside its label (short) or under it (a block). */
const isInline = (value: unknown): boolean => {
  const shape = valueShape(value);
  if (shape === "text") return String(value).length <= 64;
  return shape === "empty" || shape === "boolean" || shape === "number";
};

function Fields({ value, depth }: { value: Record<string, unknown>; depth: number }) {
  return (
    <dl className={cn("min-w-0 divide-y divide-border/50", depth === 0 ? "rounded-xl border border-border/60 bg-card/40" : "")}>
      {Object.entries(value).map(([key, child]) => {
        const inline = isInline(child);
        return (
          <div
            key={key}
            className={cn(
              "min-w-0",
              depth === 0 ? "px-3.5 py-2.5" : "py-2",
              inline ? "flex items-baseline justify-between gap-4" : "space-y-1.5",
            )}
          >
            <dt className="min-w-0 truncate text-[12px] font-medium text-muted-foreground" title={key}>
              {humanizeKey(key)}
            </dt>
            <dd className={cn("min-w-0", inline && "text-right")}>
              <Readable value={child} depth={depth + 1} />
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/** One value in the readable view, by its shape. */
export function Readable({ value, depth }: { value: unknown; depth: number }) {
  const shape = valueShape(value);
  switch (shape) {
    case "empty":
      return <EmptyValue />;
    case "boolean":
      return <BooleanValue value={value as boolean} />;
    case "number":
      return <span className="text-[13px] font-semibold tabular-nums text-foreground">{formatNumber(value as number)}</span>;
    case "text":
      return (
        <span className="whitespace-pre-wrap break-words text-[13px] text-foreground [overflow-wrap:anywhere]">
          {String(value)}
        </span>
      );
    case "markdown":
      return <MarkdownBlock text={String(value)} />;
    case "chips":
      return <Chips items={value as unknown[]} />;
    case "list":
      return (
        <ul className="min-w-0 list-disc space-y-1 pl-5 text-[13px] leading-6 text-foreground marker:text-muted-foreground/60">
          {(value as unknown[]).map((item, index) => (
            <li key={index} className="break-words [overflow-wrap:anywhere]">
              {item === null ? "—" : typeof item === "number" ? formatNumber(item) : String(item)}
            </li>
          ))}
        </ul>
      );
    case "records":
      return <Records rows={value as Record<string, unknown>[]} />;
    case "object":
      return depth <= READABLE_MAX_DEPTH ? (
        <Fields value={value as Record<string, unknown>} depth={depth} />
      ) : (
        <div className="min-w-0 border-l-2 border-border/60 pl-3">
          <Fields value={value as Record<string, unknown>} depth={depth} />
        </div>
      );
    default:
      return <Items items={value as unknown[]} depth={depth} />;
  }
}

/** A long list of mixed or nested values shows this many until "Show all". */
const ITEMS_SHOWN = 10;

/** A list of nested values: one quiet card per item, numbered. */
function Items({ items, depth }: { items: readonly unknown[]; depth: number }) {
  const [all, setAll] = React.useState(false);
  const shown = all ? items : items.slice(0, ITEMS_SHOWN);
  return (
    <div className="min-w-0 space-y-2">
      {shown.map((item, index) => (
        <div key={index} className="min-w-0 rounded-xl border border-border/50 bg-muted/[0.15] px-3 py-2">
          <p className="mb-1 text-[11px] font-medium text-muted-foreground">Item {index + 1}</p>
          <Readable value={item} depth={Math.max(depth, 1) + 1} />
        </div>
      ))}
      {items.length > ITEMS_SHOWN ? (
        <button
          type="button"
          onClick={() => setAll((current) => !current)}
          className="rounded-full px-2 py-1 text-xs font-medium text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 supports-[hover:hover]:hover:bg-primary/10"
        >
          {all ? "Show less" : `Show all ${items.length}`}
        </button>
      ) : null}
    </div>
  );
}

type ValueViewProps = {
  value: unknown;
  /** The small heading; the copy button sits beside it. */
  title: string;
  /** Shown when there is nothing to show. */
  emptyText?: string;
  /** Top-level keys left out of the view (shown elsewhere, e.g. a rendered answer). */
  hideKeys?: readonly string[];
  className?: string;
};

/**
 * A run value as people read it — labelled fields, rendered text, chips,
 * small tables and numbered items, never raw JSON — with a copy button for
 * the exact payload. Used for a step's input and output and what it saved.
 */
export function ValueView({ value, title, emptyText = "Nothing here.", hideKeys, className }: ValueViewProps) {
  const readable = React.useMemo(() => {
    if (!hideKeys?.length || typeof value !== "object" || value === null || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).filter(([key]) => !hideKeys.includes(key)));
  }, [value, hideKeys]);
  const empty = !hasContent(readable);
  // Everything it holds is shown elsewhere (hidden keys): nothing to add here.
  if (empty && hasContent(value)) return null;
  return (
    <section className={cn("min-w-0", className)} aria-label={title}>
      <div className="mb-2 flex min-h-[1.75rem] items-center justify-between gap-2">
        <h4 className="text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">{title}</h4>
        {hasContent(value) ? <CopyJsonButton value={value} label={`Copy ${title.toLowerCase()}`} /> : null}
      </div>
      {empty ? (
        <p className="rounded-xl bg-muted/30 px-3 py-2.5 text-xs italic text-muted-foreground">{emptyText}</p>
      ) : (
        <Readable value={readable} depth={0} />
      )}
    </section>
  );
}
