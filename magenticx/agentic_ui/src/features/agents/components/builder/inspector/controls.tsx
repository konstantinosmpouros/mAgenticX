import { useState } from "react";
import { Eye, PenLine } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import { MarkdownRenderer } from "@/shared/ui/markdownRenderer";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/select";
import type { AgentModelOption } from "@/shared/lib/types";
import { byteLength, formatBytes, MAX_FILE_BYTES } from "@/features/agents/lib/agentRules";
import { INPUT } from "./fields";

/**
 * The inspector's two richer controls, shared by the main agent and its team:
 * the instructions editor (write / preview, with its size against the file
 * limit) and the model picker (with "inherit" for a sub-agent).
 */

/** Radix Select rejects "", so "inherit the model above" is this value at the control only. */
const INHERIT = "__inherit__";

export function ModelSelect({
  id,
  value,
  models,
  onChange,
  inheritLabel,
  invalid,
  describedBy,
}: {
  id: string;
  /** A model id, or "" to inherit (only with `inheritLabel`). */
  value: string;
  models: AgentModelOption[];
  onChange: (value: string) => void;
  /** Offer "inherit": the label of the model it would inherit. */
  inheritLabel?: string;
  invalid?: boolean;
  describedBy?: string;
}) {
  // A model the list doesn't know (an older or imported spec) stays visible
  // and selected; the server's issue says why it can't be saved.
  const known = !value || models.some((m) => m.id === value);
  return (
    <Select value={value || INHERIT} onValueChange={(next) => onChange(next === INHERIT ? "" : next)}>
      <SelectTrigger
        id={id}
        className={cn(INPUT, "h-auto justify-between")}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
      >
        <SelectValue placeholder="Choose a model" />
      </SelectTrigger>
      <SelectContent className="rounded-xl border border-border/60 bg-popover text-popover-foreground shadow-lg">
        {inheritLabel !== undefined ? (
          <SelectItem value={INHERIT} className="rounded-lg">
            <span className="flex items-baseline gap-2">
              <span className="font-medium">Same as above</span>
              <span className="text-xs text-muted-foreground">{inheritLabel}</span>
            </span>
          </SelectItem>
        ) : null}
        {models.map((model) => (
          <SelectItem key={model.id} value={model.id} className="rounded-lg">
            <span className="flex items-baseline gap-2">
              <span className="font-medium">{model.label || model.id}</span>
              {model.default ? (
                <span className="text-xs text-muted-foreground">Default</span>
              ) : null}
            </span>
          </SelectItem>
        ))}
        {!known ? (
          <SelectItem value={value} className="rounded-lg">
            <span className="font-medium">{value}</span>
          </SelectItem>
        ) : null}
      </SelectContent>
    </Select>
  );
}

/**
 * Instructions: a monospace editor with a Preview of the markdown, and its size
 * against the per-file limit (the server's — each prompt is one file).
 */
export function InstructionsEditor({
  id,
  value,
  onChange,
  onBlur,
  placeholder,
  minRows = 12,
  invalid,
  describedBy,
  fileName,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  placeholder: string;
  minRows?: number;
  invalid?: boolean;
  describedBy?: string;
  /** Where it is saved, for the counter line (`AGENT.md`). */
  fileName: string;
}) {
  const [preview, setPreview] = useState(false);
  const bytes = byteLength(value);
  const near = bytes > MAX_FILE_BYTES * 0.9;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="overflow-hidden rounded-xl border border-border/70 bg-background/70 transition-[border-color,box-shadow] focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-primary/25 aria-[invalid=true]:border-destructive/60"
        aria-invalid={invalid || undefined}
      >
        <div className="flex items-center justify-between gap-2 border-b border-border/50 bg-muted/25 px-1.5 py-1">
          <div role="tablist" aria-label="Instructions view" className="flex items-center gap-0.5">
            {(
              [
                { key: false, label: "Write", Icon: PenLine },
                { key: true, label: "Preview", Icon: Eye },
              ] as const
            ).map(({ key, label, Icon }) => (
              <button
                key={label}
                type="button"
                role="tab"
                aria-selected={preview === key}
                onClick={() => setPreview(key)}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
                  preview === key
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="h-3 w-3" aria-hidden />
                {label}
              </button>
            ))}
          </div>
          <span className="pr-1 font-mono text-[10.5px] text-muted-foreground">{fileName}</span>
        </div>
        {preview ? (
          <div
            className="scrollbar-muted max-h-[28rem] overflow-y-auto px-3.5 py-3"
            style={{ minHeight: `${minRows * 1.25 + 1.5}rem` }}
          >
            {value.trim() ? (
              <MarkdownRenderer content={value} className="prose-p:my-1.5 text-[13px]" />
            ) : (
              <p className="text-xs text-muted-foreground">Nothing to preview yet.</p>
            )}
          </div>
        ) : (
          <textarea
            id={id}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onBlur={onBlur}
            rows={minRows}
            placeholder={placeholder}
            spellCheck
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            className="block w-full resize-y bg-transparent px-3.5 py-3 font-mono text-[12.5px] leading-relaxed text-foreground placeholder:text-muted-foreground/70 focus-visible:outline-none"
          />
        )}
      </div>
      <p
        className={cn(
          "text-right text-[11px] tabular-nums",
          near ? "text-[hsl(var(--warning))]" : "text-muted-foreground",
        )}
        aria-live="polite"
      >
        {value.length.toLocaleString()} characters · {formatBytes(bytes)} of{" "}
        {formatBytes(MAX_FILE_BYTES)}
      </p>
    </div>
  );
}
