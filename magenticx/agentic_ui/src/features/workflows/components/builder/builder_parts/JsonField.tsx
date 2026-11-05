import * as React from "react";

import { cn } from "@/shared/lib/utils";
import { INPUT } from "@/features/workflows/lib/builder/consts";

const pretty = (value: unknown): string => {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "";
  }
};

/**
 * The fallback editor for a config value whose shape the form has no widget
 * for: JSON in a monospace area, written only when it parses (and is of
 * `jsonType` when the schema names one); otherwise the field says why and
 * the last good value stands. Empty removes the value.
 */
export function JsonField({
  id,
  value,
  onChange,
  jsonType,
  invalid,
  describedBy,
}: {
  id?: string;
  value: unknown;
  onChange: (value: unknown) => void;
  jsonType?: string;
  invalid?: boolean;
  describedBy?: string;
}) {
  const [text, setText] = React.useState(() => pretty(value));
  const [error, setError] = React.useState<string | null>(null);
  const written = React.useRef(value);
  React.useEffect(() => {
    if (value !== written.current) {
      written.current = value;
      setText(pretty(value));
      setError(null);
    }
  }, [value]);

  const change = (next: string) => {
    setText(next);
    if (!next.trim()) {
      setError(null);
      written.current = undefined;
      onChange(undefined);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(next);
    } catch {
      setError("Not valid JSON yet.");
      return;
    }
    const fits =
      !jsonType ||
      (jsonType === "array" && Array.isArray(parsed)) ||
      (jsonType === "object" && Boolean(parsed) && typeof parsed === "object" && !Array.isArray(parsed)) ||
      (jsonType === "string" && typeof parsed === "string") ||
      ((jsonType === "number" || jsonType === "integer") && typeof parsed === "number") ||
      (jsonType === "boolean" && typeof parsed === "boolean");
    if (!fits) {
      setError(`This must be ${jsonType === "array" ? "a list" : `a JSON ${jsonType}`}.`);
      return;
    }
    setError(null);
    written.current = parsed;
    onChange(parsed);
  };

  return (
    <div>
      <textarea
        id={id}
        value={text}
        onChange={(event) => change(event.target.value)}
        rows={4}
        spellCheck={false}
        aria-invalid={invalid || Boolean(error) || undefined}
        aria-describedby={describedBy}
        className={cn(INPUT, "block resize-y font-mono text-[12.5px] leading-relaxed")}
        placeholder={jsonType === "array" ? "[ … ]" : "{ … }"}
      />
      {error ? (
        <p className="mt-1 text-xs text-destructive" role="status">
          {error}
        </p>
      ) : null}
    </div>
  );
}
