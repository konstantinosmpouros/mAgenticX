"use client";

import { hideUnclosedCitationMarker } from "@/shared/lib/citations";
import { CITATION_ELEMENT, remarkCitations } from "@/shared/lib/remarkCitations";
import { prepareStreamingMarkdown } from "@/shared/lib/streaming-markdown";
import { cn } from "@/shared/lib/utils";
import { type ComponentProps, memo, useState } from "react";
import { defaultRemarkPlugins, Streamdown, type MermaidConfig } from "streamdown";

import { CitationElement } from "./inline-citation";
import { MarkdownTable } from "./markdown-table";
import { MermaidExportLayer } from "./mermaid-export";

type ResponseProps = ComponentProps<typeof Streamdown> & {
  /** The answer is still arriving: an unfinished ```mermaid block is held back
   * (see `prepareStreamingMarkdown`) instead of rendering Mermaid's parse error. */
  streaming?: boolean;
  /** An agent's answer: `[src:…]` markers become citation pills (plan 42),
   * resolved against the conversation's sources. Off for anything a person
   * wrote, where the text is shown as typed. */
  citations?: boolean;
};

// Streamdown's own plugins (GFM, math) plus the citation markers.
const CITATION_REMARK_PLUGINS = [...Object.values(defaultRemarkPlugins), remarkCitations];
// `mx-citation` is not an HTML element, so it is not in react-markdown's
// `Components` keys; the renderer still looks it up by tag name.
const CITATION_COMPONENTS = { [CITATION_ELEMENT]: CitationElement } as Record<string, unknown>;

function prepareMarkdown(markdown: string, streaming: boolean, citations: boolean): string {
  const prepared = prepareStreamingMarkdown(markdown, streaming);
  return citations && streaming ? hideUnclosedCitationMarker(prepared) : prepared;
}

const defaultMermaidConfig: MermaidConfig = {
  theme: "base",
  themeVariables: {
    background: "#ffffff",
    mainBkg: "#ffffff",
    primaryColor: "#eef2ff",
    primaryBorderColor: "#6d5dfc",
    primaryTextColor: "#111827",
    secondaryColor: "#f8fafc",
    secondaryBorderColor: "#94a3b8",
    secondaryTextColor: "#111827",
    tertiaryColor: "#fef3c7",
    tertiaryBorderColor: "#f59e0b",
    tertiaryTextColor: "#111827",
    lineColor: "#475569",
    textColor: "#111827",
    actorBkg: "#eef2ff",
    actorBorder: "#6d5dfc",
    actorTextColor: "#111827",
    signalColor: "#475569",
    signalTextColor: "#111827",
    noteBkgColor: "#fef3c7",
    noteTextColor: "#111827",
    noteBorderColor: "#f59e0b",
  },
};

/**
 * An answer rendered as Markdown. Mermaid diagrams get a "Download image (PNG)"
 * button beside Streamdown's own source-download and copy buttons, from
 * `MermaidExportLayer`. Tables render through `MarkdownTable` (a card frame,
 * copy as a grid, CSV that Excel opens correctly). While `streaming`, a diagram
 * still being written shows "Generating diagram…" instead of a parse error.
 * With `citations`, `[src:…]` markers render as citation pills, and while
 * streaming a marker that has not closed yet is held back.
 */
export const Response = memo(
  ({
    className,
    components,
    mermaidConfig,
    streaming = false,
    citations = false,
    children,
    ...props
  }: ResponseProps) => {
    // `contents`: the wrapper only gives the diagram buttons a root to look in; it
    // adds no box, so the answer's layout is unchanged.
    const [root, setRoot] = useState<HTMLDivElement | null>(null);
    return (
      <div ref={setRoot} className="contents">
        <Streamdown
          className={cn(
            "chat-markdown size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
            "leading-relaxed break-words text-inherit",
            className,
          )}
          mermaidConfig={{
            ...defaultMermaidConfig,
            ...mermaidConfig,
            themeVariables: {
              ...defaultMermaidConfig.themeVariables,
              ...mermaidConfig?.themeVariables,
            },
          }}
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
                  className="chat-markdown-link"
                  href={href}
                  rel="noreferrer"
                  target="_blank"
                  {...anchorProps}
                >
                  {children}
                </a>
              );
            },
            table: MarkdownTable,
            ...(citations ? CITATION_COMPONENTS : {}),
            ...components,
          }}
          {...(citations ? { remarkPlugins: CITATION_REMARK_PLUGINS } : {})}
          {...props}
        >
          {typeof children === "string" ? prepareMarkdown(children, streaming, citations) : children}
        </Streamdown>
        <MermaidExportLayer root={root} />
      </div>
    );
  },
  (prevProps, nextProps) =>
    prevProps.children === nextProps.children &&
    prevProps.streaming === nextProps.streaming &&
    prevProps.citations === nextProps.citations,
);

Response.displayName = "Response";
