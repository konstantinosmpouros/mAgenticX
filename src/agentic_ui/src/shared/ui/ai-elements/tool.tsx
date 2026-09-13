"use client";

import { cn } from "@/shared/lib/utils";
import { parseToolResultImages, type ToolResultImage } from "@/shared/lib/schemas";
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

/** Human-readable size, used only to explain an image that could not be shown. */
const formatBytes = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/**
 * A fixed-height plate the image is fitted into, never cropped and never
 * scrolled.
 *
 * Fixed rather than intrinsic because a tool result sits inside a message: a
 * tall screenshot that sized its own container would push the rest of the
 * conversation off screen. `object-contain` inside a fixed box keeps every
 * image the same footprint whatever its aspect ratio, so a run that reads
 * several stays readable.
 */
const IMAGE_PLATE = "flex h-52 w-full items-center justify-center rounded-lg bg-muted/60 p-3";

const ToolImages = ({ images }: { images: ToolResultImage[] }) => (
  <div className="space-y-2">
    {images.map((image, index) => (
      <div className={IMAGE_PLATE} key={`${image.mime_type}-${index}`}>
        {image.omitted || !image.preview_base64 ? (
          <p className="px-2 text-center text-muted-foreground text-xs">
            {image.bytes
              ? `Image too large to preview (${formatBytes(image.bytes)}). The agent saw it in full.`
              : "Image could not be previewed. The agent saw it in full."}
          </p>
        ) : (
          <img
            alt={`Tool result ${index + 1}`}
            className="max-h-full max-w-full rounded-md object-contain"
            src={`data:${image.mime_type};base64,${image.preview_base64}`}
          />
        )}
      </div>
    ))}
  </div>
);

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

  // An image result is shown as the image. The payload behind it is a
  // thumbnail plus metadata — rendering that as JSON is what produced a wall
  // of base64 where a picture belonged.
  const images = errorText ? [] : parseToolResultImages(output);

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
      {images.length > 0 && !errorText ? (
        <ToolImages images={images} />
      ) : (
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
      )}
      {truncated && images.length === 0 ? (
        <p className="text-muted-foreground text-xs italic">
          Result truncated for display — the agent saw the full output.
        </p>
      ) : null}
    </div>
  );
};
