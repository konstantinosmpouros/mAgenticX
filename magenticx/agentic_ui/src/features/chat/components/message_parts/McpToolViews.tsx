/**
 * Results of MCP tool steps (Tavily, arXiv, and any future server), each in
 * the form its content takes: web results as cards, a paper as
 * Markdown, a crawl as a list of pages.
 *
 * MCP output is **untrusted** — it is text from the open web or a third-party
 * server. So it is never rendered as HTML (`skipHtml`), never loads images
 * (`img` is disallowed: no tracking pixels, no IP leak to whoever hosts them),
 * and links are http(s)-only, open in a new tab and carry `noopener noreferrer
 * nofollow`. Parsing lives in `lib/mcpToolPresentation.ts`; anything it does not
 * recognise falls back to a readable key/value tree, never a JSON blob.
 *
 * MCP steps show no arguments pane: the title and meta already carry what
 * matters (query, URL, paper id). A failed call still shows them, through the
 * generic view, so debugging never loses information.
 */
import { CheckCircle2, ExternalLink, Loader2, TriangleAlert } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ReactNode } from "react";

import { PAYLOAD_PANE, ToolOutput } from "@/shared/ui/ai-elements/tool";
import { cn } from "@/shared/lib/utils";
import type { TimelineToolExecution } from "@/shared/lib/types";
import {
  authorLine,
  parseDownload,
  parseJson,
  parsePaperContent,
  parsePapers,
  parseTavilyPages,
  parseTavilyResults,
  plainSnippet,
  safeHttpUrl,
  shortUrl,
} from "@/features/chat/lib/mcpToolPresentation";

const PANE = cn("min-w-0 rounded-md bg-muted/50 text-foreground text-xs", PAYLOAD_PANE);
const COMPACT_MARKDOWN =
  "prose prose-sm max-w-none dark:prose-invert text-xs [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-xs [&_h4]:text-xs [&_:is(h1,h2,h3,h4)]:font-semibold [&_:is(h1,h2,h3,h4)]:mb-1 [&_:is(h1,h2,h3,h4)]:mt-2";

const Note = ({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "warn" }) => (
  <p
    className={cn(
      "whitespace-pre-wrap break-words text-xs",
      tone === "warn" ? "text-amber-600 dark:text-amber-500" : "text-muted-foreground italic",
    )}
  >
    {children}
  </p>
);

const TruncatedNote = ({ show }: { show?: boolean }) =>
  show ? <Note>Result truncated for display — the agent saw the full output.</Note> : null;

/** An outbound link to untrusted content: http(s) only, isolated from this page. */
const SafeLink = ({ href, children, className }: { href: string | null; children: ReactNode; className?: string }) =>
  href ? (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className={cn("text-primary underline-offset-2 hover:underline", className)}
    >
      {children}
    </a>
  ) : (
    <span className={className}>{children}</span>
  );

/** Markdown from the web or a paper: no raw HTML, no images, safe links. */
export const UntrustedMarkdown = ({ content }: { content: string }) => (
  <div className={COMPACT_MARKDOWN}>
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      disallowedElements={["img"]}
      unwrapDisallowed
      components={{
        a: ({ href, children }) => <SafeLink href={safeHttpUrl(href)}>{children}</SafeLink>,
      }}
    >
      {content}
    </ReactMarkdown>
  </div>
);

// ---------------------------------------------------------------------------
// Generic JSON → readable tree (any MCP tool without a dedicated view)
// ---------------------------------------------------------------------------

const JsonTree = ({ value, depth = 0 }: { value: unknown; depth?: number }) => {
  if (value === null || typeof value !== "object") {
    return <span className="whitespace-pre-wrap break-words">{String(value)}</span>;
  }
  if (depth >= 3) return <span className="break-words font-mono">{JSON.stringify(value)}</span>;
  if (Array.isArray(value)) {
    if (value.every((item) => item === null || typeof item !== "object")) {
      return <span className="break-words">{value.map(String).join(", ")}</span>;
    }
    return (
      <ol className="list-decimal space-y-1.5 pl-4">
        {value.map((item, index) => (
          <li key={index}>
            <JsonTree value={item} depth={depth + 1} />
          </li>
        ))}
      </ol>
    );
  }
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
      {Object.entries(value as Record<string, unknown>).map(([key, item]) => (
        <div key={key} className="contents">
          <dt className="font-mono text-muted-foreground">{key.replace(/_/g, " ")}</dt>
          <dd className="min-w-0">
            <JsonTree value={item} depth={depth + 1} />
          </dd>
        </div>
      ))}
    </dl>
  );
};

/** A JSON result's `message`, for a non-success status. */
const extractMessage = (result: string | undefined): string | null => {
  const json = parseJson(result);
  return json && typeof json === "object" && typeof (json as Record<string, unknown>).message === "string"
    ? ((json as Record<string, unknown>).message as string)
    : null;
};

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export const McpResultView = ({ tool }: { tool: TimelineToolExecution }) => {
  const result = tool.result;
  if (result === undefined) return null;
  const generic = <ToolOutput output={result} truncated={tool.resultTruncated} />;

  switch (tool.name) {
    case "tavily-search": {
      const results = parseTavilyResults(result);
      if (!results) break;
      if (!results.length) return <Note>No results.</Note>;
      return (
        <div className="space-y-1.5">
          <ul className={cn(PANE, "space-y-2.5 p-3")}>
            {results.map((item, index) => {
              const href = safeHttpUrl(item.url);
              return (
                <li key={`${item.url}-${index}`} className="min-w-0">
                  <SafeLink href={href} className="font-medium">
                    {item.title || item.url || "Untitled"}
                  </SafeLink>
                  {item.url ? <p className="truncate text-muted-foreground">{shortUrl(item.url)}</p> : null}
                  {item.content ? <p className="line-clamp-3 break-words">{plainSnippet(item.content)}</p> : null}
                </li>
              );
            })}
          </ul>
          <TruncatedNote show={tool.resultTruncated} />
        </div>
      );
    }

    case "tavily-extract": {
      const pages = parseTavilyResults(result);
      if (!pages) break;
      if (!pages.length) return <Note>Nothing could be extracted.</Note>;
      return (
        <div className="space-y-2">
          {pages.map((page, index) => (
            <div key={`${page.url}-${index}`} className="space-y-1">
              <SafeLink href={safeHttpUrl(page.url)} className="font-medium text-xs">
                {page.title || page.url || "Untitled"}
              </SafeLink>
              {page.content ? (
                <div className={cn(PANE, "p-3")}>
                  <UntrustedMarkdown content={page.content} />
                </div>
              ) : (
                <Note>No content.</Note>
              )}
            </div>
          ))}
          <TruncatedNote show={tool.resultTruncated} />
        </div>
      );
    }

    case "tavily-crawl":
    case "tavily-map": {
      const crawl = parseTavilyPages(result);
      if (!crawl) break;
      if (!crawl.pages.length) return <Note>No pages found.</Note>;
      return (
        <div className="space-y-1.5">
          <ul className={cn(PANE, "space-y-1 p-2")}>
            {crawl.pages.map((page, index) => (
              <li key={`${page.url}-${index}`} className="min-w-0">
                {page.content ? (
                  <details>
                    <summary className="cursor-pointer truncate">
                      <SafeLink href={safeHttpUrl(page.url)}>{shortUrl(page.url)}</SafeLink>
                    </summary>
                    <p className="mt-1 line-clamp-6 whitespace-pre-wrap break-words pl-4 text-muted-foreground">
                      {page.content}
                    </p>
                  </details>
                ) : (
                  <SafeLink href={safeHttpUrl(page.url)} className="block truncate">
                    {shortUrl(page.url)}
                  </SafeLink>
                )}
              </li>
            ))}
          </ul>
          <TruncatedNote show={tool.resultTruncated} />
        </div>
      );
    }

    case "search_papers":
    case "list_papers": {
      const papers = parsePapers(result);
      if (!papers) break;
      if (!papers.length) return <Note>No papers found.</Note>;
      return (
        <div className="space-y-1.5">
          <ul className={cn(PANE, "space-y-3 p-3")}>
            {papers.map((paper, index) => (
              <li key={`${paper.id ?? paper.title}-${index}`} className="min-w-0 space-y-0.5">
                <SafeLink href={paper.url} className="font-medium">
                  {paper.title || paper.id || "Untitled paper"}
                </SafeLink>
                <p className="text-muted-foreground">
                  {[authorLine(paper.authors), paper.published].filter(Boolean).join(" · ")}
                </p>
                {paper.categories.length ? (
                  <p className="flex flex-wrap gap-1">
                    {paper.categories.map((category) => (
                      <span key={category} className="rounded bg-background/60 px-1.5 py-0.5 font-mono">
                        {category}
                      </span>
                    ))}
                  </p>
                ) : null}
                {paper.abstract ? <p className="line-clamp-3 break-words">{paper.abstract}</p> : null}
              </li>
            ))}
          </ul>
          <TruncatedNote show={tool.resultTruncated} />
        </div>
      );
    }

    case "download_paper": {
      const download = parseDownload(result);
      if (!download) break;
      const ok = download.status === "success";
      const pending = download.status === "converting" || download.status === "downloading";
      const Icon = ok ? CheckCircle2 : pending ? Loader2 : TriangleAlert;
      return (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span
            className={cn(
              "flex items-center gap-1.5",
              ok ? "text-success" : pending ? "text-muted-foreground" : "text-amber-600 dark:text-amber-500",
            )}
          >
            <Icon className="size-3.5 shrink-0" aria-hidden />
            {download.message || download.status}
          </span>
          {download.pdf ? (
            <SafeLink href={download.pdf} className="flex items-center gap-1">
              PDF <ExternalLink className="size-3" aria-hidden />
            </SafeLink>
          ) : null}
        </div>
      );
    }

    case "read_paper": {
      const paper = parsePaperContent(result);
      if (!paper) break;
      if (paper.status !== "success" || !paper.content) {
        return <Note tone="warn">{extractMessage(result) ?? `Status: ${paper.status}`}</Note>;
      }
      return (
        <div className="space-y-1.5">
          <div className={cn(PANE, "p-3")}>
            <UntrustedMarkdown content={paper.content} />
          </div>
          <TruncatedNote show={tool.resultTruncated} />
        </div>
      );
    }

    default: {
      // Any other MCP tool: JSON as a readable tree, text as-is.
      const json = parseJson(result);
      if (json && typeof json === "object") {
        return (
          <div className="space-y-1.5">
            <div className={cn(PANE, "p-3")}>
              <JsonTree value={json} />
            </div>
            <TruncatedNote show={tool.resultTruncated} />
          </div>
        );
      }
      return generic;
    }
  }
  return generic;
};
