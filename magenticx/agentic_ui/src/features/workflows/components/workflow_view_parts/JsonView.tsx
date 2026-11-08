import * as React from "react";
import { Check, ChevronRight, Copy } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import { ICON_BUTTON, JSON_OPEN_DEPTH, JSON_STRING_PREVIEW } from "@/features/workflows/lib/consts";
import { hasContent, toPrettyJson } from "@/features/workflows/lib/format";

/*
 * A folding JSON tree with a copy button, for a node's input, output, state
 * and raw events. Custom rather than the chat's CodeBlock: a payload here is
 * explored (open one branch of a large API response), not read top to bottom,
 * and highlighting the whole of it up front would cost more than it shows.
 */

type JsonNodeProps = { name?: string; value: unknown; depth: number; openDepth: number };

const isBranch = (value: unknown): value is Record<string, unknown> | unknown[] =>
  typeof value === "object" && value !== null;

function JsonLeaf({ value }: { value: unknown }) {
  const [full, setFull] = React.useState(false);
  if (typeof value === "string") {
    const long = value.length > JSON_STRING_PREVIEW;
    const shown = long && !full ? `${value.slice(0, JSON_STRING_PREVIEW)}…` : value;
    return (
      <span className="whitespace-pre-wrap break-words text-foreground [overflow-wrap:anywhere]">
        &quot;{shown}&quot;
        {long ? (
          <button
            type="button"
            onClick={() => setFull((current) => !current)}
            className="ml-1.5 rounded px-1 font-sans text-[11px] font-medium text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 supports-[hover:hover]:hover:bg-primary/10"
          >
            {full ? "Show less" : `Show all (${value.length})`}
          </button>
        ) : null}
      </span>
    );
  }
  if (value === null || value === undefined) {
    return (
      <span className="italic text-muted-foreground">{value === null ? "null" : "undefined"}</span>
    );
  }
  return <span className="text-primary">{String(value)}</span>;
}

function JsonNode({ name, value, depth, openDepth }: JsonNodeProps) {
  const [open, setOpen] = React.useState(depth < openDepth);
  const key = name !== undefined ? <span className="text-muted-foreground">{name}: </span> : null;
  if (!isBranch(value)) {
    return (
      <div className="min-w-0 pl-[1.125rem]">
        {key}
        <JsonLeaf value={value} />
      </div>
    );
  }
  const entries = Array.isArray(value)
    ? value.map((item, index) => [String(index), item] as const)
    : Object.entries(value);
  const [openMark, closeMark] = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
  const summary = Array.isArray(value)
    ? `${entries.length} item${entries.length === 1 ? "" : "s"}`
    : `${entries.length} key${entries.length === 1 ? "" : "s"}`;
  if (!entries.length) {
    return (
      <div className="min-w-0 pl-[1.125rem]">
        {key}
        <span className="text-muted-foreground">
          {openMark}
          {closeMark}
        </span>
      </div>
    );
  }
  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="flex min-w-0 items-center gap-0.5 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 supports-[hover:hover]:hover:bg-muted/60"
      >
        <ChevronRight
          aria-hidden
          className={cn(
            "h-3.5 w-3.5 flex-shrink-0 text-muted-foreground transition-transform duration-150",
            open && "rotate-90",
          )}
        />
        <span className="min-w-0 truncate">
          {key}
          <span className="text-muted-foreground">
            {openMark}
            {open ? "" : ` ${summary} ${closeMark}`}
          </span>
        </span>
      </button>
      {open ? (
        <>
          <div className="ml-[0.4rem] border-l border-border/60 pl-1.5">
            {entries.map(([childKey, child]) => (
              <JsonNode
                key={childKey}
                name={Array.isArray(value) ? undefined : childKey}
                value={child}
                depth={depth + 1}
                openDepth={openDepth}
              />
            ))}
          </div>
          <div className="pl-[1.125rem] text-muted-foreground">{closeMark}</div>
        </>
      ) : null}
    </div>
  );
}

/** The folding tree in its scrolling box, without a heading or copy button. */
export function JsonTree({
  value,
  openDepth = JSON_OPEN_DEPTH,
  className,
}: {
  value: unknown;
  openDepth?: number;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "slim-scrollbar max-h-[28rem] overflow-auto overscroll-contain rounded-xl bg-muted/40 px-2 py-2 font-mono text-[12px] leading-5",
        className,
      )}
    >
      <JsonNode value={value} depth={0} openDepth={openDepth} />
    </div>
  );
}

/** Copy the payload as indented JSON; the icon says when it worked. */
export function CopyJsonButton({ value, label = "Copy JSON" }: { value: unknown; label?: string }) {
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
      className={ICON_BUTTON}
      onClick={() => {
        if (!navigator.clipboard?.writeText) return;
        navigator.clipboard.writeText(toPrettyJson(value)).then(
          () => setCopied(true),
          () => setCopied(false),
        );
      }}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-success" aria-hidden />
      ) : (
        <Copy className="h-3.5 w-3.5" aria-hidden />
      )}
    </button>
  );
}

type JsonViewProps = {
  value: unknown;
  /** A small heading above the tree; the copy button sits beside it. */
  title?: string;
  /** Shown instead of the tree when there is nothing in it. */
  emptyText?: string;
  openDepth?: number;
  className?: string;
};

export function JsonView({
  value,
  title,
  emptyText = "Nothing here.",
  openDepth = JSON_OPEN_DEPTH,
  className,
}: JsonViewProps) {
  const empty = !hasContent(value);
  return (
    <section className={cn("min-w-0", className)} aria-label={title}>
      {title || !empty ? (
        <div className="mb-1.5 flex min-h-[1.75rem] items-center justify-between gap-2">
          {title ? (
            <h4 className="text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              {title}
            </h4>
          ) : (
            <span />
          )}
          {!empty ? (
            <CopyJsonButton
              value={value}
              label={title ? `Copy ${title.toLowerCase()}` : undefined}
            />
          ) : null}
        </div>
      ) : null}
      {empty ? (
        <p className="rounded-xl bg-muted/30 px-3 py-2.5 text-xs italic text-muted-foreground">
          {emptyText}
        </p>
      ) : (
        <JsonTree value={value} openDepth={openDepth} />
      )}
    </section>
  );
}
