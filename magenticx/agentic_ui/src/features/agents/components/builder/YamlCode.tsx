import { useMemo } from "react";

import { cn } from "@/shared/lib/utils";
import { YAML_TOKEN_CLASS, tokenizeYaml } from "@/features/agents/lib/yamlHighlight";

/** A read-only YAML block in the theme's colours (lib/yamlHighlight), with line numbers. */
export function YamlCode({
  text,
  className,
  label = "agent.yaml",
}: {
  text: string;
  className?: string;
  label?: string;
}) {
  const lines = useMemo(() => tokenizeYaml(text), [text]);
  return (
    <pre
      aria-label={label}
      tabIndex={0}
      className={cn(
        "scrollbar-muted overflow-auto rounded-2xl border border-border/60 bg-muted/25 py-3 font-mono text-[12px] leading-[1.6] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
        className,
      )}
    >
      <code className="grid min-w-max grid-cols-[auto_1fr]">
        {lines.map((tokens, index) => (
          <span key={index} className="contents">
            <span className="select-none pl-3.5 pr-3 text-right text-[11px] tabular-nums text-muted-foreground/50" aria-hidden>
              {index + 1}
            </span>
            <span className="whitespace-pre pr-4">
              {tokens.length
                ? tokens.map((token, i) => (
                    <span key={i} className={YAML_TOKEN_CLASS[token.kind]}>
                      {token.text}
                    </span>
                  ))
                : " "}
            </span>
          </span>
        ))}
      </code>
    </pre>
  );
}
