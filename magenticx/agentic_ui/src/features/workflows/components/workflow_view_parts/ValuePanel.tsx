import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Braces } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import { CodeBlock } from "@/shared/ui/ai-elements/code-block";
import { Segmented } from "@/shared/ui/segmented";
import { VALUE_MODES, VIEW_MOTION } from "@/features/workflows/lib/consts";
import { hasContent, toPrettyJson } from "@/features/workflows/lib/format";
import { CopyJsonButton } from "./JsonView";
import { Disclosure } from "./Disclosure";
import { ValueTree } from "./ValueTree";

/** The exact payload, pretty-printed in the chat's code style (shiki, light and dark). */
export function RawJson({ value }: { value: unknown }) {
  const code = React.useMemo(() => toPrettyJson(value), [value]);
  return (
    <div className="slim-scrollbar max-h-[28rem] min-w-0 overflow-auto overscroll-contain rounded-xl border border-border/60">
      <CodeBlock
        code={code}
        language="json"
        className="rounded-none border-0 [&_code]:text-[12px] [&_code]:leading-5 [&_pre]:whitespace-pre-wrap [&_pre]:break-words [&_pre]:p-3 [&_pre]:text-[12px]"
      />
    </div>
  );
}

/** The small uppercase heading every block in the details panel uses. */
export function PanelHeading({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="min-w-0 truncate text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
      {children}
    </h4>
  );
}

/**
 * A step value with a Tree / Raw JSON switch and a copy button: `value` in the
 * folding tree (what the summary above did not already say), `raw` (the whole
 * payload, `value` by default) as JSON. With nothing left for the tree, the raw
 * payload is a single folded row instead.
 */
export function ValuePanel({
  title,
  value,
  raw = value,
  emptyText = "Nothing here.",
  openDepth = 1,
  className,
}: {
  title: string;
  value: unknown;
  raw?: unknown;
  emptyText?: string;
  openDepth?: number;
  className?: string;
}) {
  const [mode, setMode] = React.useState<(typeof VALUE_MODES)[number]["id"]>("tree");
  const reduceMotion = useReducedMotion();
  const copyLabel = `Copy ${title.toLowerCase()} as JSON`;

  if (value === undefined) {
    if (!hasContent(raw)) return null;
    return (
      <section aria-label={title} className={cn("min-w-0", className)}>
        <Disclosure
          title="Raw JSON"
          icon={<Braces className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" aria-hidden />}
          action={<CopyJsonButton value={raw} label={copyLabel} />}
        >
          <RawJson value={raw} />
        </Disclosure>
      </section>
    );
  }

  const empty = !hasContent(value) && typeof value !== "boolean" && typeof value !== "number";
  return (
    <section aria-label={title} className={cn("min-w-0", className)}>
      <div className="mb-2 flex min-h-[2rem] min-w-0 items-center gap-2">
        <div className="min-w-0 flex-1">
          <PanelHeading>{title}</PanelHeading>
        </div>
        {!empty ? (
          <>
            <div className="w-[10.5rem] flex-shrink-0">
              <Segmented
                value={mode}
                options={[...VALUE_MODES]}
                onChange={setMode}
                ariaLabel={`Show ${title.toLowerCase()} as`}
                size="sm"
              />
            </div>
            <CopyJsonButton value={raw} label={copyLabel} />
          </>
        ) : null}
      </div>
      {empty ? (
        <p className="rounded-xl bg-muted/30 px-3 py-2.5 text-xs italic text-muted-foreground">{emptyText}</p>
      ) : (
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={mode}
            initial={reduceMotion ? false : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0, transition: { duration: reduceMotion ? 0 : VIEW_MOTION.fast, ease: "easeOut" } }}
            exit={{ opacity: 0, transition: { duration: reduceMotion ? 0 : VIEW_MOTION.fast * 0.65, ease: "easeIn" } }}
            className="min-w-0"
          >
            {mode === "raw" ? (
              <RawJson value={raw} />
            ) : (
              <div className="min-w-0 rounded-xl border border-border/60 bg-card/40 p-1.5">
                <ValueTree value={value} openDepth={openDepth} label={title} />
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      )}
    </section>
  );
}
