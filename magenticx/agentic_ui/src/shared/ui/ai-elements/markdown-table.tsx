import { CheckIcon, CopyIcon, DownloadIcon } from "lucide-react";
import { useEffect, useRef, useState, type ComponentProps } from "react";

import { copyTableRows, downloadTableCsv, tableRows } from "@/shared/lib/table-export";
import { cn } from "@/shared/lib/utils";

const TABLE_TEXT = {
  copy: "Copy table",
  copied: "Table copied",
  download: "Download table (CSV)",
};

const COPIED_RESET_MS = 2000;

// Same look as Streamdown's own code-block and diagram buttons.
const ACTION_CLASS =
  "cursor-pointer p-1 text-muted-foreground transition-all hover:text-foreground";

type TableProps = ComponentProps<"table"> & { node?: unknown };

/**
 * A Markdown table in an answer, in a card frame, with copy and CSV buttons.
 *
 * Replaces Streamdown's own table (the `table` component override swaps out its
 * wrapper and buttons too), whose copy puts Markdown source on the clipboard and
 * whose CSV has no BOM, so Excel opens Greek as mojibake. Here copy puts HTML +
 * TSV on the clipboard (a grid in Word, Outlook and Excel) and the CSV carries
 * a BOM. The rows are read from the rendered table at click time, so a table
 * still streaming in is copied as far as it has arrived.
 */
export function MarkdownTable({ children, className, node: _node, ...props }: TableProps) {
  const tableRef = useRef<HTMLTableElement>(null);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const rows = () => (tableRef.current ? tableRows(tableRef.current) : []);

  const handleCopy = () => {
    void copyTableRows(rows()).then((ok) => {
      if (!ok) return;
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
    });
  };

  const handleDownload = () => {
    const current = rows();
    if (current.length > 0) downloadTableCsv(current);
  };

  const copyLabel = copied ? TABLE_TEXT.copied : TABLE_TEXT.copy;
  return (
    <div className="my-4 flex flex-col gap-1" data-streamdown="table-wrapper">
      <div className="flex items-center justify-end gap-1">
        <button
          type="button"
          className={ACTION_CLASS}
          onClick={handleCopy}
          title={copyLabel}
          aria-label={copyLabel}
        >
          {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
        </button>
        <button
          type="button"
          className={ACTION_CLASS}
          onClick={handleDownload}
          title={TABLE_TEXT.download}
          aria-label={TABLE_TEXT.download}
        >
          <DownloadIcon size={14} />
        </button>
      </div>
      <div className="overflow-x-auto rounded-xl border border-border/70 bg-card/40 shadow-sm">
        <table
          ref={tableRef}
          className={cn("w-full border-collapse", className)}
          data-streamdown="table"
          {...props}
        >
          {children}
        </table>
      </div>
    </div>
  );
}
