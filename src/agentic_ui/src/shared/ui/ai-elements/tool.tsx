"use client";

import { cn } from "@/shared/lib/utils";
import type { ComponentProps, ReactNode } from "react";
import { isValidElement } from "react";

import { CodeBlock } from "./code-block";

/**
 * Ceiling for a tool payload pane.
 *
 * Tool arguments and results are unbounded — a single `write_file` call can
 * carry a 500-line document, and a `read_file` result more. Rendered unbounded
 * they expand the message to the height of the payload and push the rest of the
 * conversation off screen, so each pane caps and scrolls within itself instead.
 */
const PAYLOAD_PANE = "scrollbar-muted max-h-72 overflow-auto overscroll-contain";

export type ToolInputProps = ComponentProps<"div"> & {
  input: unknown;
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => (
  <div className={cn("space-y-2 overflow-hidden", className)} {...props}>
    <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
      Parameters
    </h4>
    <div className={cn("min-w-0 rounded-md bg-muted/50", PAYLOAD_PANE)}>
      <CodeBlock
        className="[&_pre]:whitespace-pre-wrap [&_pre]:break-words"
        code={typeof input === "string" ? input : JSON.stringify(input, null, 2)}
        language="json"
      />
    </div>
  </div>
);

export type ToolOutputProps = ComponentProps<"div"> & {
  output: unknown;
  errorText?: string;
  truncated?: boolean;
};

export const ToolOutput = ({
  className,
  output,
  errorText,
  truncated,
  ...props
}: ToolOutputProps) => {
  if (!(output || errorText)) {
    return null;
  }

  let Output = <div>{output as ReactNode}</div>;

  if (typeof output === "object" && !isValidElement(output)) {
    Output = (
      <CodeBlock
        className="[&_pre]:whitespace-pre-wrap [&_pre]:break-words"
        code={JSON.stringify(output, null, 2)}
        language="json"
      />
    );
  } else if (typeof output === "string") {
    Output = (
      <CodeBlock
        className="[&_pre]:whitespace-pre-wrap [&_pre]:break-words"
        code={output}
        language="json"
      />
    );
  }

  return (
    <div className={cn("space-y-2", className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {errorText ? "Error" : "Result"}
      </h4>
      <div
        className={cn(
          "min-w-0 rounded-md text-xs [&_table]:w-full",
          PAYLOAD_PANE,
          errorText ? "bg-destructive/10 text-destructive" : "bg-muted/50 text-foreground",
        )}
      >
        {errorText && <div>{errorText}</div>}
        {Output}
      </div>
      {truncated ? (
        <p className="text-muted-foreground text-xs italic">
          Result truncated for storage — the agent saw the full output.
        </p>
      ) : null}
    </div>
  );
};
