/*
 * A run value as a quiet folding tree: the top level shown, every nested
 * object or list folded behind a preview (`{12 keys}`, `[30 items]`) that opens
 * on click; long strings clamped with "Show more", long levels paged ("Show 20
 * more"). Keys in muted mono, values by type (text, numbers, yes / no chips,
 * null). Custom rather than a library tree: shadcn/Radix ship none, and a step's
 * payload (a whole GitHub API response) has to stay scannable in a 26rem panel.
 * A disclosure per branch (button + aria-expanded), not an ARIA tree: Tab and
 * Enter / Space work as everywhere else in the panel.
 */
import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Check, ChevronRight, X } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import {
  JSON_STRING_LINES,
  JSON_STRING_PREVIEW,
  TREE_PAGE_SIZE,
  VIEW_MOTION,
} from "@/features/workflows/lib/consts";
import { branchPreview, formatNumber, isHttpUrl } from "@/features/workflows/lib/valueView";

const isBranch = (value: unknown): value is Record<string, unknown> | unknown[] =>
  typeof value === "object" && value !== null;

const entriesOf = (value: Record<string, unknown> | unknown[]): Array<readonly [string, unknown]> =>
  Array.isArray(value) ? value.map((item, index) => [String(index), item] as const) : Object.entries(value);

/** A row's height: compact with a mouse, a full 44px target on a touch screen. */
const ROW = "min-h-[1.75rem] [@media(pointer:coarse)]:min-h-[2.75rem]";
/** The quiet text button (Show more, Show 20 more). */
const TEXT_BUTTON =
  "inline-flex items-center rounded-md px-1.5 text-[11.5px] font-medium text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 supports-[hover:hover]:hover:bg-primary/10";

function LongText({ text }: { text: string }) {
  const [open, setOpen] = React.useState(false);
  const long = text.length > JSON_STRING_PREVIEW || text.split("\n").length > JSON_STRING_LINES;
  return (
    <span className="block min-w-0">
      <span
        className={cn(
          "block whitespace-pre-wrap break-words text-[12.5px] leading-5 text-foreground [overflow-wrap:anywhere]",
          long && !open && "line-clamp-4",
        )}
      >
        {text}
      </span>
      {long ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
          className={cn(TEXT_BUTTON, "-ml-1.5 mt-0.5", ROW)}
        >
          {open ? "Show less" : `Show more · ${formatNumber(text.length)} chars`}
        </button>
      ) : null}
    </span>
  );
}

/** One plain value, by its type. */
export function TreeLeaf({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <span className="font-mono text-[12px] italic leading-5 text-muted-foreground/80">null</span>;
  }
  if (typeof value === "boolean") {
    const Icon = value ? Check : X;
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 align-top font-mono text-[11px] font-medium leading-4",
          value ? "bg-success/15 text-success" : "bg-muted text-muted-foreground",
        )}
      >
        <Icon className="h-3 w-3" aria-hidden />
        {String(value)}
      </span>
    );
  }
  if (typeof value === "number") {
    return <span className="font-mono text-[12px] leading-5 tabular-nums text-primary">{formatNumber(value)}</span>;
  }
  if (typeof value === "string") {
    if (!value) return <span className="font-mono text-[12px] leading-5 text-muted-foreground/80">&quot;&quot;</span>;
    if (isHttpUrl(value)) {
      return (
        <span className="block truncate text-[12.5px] leading-5 text-foreground" title={value}>
          {value}
        </span>
      );
    }
    return <LongText text={value} />;
  }
  if (isBranch(value)) {
    // Only an empty object / list reaches here.
    return (
      <span className="font-mono text-[12px] leading-5 text-muted-foreground/80">{Array.isArray(value) ? "[]" : "{}"}</span>
    );
  }
  return <span className="text-[12.5px] text-foreground">{String(value)}</span>;
}

function Key({ name, index }: { name: string; index: boolean }) {
  return (
    <span
      className={cn(
        "min-w-0 flex-shrink-0 truncate font-mono text-[12px] leading-5",
        // A list's index is short: a narrow column, so the items keep the width.
        index ? "min-w-[1.25rem] basis-auto text-muted-foreground/70" : "max-w-[10rem] basis-[36%] text-muted-foreground",
      )}
      title={name}
    >
      {name}
    </span>
  );
}

type LevelProps = { value: Record<string, unknown> | unknown[]; depth: number; openDepth: number };

/** One level's entries, paged. */
function Level({ value, depth, openDepth }: LevelProps) {
  const entries = React.useMemo(() => entriesOf(value), [value]);
  const [shown, setShown] = React.useState(TREE_PAGE_SIZE);
  const index = Array.isArray(value);
  const rest = entries.length - shown;
  const gutter = React.useMemo(
    () => entries.some(([, child]) => isBranch(child) && entriesOf(child).length > 0),
    [entries],
  );
  return (
    <>
      {entries.slice(0, shown).map(([name, child]) => (
        <TreeRow
          key={name}
          name={name}
          index={index}
          value={child}
          depth={depth}
          openDepth={openDepth}
          gutter={gutter}
        />
      ))}
      {rest > 0 ? (
        <li className={cn("flex items-center gap-2", gutter ? "pl-[1.625rem]" : "pl-1.5")}>
          <button
            type="button"
            onClick={() => setShown((current) => current + TREE_PAGE_SIZE)}
            className={cn(TEXT_BUTTON, "-ml-1.5", ROW)}
          >
            Show {Math.min(rest, TREE_PAGE_SIZE)} more
          </button>
          <span className="text-[11px] tabular-nums text-muted-foreground/70">
            {shown} of {entries.length}
          </span>
        </li>
      ) : null}
    </>
  );
}

function TreeRow({
  name,
  index,
  value,
  depth,
  openDepth,
  gutter,
}: {
  name: string;
  index: boolean;
  value: unknown;
  depth: number;
  openDepth: number;
  /** A sibling folds: leave a chevron's room so keys line up. */
  gutter: boolean;
}) {
  const nested = isBranch(value) && entriesOf(value).length > 0;
  const [open, setOpen] = React.useState(depth + 1 < openDepth);
  const reduceMotion = useReducedMotion();
  const childrenId = React.useId();

  if (!nested) {
    return (
      <li
        className={cn(
          "flex min-h-[1.75rem] min-w-0 items-start gap-3 rounded-md py-1 pr-1.5 text-[12.5px] leading-5",
          gutter ? "pl-[1.625rem]" : "pl-1.5",
        )}
      >
        <Key name={name} index={index} />
        <span className="min-w-0 flex-1">
          <TreeLeaf value={value} />
        </span>
      </li>
    );
  }

  return (
    <li className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? childrenId : undefined}
        onClick={() => setOpen((current) => !current)}
        className={cn(
          "flex w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 text-left transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/60",
          "supports-[hover:hover]:hover:bg-[hsl(var(--hover-surface))]",
          ROW,
        )}
      >
        <ChevronRight
          aria-hidden
          className={cn(
            "h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/80 transition-transform duration-200 ease-out motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
        <span className="flex min-w-0 flex-1 items-center gap-3">
          <Key name={name} index={index} />
          <span className="min-w-0 truncate font-mono text-[11.5px] leading-5 text-muted-foreground/70">
            {branchPreview(value as object)}
          </span>
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.ul
            key="children"
            id={childrenId}
            role="list"
            initial={reduceMotion ? false : { opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0, transition: { duration: reduceMotion ? 0 : VIEW_MOTION.base, ease: "easeOut" } }}
            exit={{ opacity: 0, y: reduceMotion ? 0 : -4, transition: { duration: reduceMotion ? 0 : VIEW_MOTION.base * 0.65, ease: "easeIn" } }}
            className="ml-[0.8rem] min-w-0 border-l border-border/60 pl-1"
          >
            <Level value={value as Record<string, unknown> | unknown[]} depth={depth + 1} openDepth={openDepth} />
          </motion.ul>
        ) : null}
      </AnimatePresence>
    </li>
  );
}

/**
 * The tree for one value. An object or list shows its entries (the top level);
 * a plain value shows on its own. `openDepth` is how many levels start open
 * (1: only the top level, every nested branch folded).
 */
export function ValueTree({
  value,
  openDepth = 1,
  label,
  className,
}: {
  value: unknown;
  openDepth?: number;
  label?: string;
  className?: string;
}) {
  if (isBranch(value) && entriesOf(value).length > 0) {
    return (
      <ul role="list" aria-label={label} className={cn("min-w-0", className)}>
        <Level value={value} depth={0} openDepth={openDepth} />
      </ul>
    );
  }
  return (
    <div className={cn("min-w-0 px-1.5 py-1", className)}>
      <TreeLeaf value={value} />
    </div>
  );
}
