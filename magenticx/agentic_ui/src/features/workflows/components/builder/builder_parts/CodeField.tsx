import * as React from "react";

import { cn } from "@/shared/lib/utils";
import { INPUT } from "@/features/workflows/lib/builder/consts";

/** What Tab types in the editor. */
const INDENT = "  ";

/**
 * A config field holding source code (`"x-widget": "code"`, the code step's
 * Python): a plain monospace text area, no spell check, Tab indenting by two
 * spaces. Code is never templated, so it has no `{ }` path helper — a `{{`
 * here is the program's own text. Tab is kept for indenting while typing;
 * Escape releases it, so the next Tab moves focus on (no keyboard trap).
 */
export function CodeField({
  id,
  value,
  onChange,
  maxLength,
  invalid,
  describedBy,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  maxLength?: number;
  invalid?: boolean;
  describedBy?: string;
}) {
  const ref = React.useRef<HTMLTextAreaElement>(null);
  // Where the caret goes once an indent has re-rendered the value.
  const caret = React.useRef<number | null>(null);
  // Escape hands Tab back to focus navigation until the next keystroke.
  const released = React.useRef(false);

  React.useLayoutEffect(() => {
    if (caret.current === null || !ref.current) return;
    ref.current.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  }, [value]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      released.current = true;
      return;
    }
    const wasReleased = released.current;
    released.current = false;
    if (event.key !== "Tab" || event.shiftKey || wasReleased || event.altKey || event.ctrlKey || event.metaKey) return;
    const area = event.currentTarget;
    const next = `${value.slice(0, area.selectionStart)}${INDENT}${value.slice(area.selectionEnd)}`;
    if (maxLength !== undefined && next.length > maxLength) return;
    event.preventDefault();
    caret.current = area.selectionStart + INDENT.length;
    onChange(next);
  };

  return (
    <textarea
      ref={ref}
      id={id}
      value={value}
      rows={10}
      maxLength={maxLength}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      autoComplete="off"
      wrap="off"
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={onKeyDown}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      data-widget="code"
      className={cn(INPUT, "block resize-y overflow-x-auto font-mono text-[12.5px] leading-relaxed [tab-size:2]")}
      placeholder={"result = inputs.get(\"x\")"}
    />
  );
}
