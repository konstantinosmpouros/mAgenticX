"use client";

import { cn } from "@/lib/utils";
import { type ComponentProps, memo } from "react";
import { Streamdown } from "streamdown";

type ResponseProps = ComponentProps<typeof Streamdown>;

export const Response = memo(
  ({ className, components, ...props }: ResponseProps) => (
    <Streamdown
      className={cn(
        "chat-markdown size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        "leading-relaxed break-words text-inherit",
        className
      )}
      components={{
        a: ({ children, href, node, ...anchorProps }) => {
          const isFootnoteRef = "data-footnote-ref" in anchorProps;
          const isFootnoteBackref = "data-footnote-backref" in anchorProps;

          if (isFootnoteBackref) {
            return null;
          }

          if (isFootnoteRef) {
            return (
              <span
                className="chat-markdown-footnote-ref"
                aria-label={`Footnote ${String(children)}`}
              >
                {children}
              </span>
            );
          }

          return (
            <a
              href={href}
              rel="noreferrer"
              target="_blank"
              {...anchorProps}
            >
              {children}
            </a>
          );
        },
        ...components,
      }}
      {...props}
    />
  ),
  (prevProps, nextProps) => prevProps.children === nextProps.children
);

Response.displayName = "Response";
