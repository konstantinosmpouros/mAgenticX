/**
 * The body of a tool step in the chain of thought: one pane for what the tool
 * was asked to do, one for what came back — each in the form that tool's
 * content naturally takes, and only where it adds something.
 *
 * Custom rather than the generic `ToolInput` / `ToolOutput` pair because those
 * show everything as JSON: a file the agent wrote arrives as one string full of
 * `\n` escapes, an `ls` as a Python list, a successful write as a sentence the
 * title already said. Parsing and titles live in `lib/toolPresentation.ts`; this
 * file only decides what to draw.
 *
 * Fallbacks keep it safe: a failed call, arguments still streaming, or a result
 * the parser does not recognise all render through the generic components, so a
 * tool change upstream degrades to the old view, never to a blank step.
 */
import { File, Folder } from "lucide-react";
import type { BundledLanguage } from "shiki";

import { MarkdownRenderer } from "@/shared/ui/markdownRenderer";
import { CodeBlock } from "@/shared/ui/ai-elements/code-block";
import { PAYLOAD_PANE, ToolInput, ToolOutput } from "@/shared/ui/ai-elements/tool";
import { toolIsBare } from "@/shared/lib/consts";
import { parseToolResultImages } from "@/shared/lib/schemas";
import { cn } from "@/shared/lib/utils";
import type { TimelineToolExecution } from "@/shared/lib/types";
import {
  asToolArgs,
  isMcpTool,
  isRoutineSuccess,
  languageForPath,
  parseCommandOutput,
  parseGrep,
  parseNumberedFile,
  parsePastChats,
  parsePathList,
  type ToolArgs,
  undoDoubleEscaping,
} from "@/features/chat/lib/toolPresentation";
import { McpResultView } from "./McpToolViews";

// `text-foreground` resets the colour: a step waiting for approval tints its
// whole row amber, and that must not bleed into the content panes.
const PANE = cn("min-w-0 rounded-md bg-muted/50 text-foreground text-xs", PAYLOAD_PANE);
// Markdown inside a tool pane is a preview, not a page: keep headings small.
const COMPACT_MARKDOWN =
  "text-xs [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-xs [&_h4]:text-xs [&_:is(h1,h2,h3,h4)]:font-semibold [&_:is(h1,h2,h3,h4)]:mb-1 [&_:is(h1,h2,h3,h4)]:mt-2";
const CODE = "[&_pre]:whitespace-pre-wrap [&_pre]:break-words";

const text = (args: ToolArgs, key: string): string =>
  typeof args[key] === "string" ? (args[key] as string) : "";

const Note = ({ children, tone = "muted" }: { children: string; tone?: "muted" | "warn" }) => (
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

const CodePane = ({ code, language }: { code: string; language: BundledLanguage }) => (
  <div className={PANE}>
    <CodeBlock className={CODE} code={code} language={language} />
  </div>
);

const PathList = ({ paths }: { paths: string[] }) => (
  <ul className={cn(PANE, "space-y-0.5 p-2 font-mono")}>
    {paths.map((path) => {
      const isDir = path.endsWith("/");
      const Icon = isDir ? Folder : File;
      return (
        <li key={path} className="flex min-w-0 items-center gap-2">
          <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate" title={path}>
            {path}
          </span>
        </li>
      );
    })}
  </ul>
);

/** `- old` / `+ new` lines, highlighted by the diff grammar. */
const toDiff = (oldText: string, newText: string): string =>
  [
    ...oldText.split("\n").map((line) => `- ${line}`),
    ...newText.split("\n").map((line) => `+ ${line}`),
  ].join("\n");

/** Whether this step should render through the generic JSON components. */
const isGenericStep = (tool: TimelineToolExecution, args: ToolArgs | null): boolean =>
  tool.state === "output-error" || args === null;

// ---------------------------------------------------------------------------
// What the tool was asked to do
// ---------------------------------------------------------------------------

export const ToolCallArgsView = ({
  tool,
  args: rawArgs,
  serverId,
}: {
  tool: TimelineToolExecution;
  args: unknown;
  /** From the tool catalog; set for MCP tools. */
  serverId?: string;
}) => {
  const args = asToolArgs(rawArgs);
  if (isGenericStep(tool, args)) {
    return rawArgs !== null && rawArgs !== undefined && !toolIsBare(tool.name) ? <ToolInput input={rawArgs} /> : null;
  }
  const a = args as ToolArgs;
  // MCP: the title + meta say it (query, URL, paper id); no arguments pane.
  if (isMcpTool(tool.name, serverId)) return null;

  switch (tool.name) {
    // The title says it all; the arguments are noise.
    case "read_file":
    case "ls":
    case "glob":
    case "grep":
    case "forget":
    case "search_past_conversations":
    case "view_image":
      return null;

    case "write_file": {
      const content = text(a, "content");
      return content ? <CodePane code={content} language={languageForPath(text(a, "file_path"))} /> : null;
    }

    case "edit_file":
      return <CodePane code={toDiff(text(a, "old_string"), text(a, "new_string"))} language="diff" />;

    case "execute":
      return text(a, "command") ? <CodePane code={text(a, "command")} language="bash" /> : null;

    case "remember":
      return (
        <div className="space-y-1.5">
          {text(a, "summary") ? <Note>{undoDoubleEscaping(text(a, "summary"))}</Note> : null}
          {text(a, "content") ? (
            <div className={cn(PANE, "p-3")}>
              <MarkdownRenderer className={COMPACT_MARKDOWN} content={undoDoubleEscaping(text(a, "content"))} />
            </div>
          ) : null}
        </div>
      );

    case "create_skill": {
      const files = Array.isArray(a.files)
        ? a.files
            .map((file) => asToolArgs(file))
            .filter((file): file is ToolArgs => file !== null)
            .map((file) => text(file, "path"))
            .filter(Boolean)
        : [];
      return (
        <div className="space-y-1.5">
          {text(a, "description") ? <Note>{text(a, "description")}</Note> : null}
          {text(a, "instructions") ? (
            <div className={cn(PANE, "p-3")}>
              <MarkdownRenderer className={COMPACT_MARKDOWN} content={undoDoubleEscaping(text(a, "instructions"))} />
            </div>
          ) : null}
          {files.length ? <PathList paths={files} /> : null}
        </div>
      );
    }

    default:
      return toolIsBare(tool.name) ? null : <ToolInput input={a} />;
  }
};

// ---------------------------------------------------------------------------
// What came back
// ---------------------------------------------------------------------------

export const ToolCallResultView = ({
  tool,
  args: rawArgs,
  serverId,
}: {
  tool: TimelineToolExecution;
  args: unknown;
  serverId?: string;
}) => {
  const args = asToolArgs(rawArgs);
  const result = tool.result;
  const generic = (
    <ToolOutput output={result} truncated={tool.resultTruncated} bare={toolIsBare(tool.name)} />
  );
  if (isGenericStep(tool, args) || result === undefined) return result === undefined ? null : generic;
  const a = args as ToolArgs;
  if (isMcpTool(tool.name, serverId)) return <McpResultView tool={tool} />;

  switch (tool.name) {
    case "read_file": {
      // An image read is shown as the image alone.
      if (parseToolResultImages(result).length > 0) return <ToolOutput output={result} bare />;
      const file = parseNumberedFile(result);
      if (!file) return generic;
      return (
        <div className="space-y-1.5">
          <CodePane code={file.code} language={languageForPath(text(a, "file_path"))} />
          {file.note ? <Note>{file.note}</Note> : null}
          <TruncatedNote show={tool.resultTruncated} />
        </div>
      );
    }

    case "ls":
    case "glob": {
      const list = parsePathList(result);
      if (!list) return generic;
      return (
        <div className="space-y-1.5">
          {list.paths.length ? (
            <PathList paths={list.paths} />
          ) : (
            <Note>{tool.name === "ls" ? "Empty directory." : "No files found."}</Note>
          )}
          {list.note ? <Note>{list.note}</Note> : null}
          <TruncatedNote show={tool.resultTruncated} />
        </div>
      );
    }

    case "grep": {
      const grep = parseGrep(result, a.output_mode);
      if (!grep) return generic;
      if (grep.mode === "files") {
        return grep.files.length ? <PathList paths={grep.files} /> : <Note>No matches.</Note>;
      }
      if (grep.mode === "count") {
        return (
          <ul className={cn(PANE, "space-y-0.5 p-2 font-mono")}>
            {grep.counts.map(({ path, count }) => (
              <li key={path} className="flex min-w-0 justify-between gap-3">
                <span className="truncate" title={path}>
                  {path}
                </span>
                <span className="shrink-0 text-muted-foreground tabular-nums">{count}</span>
              </li>
            ))}
          </ul>
        );
      }
      if (!grep.files.length) return <Note>No matches.</Note>;
      return (
        <div className={cn(PANE, "space-y-2 p-2 font-mono")}>
          {grep.files.map((file) => (
            <div key={file.path} className="min-w-0">
              <p className="truncate font-medium" title={file.path}>
                {file.path}
              </p>
              {file.lines.map((hit) => (
                <p key={`${file.path}:${hit.line}`} className="flex gap-3 break-words">
                  <span className="w-8 shrink-0 text-right text-muted-foreground tabular-nums">{hit.line}</span>
                  <span className="min-w-0 whitespace-pre-wrap">{hit.text}</span>
                </p>
              ))}
            </div>
          ))}
        </div>
      );
    }

    case "execute": {
      const out = parseCommandOutput(result);
      if (!out) return generic;
      return (
        <div className="space-y-1.5">
          <pre className={cn(PANE, "m-0 whitespace-pre-wrap break-words p-3 font-mono")}>
            {out.output.trim() || "(no output)"}
          </pre>
          <TruncatedNote show={tool.resultTruncated} />
        </div>
      );
    }

    case "search_past_conversations": {
      const hits = parsePastChats(result);
      if (!hits) return generic;
      if (!hits.length) return <Note>No matching past messages.</Note>;
      return (
        <ul className={cn(PANE, "space-y-2 p-2")}>
          {hits.map((hit, index) => (
            <li key={`${hit.header}-${index}`} className="min-w-0">
              <p className="truncate text-muted-foreground">{hit.header}</p>
              <p className="line-clamp-3 break-words">{hit.snippet}</p>
            </li>
          ))}
        </ul>
      );
    }

    // Writes and memory: the title already says it succeeded. Anything else —
    // a refusal, a partial outcome — is prose worth one line.
    case "write_file":
    case "edit_file":
    case "remember":
    case "forget":
    case "create_skill":
      return isRoutineSuccess(tool.name, result) ? null : <Note tone="warn">{result}</Note>;

    default:
      return generic;
  }
};
