import type { BundledLanguage } from "shiki";

import { toolLabel } from "@/shared/lib/consts";

import { mcpMeta, mcpToolTitle } from "./mcpToolPresentation";

/**
 * What a tool step says about itself in the chain of thought.
 *
 * A step used to be titled with the raw tool name (`read_file`) and to show two
 * panes — the JSON arguments and the raw result. Most of that is noise: what a
 * reader wants is "Read report.csv", and the content in its natural form. This
 * module turns a call's arguments and result into that: a title, a short meta
 * note, and the parsed shapes the step's panes render. Pure functions only — the
 * rendering lives in `message_parts/ToolCallViews.tsx`.
 *
 * Every parser is tolerant by design: a tool result is semi-trusted text that
 * may be truncated, an error, or a format a newer tool version changed. Anything
 * not recognised yields `null`, and the caller falls back to the generic view.
 */

export type ToolArgs = Record<string, unknown>;

/** The parsed arguments as an object, or null while they stream / if malformed. */
export const asToolArgs = (args: unknown): ToolArgs | null =>
  args && typeof args === "object" && !Array.isArray(args) ? (args as ToolArgs) : null;

const str = (args: ToolArgs | null, key: string): string =>
  typeof args?.[key] === "string" ? (args[key] as string) : "";

/** Last path segment: `/conversation/input/image.png` → `image.png`. */
export const basename = (path: string): string => {
  const trimmed = path.replace(/\/+$/, "");
  const name = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return name || path || "/";
};

/** A directory shown without its leading/trailing slashes; the root stays `/`. */
const displayDir = (path: string): string => path.replace(/^\/+|\/+$/g, "") || "/";

const clip = (text: string, max = 60): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

// ---------------------------------------------------------------------------
// MCP tools — titles, meta and views live in mcpToolPresentation.ts
// ---------------------------------------------------------------------------

/**
 * Whether a step is an MCP tool. MCP tools arrive under bare names
 * (`tavily-search`); the tool catalog supplies their `serverId`. A
 * `server/tool` name also counts, for a catalog that is not loaded yet.
 */
export const isMcpTool = (name: string, serverId?: string): boolean =>
  Boolean(serverId) || name.includes("/");

// ---------------------------------------------------------------------------
// Titles
// ---------------------------------------------------------------------------

const TITLES: Record<string, (args: ToolArgs | null) => string | null> = {
  read_file: (a) => (str(a, "file_path") ? `Read ${basename(str(a, "file_path"))}` : null),
  ls: (a) => `List ${displayDir(str(a, "path") || "/")}`,
  glob: (a) => (str(a, "pattern") ? `Find ${str(a, "pattern")}` : null),
  grep: (a) => {
    const pattern = str(a, "pattern");
    if (!pattern) return null;
    const path = str(a, "path");
    return `Search "${clip(pattern, 40)}"${path ? ` in ${displayDir(path)}` : ""}`;
  },
  write_file: (a) => (str(a, "file_path") ? `Write ${basename(str(a, "file_path"))}` : null),
  edit_file: (a) => (str(a, "file_path") ? `Edit ${basename(str(a, "file_path"))}` : null),
  execute: (a) => (str(a, "command") ? `Run ${clip(str(a, "command"))}` : null),
  remember: (a) => (str(a, "name") ? `Remembered "${str(a, "name")}"` : null),
  forget: (a) => (str(a, "name") ? `Forgot "${str(a, "name")}"` : null),
  search_past_conversations: (a) =>
    str(a, "query") ? `Searched past chats for "${clip(str(a, "query"), 50)}"` : null,
  view_image: (a) => (str(a, "path") ? `View ${basename(str(a, "path"))}` : null),
  create_skill: (a) => (str(a, "name") ? `Created skill "${str(a, "name")}"` : null),
};

/** The step's title: built from its arguments where we know the tool. */
export const toolTitle = (name: string, args: unknown, serverId?: string): string => {
  if (isMcpTool(name, serverId)) return mcpToolTitle(name, serverId);
  return TITLES[name]?.(asToolArgs(args)) || toolLabel(name);
};

/** Full path (or pattern) for the title's hover text, where it was shortened. */
export const toolTitleHint = (name: string, args: unknown): string | undefined => {
  const a = asToolArgs(args);
  const path = str(a, "file_path") || str(a, "path");
  if (path) return path;
  if (name === "execute") return str(a, "command") || undefined;
  return undefined;
};

/**
 * Restore line breaks a model escaped twice (a literal backslash + `n` where a
 * line break belongs),
 * but only in text with no real line break — the same narrow rule the agents
 * service applies before saving (harness/tools/text_args.py), so an approval
 * preview shows exactly what will be stored. Used for prose fields only (a
 * skill's instructions, a memory's text), never for file contents.
 */
export const undoDoubleEscaping = (text: string): string => {
  if (text.includes("\n") || !text.includes("\\n")) return text;
  // split/join rather than replaceAll: the project targets ES2020.
  return text
    .split("\\r\\n")
    .join("\n")
    .split("\\n")
    .join("\n")
    .split("\\t")
    .join("\t")
    .split('\\"')
    .join('"');
};

// ---------------------------------------------------------------------------
// Result parsers
// ---------------------------------------------------------------------------

/**
 * `ls` / `glob` results are a Python list repr (`['/a', '/b']`). Returns the
 * paths, plus any trailing non-path entry (the truncation notice) as `note`.
 */
export const parsePathList = (result: string | undefined): { paths: string[]; note?: string } | null => {
  const text = result?.trim();
  if (!text || !text.startsWith("[") || !text.endsWith("]")) return null;
  let items: string[] = [];
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) items = parsed.filter((item): item is string => typeof item === "string");
  } catch {
    const quoted = /'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"/g;
    for (let match = quoted.exec(text); match; match = quoted.exec(text)) {
      items.push((match[1] ?? match[2]).replace(/\\(.)/g, "$1"));
    }
    if (items.length === 0 && text !== "[]") return null;
  }
  const paths = items.filter((item) => item.startsWith("/"));
  const note = items.find((item) => !item.startsWith("/"));
  return note ? { paths, note } : { paths };
};

export type GrepResult =
  | { mode: "files"; files: string[] }
  | { mode: "count"; counts: { path: string; count: number }[] }
  | { mode: "content"; files: { path: string; lines: { line: string; text: string }[] }[] };

/** `grep` output in its three `output_mode`s; `null` if not recognised. */
export const parseGrep = (result: string | undefined, outputMode: unknown): GrepResult | null => {
  const text = result?.trim();
  if (!text) return null;
  if (text === "No matches found") {
    return outputMode === "content" ? { mode: "content", files: [] } : { mode: "files", files: [] };
  }
  const lines = text.split("\n");
  if (outputMode === "count") {
    const counts = lines
      .map((line) => /^(\/.*):\s*(\d+)$/.exec(line))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => ({ path: m[1], count: Number(m[2]) }));
    return counts.length ? { mode: "count", counts } : null;
  }
  if (outputMode === "content") {
    const files: { path: string; lines: { line: string; text: string }[] }[] = [];
    for (const line of lines) {
      const header = /^(\/.*):$/.exec(line);
      const hit = /^\s+(\d+):\s?(.*)$/.exec(line);
      if (header) files.push({ path: header[1], lines: [] });
      else if (hit && files.length) files[files.length - 1].lines.push({ line: hit[1], text: hit[2] });
    }
    return files.length ? { mode: "content", files } : null;
  }
  const files = lines.filter((line) => line.startsWith("/"));
  return files.length ? { mode: "files", files } : null;
};

/**
 * `read_file` text is `cat -n` style (`     5\tline`, long lines continued as
 * `5.1`). Returns the code without numbers, its line range and any trailing
 * notice; `null` for anything else (an image block, an error, an empty file).
 */
export const parseNumberedFile = (
  result: string | undefined,
): { code: string; first: number; last: number; note?: string } | null => {
  if (!result) return null;
  const code: string[] = [];
  const notes: string[] = [];
  let first = 0;
  let last = 0;
  for (const line of result.split("\n")) {
    const match = /^\s*(\d+)(?:\.\d+)?\t(.*)$/.exec(line);
    if (!match) {
      if (code.length) notes.push(line);
      continue;
    }
    const [, num, text] = match;
    if (line.trimStart().startsWith(`${num}.`)) {
      // A continuation chunk of the previous long line.
      code[code.length - 1] = `${code[code.length - 1] ?? ""}${text}`;
      continue;
    }
    if (!first) first = Number(num);
    last = Number(num);
    code.push(text);
  }
  if (!code.length) return null;
  const note = notes.join("\n").trim();
  return note ? { code: code.join("\n"), first, last, note } : { code: code.join("\n"), first, last };
};

/** `execute` output with its trailing `[Command … with exit code N]` split off. */
export const parseCommandOutput = (result: string | undefined): { output: string; exitCode?: number } | null => {
  if (result === undefined) return null;
  const match = /\n?\[Command (?:succeeded|failed) with exit code (-?\d+)\]\s*$/.exec(result);
  if (!match) return { output: result };
  return { output: result.slice(0, match.index), exitCode: Number(match[1]) };
};

export type PastChatHit = { header: string; snippet: string };

/** `search_past_conversations` lines: `- [Title · User · created 2026-09-01] text`. */
export const parsePastChats = (result: string | undefined): PastChatHit[] | null => {
  if (!result) return null;
  if (result.trim() === "No relevant past messages found.") return [];
  const hits = result
    .split("\n")
    .map((line) => /^- \[([^\]]*)\]\s?(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ header: m[1], snippet: m[2] }));
  return hits.length ? hits : null;
};

/**
 * Whether a write-style tool's result is its routine success message — the
 * title already says it, so only anything else (a failure explained in prose)
 * is worth showing.
 */
const SUCCESS_PREFIXES: Record<string, string[]> = {
  write_file: ["Updated file "],
  edit_file: ["Successfully replaced "],
  remember: ["Saved memory "],
  forget: ["Forgot memory "],
  create_skill: ["Created skill "],
};

export const isRoutineSuccess = (name: string, result: string | undefined): boolean => {
  const text = result?.trim() ?? "";
  if (name === "create_skill" && text.includes("could not enable it")) return false;
  return (SUCCESS_PREFIXES[name] ?? []).some((prefix) => text.startsWith(prefix));
};

// ---------------------------------------------------------------------------
// Meta (the muted note after the title)
// ---------------------------------------------------------------------------

const plural = (count: number, one: string, many = `${one}s`): string =>
  `${count} ${count === 1 ? one : many}`;

/** Short facts for the title row: line range, match counts, replacements. */
export const toolMeta = (
  name: string,
  args: unknown,
  result: string | undefined,
  serverId?: string,
): string | undefined => {
  const a = asToolArgs(args);
  if (isMcpTool(name, serverId)) return mcpMeta(name, a, result);
  switch (name) {
    case "read_file": {
      const file = parseNumberedFile(result);
      return file ? `lines ${file.first}–${file.last}` : undefined;
    }
    case "ls": {
      const list = parsePathList(result);
      return list ? plural(list.paths.length, "item") : undefined;
    }
    case "glob": {
      const list = parsePathList(result);
      return list ? plural(list.paths.length, "file") : undefined;
    }
    case "grep": {
      const grep = parseGrep(result, a?.output_mode);
      if (!grep) return undefined;
      if (grep.mode === "files") return plural(grep.files.length, "file");
      if (grep.mode === "count") return plural(grep.counts.reduce((n, c) => n + c.count, 0), "match", "matches");
      return plural(grep.files.reduce((n, f) => n + f.lines.length, 0), "match", "matches");
    }
    case "edit_file":
      return a?.replace_all === true ? "all occurrences" : undefined;
    case "execute": {
      const out = parseCommandOutput(result);
      return out?.exitCode !== undefined ? `exit ${out.exitCode}` : undefined;
    }
    case "search_past_conversations": {
      const hits = parsePastChats(result);
      return hits ? plural(hits.length, "match", "matches") : undefined;
    }
    case "view_image": {
      const region = asToolArgs(a?.region);
      return region && typeof region.width === "number" && typeof region.height === "number"
        ? `region ${region.width}×${region.height}`
        : undefined;
    }
    default:
      return undefined;
  }
};

// ---------------------------------------------------------------------------
// Syntax highlighting by file extension
// ---------------------------------------------------------------------------

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  py: "python",
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  json: "json",
  md: "markdown",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  sh: "bash",
  bash: "bash",
  sql: "sql",
  html: "html",
  css: "css",
  csv: "csv",
  xml: "xml",
  dockerfile: "dockerfile",
};

/** Highlighter language for a path; unknown types render as plain text. */
export const languageForPath = (path: string): BundledLanguage => {
  const name = basename(path).toLowerCase();
  const ext = name === "dockerfile" ? "dockerfile" : name.slice(name.lastIndexOf(".") + 1);
  // CodeBlock falls back to plain text for anything its highlighter lacks.
  return (LANGUAGE_BY_EXTENSION[ext] ?? "text") as BundledLanguage;
};
