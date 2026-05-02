import * as React from "react";
import hljs from "highlight.js/lib/common";
import Papa from "papaparse";
import { Check, Copy } from "lucide-react";

import { Button } from "@/components/ui/button";
import { MarkdownRenderer } from "@/components/ui/markdownRenderer";
import { cn } from "@/lib/utils";

type TextPreviewProps = {
  content: string;
  language?: string;
  className?: string;
};

function CopyButton({ content }: { content: string }) {
  const [copied, setCopied] = React.useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(content);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className="h-8 gap-2 rounded-md border border-white/10 bg-white/[0.04] px-3 text-xs text-white/75 hover:bg-white/[0.08] hover:text-white"
      onClick={() => void handleCopy()}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

export function CodeTextPreview({ content, language, className }: TextPreviewProps) {
  const highlighted = React.useMemo(() => {
    try {
      if (language && hljs.getLanguage(language)) {
        return hljs.highlight(content, { language }).value;
      }
      return hljs.highlightAuto(content).value;
    } catch {
      return "";
    }
  }, [content, language]);

  return (
    <div className={cn("flex h-full min-h-0 flex-col overflow-hidden rounded-[1.4rem] border border-white/10 bg-[#151515]", className)}>
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
        <span className="text-xs font-medium uppercase tracking-wide text-white/45">{language || "text"}</span>
        <CopyButton content={content} />
      </div>
      <pre className="min-h-0 flex-1 overflow-auto p-4 text-[0.82rem] leading-6 text-white/85">
        {highlighted ? (
          <code dangerouslySetInnerHTML={{ __html: highlighted }} />
        ) : (
          <code>{content}</code>
        )}
      </pre>
    </div>
  );
}

export function MarkdownPreview({ content }: { content: string }) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-[1.4rem] border border-white/10 bg-[#202020]">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
        <span className="text-xs font-medium uppercase tracking-wide text-white/45">markdown</span>
        <CopyButton content={content} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-[#f8f8f5] p-6 text-[#1f1f1f] dark:bg-[#1d1d1d] dark:text-white">
        <MarkdownRenderer content={content} />
      </div>
    </div>
  );
}

export function JsonPreview({ content }: { content: string }) {
  const parsed = React.useMemo(() => {
    try {
      return JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      return null;
    }
  }, [content]);

  return <CodeTextPreview content={parsed ?? content} language="json" />;
}

export function CsvPreview({ content }: { content: string }) {
  const rows = React.useMemo(() => {
    const parsed = Papa.parse<string[]>(content.trim(), {
      skipEmptyLines: true,
    });
    return (parsed.data || []).slice(0, 500);
  }, [content]);

  const maxColumns = Math.min(80, rows.reduce((max, row) => Math.max(max, row.length), 0));

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-[1.4rem] border border-white/10 bg-[#171717]">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
        <span className="text-xs font-medium uppercase tracking-wide text-white/45">
          csv · {rows.length} rows previewed
        </span>
        <CopyButton content={content} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="min-w-full border-collapse text-left text-xs text-white/80">
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={`csv-row-${rowIndex}`} className={rowIndex === 0 ? "bg-white/[0.06] text-white" : undefined}>
                {Array.from({ length: maxColumns }).map((_, columnIndex) => (
                  <td
                    key={`csv-cell-${rowIndex}-${columnIndex}`}
                    className="max-w-[22rem] whitespace-pre-wrap border border-white/10 px-3 py-2 align-top"
                  >
                    {row[columnIndex] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
