import * as React from "react";
import { Check, Copy } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import { ICON_BUTTON, JSON_OPEN_DEPTH } from "@/features/workflows/lib/consts";
import { hasContent, toPrettyJson } from "@/features/workflows/lib/format";
import { ValueTree } from "./ValueTree";

/*
 * A titled value (an approval's payload) as the run panel's folding tree, with
 * a copy button for the exact payload; `CopyJsonButton` is shared by every
 * block in the panel.
 */

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
        <div className="slim-scrollbar max-h-[28rem] min-w-0 overflow-auto overscroll-contain rounded-xl border border-border/60 bg-card/40 p-1.5">
          <ValueTree value={value} openDepth={openDepth} label={title} />
        </div>
      )}
    </section>
  );
}
