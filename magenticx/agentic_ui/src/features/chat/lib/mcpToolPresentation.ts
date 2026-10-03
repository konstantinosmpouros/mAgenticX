/**
 * Titles, meta notes and result parsers for MCP tools (Tavily, arXiv, …).
 *
 * MCP tools reach the UI under their bare names (`tavily-search`,
 * `read_paper`); which server a name belongs to comes from the tool catalog the
 * workspace already loads (`ToolMetadata.serverId`). With it, every MCP step is
 * titled **Server · Tool** and gets a view for its content: result cards for a
 * web search, paper cards for arXiv, the paper itself as Markdown.
 *
 * Everything here reads semi-trusted, possibly truncated text. The bridge cuts a
 * stored tool result at 16,000 characters, which leaves JSON unterminated — so
 * the JSON readers salvage what decodes rather than give up, and every parser
 * returns `null` for a shape it does not recognise so the step falls back to the
 * generic view. Pure functions only; rendering is `message_parts/McpToolViews.tsx`.
 */

export type ToolArgs = Record<string, unknown>;

const str = (args: ToolArgs | null, key: string): string =>
  typeof args?.[key] === "string" ? (args[key] as string) : "";

const clip = (text: string, max = 50): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

const plural = (count: number, one: string, many = `${one}s`): string =>
  `${count} ${count === 1 ? one : many}`;

/** Wrap a query in quotes — unless it carries its own (`"a" OR "b"`). */
const quoted = (text: string): string => (/["“”]/.test(text) ? text : `"${text}"`);

// ---------------------------------------------------------------------------
// Server · Tool
// ---------------------------------------------------------------------------

/** Brand spellings a plain capitalise would get wrong. */
const SERVER_NAMES: Record<string, string> = { arxiv: "arXiv", tavily: "Tavily" };

const capitalise = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `arxiv-mcp-server` → `arXiv`, `brave` → `Brave`. */
export const mcpServerTitle = (serverId: string): string => {
  const base = serverId.replace(/[-_]?mcp([-_]server)?$/i, "").replace(/^mcp[-_]/i, "") || serverId;
  return SERVER_NAMES[base.toLowerCase()] ?? capitalise(base);
};

/**
 * `tavily-search` on `tavily` → `Tavily · Search`; `search_papers` on `arxiv`
 * → `arXiv · Search papers`. Also accepts a `server/tool` name with no server
 * id. A tool name repeating its server drops the prefix.
 */
export const mcpToolTitle = (name: string, serverId?: string): string => {
  let server = serverId ?? "";
  let tool = name;
  if (!server && name.includes("/")) {
    server = name.slice(0, name.indexOf("/"));
    tool = name.slice(name.indexOf("/") + 1);
  }
  const base = server.replace(/[-_]?mcp([-_]server)?$/i, "");
  tool = tool
    .replace(new RegExp(`^${escapeRegExp(base)}[-_]`, "i"), "")
    .replace(/[-_]+/g, " ")
    .trim();
  const serverTitle = server ? mcpServerTitle(server) : "";
  if (!serverTitle) return capitalise(tool);
  return tool ? `${serverTitle} · ${capitalise(tool)}` : serverTitle;
};

// ---------------------------------------------------------------------------
// Links and hosts
// ---------------------------------------------------------------------------

/** The URL if it is http(s) — anything else (javascript:, file:, data:) is refused. */
export const safeHttpUrl = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
};

/** `https://docs.python.org/3/` → `docs.python.org/3`. */
export const shortUrl = (value: string): string => {
  try {
    const url = new URL(value);
    return `${url.host}${url.pathname}`.replace(/\/+$/, "");
  } catch {
    return value;
  }
};

/** An arXiv PDF link as its abstract page, the better landing for a reader. */
export const arxivAbsUrl = (value: unknown): string | null => {
  const safe = safeHttpUrl(value);
  return safe ? safe.replace("/pdf/", "/abs/").replace(/\.pdf$/, "") : null;
};

// ---------------------------------------------------------------------------
// Tolerant JSON (results cut at 16,000 characters)
// ---------------------------------------------------------------------------

/** Parse JSON, or return null. */
export const parseJson = (text: string | undefined): unknown => {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/**
 * `{"total": 3, "papers": [ {...}, {...}, {…cut` → the complete objects in the
 * array named `key`. Tries closing the array after each `}` from the end,
 * bounded so a pathological input cannot spin.
 */
export const salvageJsonArray = (text: string | undefined, key: string): Record<string, unknown>[] | null => {
  if (!text) return null;
  const whole = parseJson(text);
  if (whole && typeof whole === "object" && Array.isArray((whole as Record<string, unknown>)[key])) {
    return ((whole as Record<string, unknown>)[key] as unknown[]).filter(
      (item): item is Record<string, unknown> => !!item && typeof item === "object",
    );
  }
  if (!text.includes(`"${key}"`)) return null;
  let end = text.length;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    end = text.lastIndexOf("}", end - 1);
    if (end < 0) break;
    const candidate = parseJson(`${text.slice(0, end + 1)}]}`);
    if (candidate && typeof candidate === "object" && Array.isArray((candidate as Record<string, unknown>)[key])) {
      return (candidate as Record<string, unknown>)[key] as Record<string, unknown>[];
    }
  }
  return null;
};

/**
 * The string value of `"field": "…"` in possibly-truncated JSON, decoded
 * (so `\n` becomes a line break and `∗` a ∗). Returns null if absent.
 */
export const extractJsonString = (text: string | undefined, field: string): string | null => {
  if (!text) return null;
  const whole = parseJson(text);
  if (whole && typeof whole === "object") {
    const value = (whole as Record<string, unknown>)[field];
    return typeof value === "string" ? value : null;
  }
  const marker = new RegExp(`"${escapeRegExp(field)}"\\s*:\\s*"`).exec(text);
  if (!marker) return null;
  let raw = text.slice(marker.index + marker[0].length);
  // Stop at the closing quote if the value was not cut.
  const close = /(?<!\\)(?:\\\\)*"/.exec(raw);
  if (close) raw = raw.slice(0, close.index + close[0].length - 1);
  // Drop a dangling escape the cut left behind (`\`, `\u12`).
  raw = raw.replace(/\\u[0-9a-fA-F]{0,3}$/, "").replace(/(?<!\\)(\\\\)*\\$/, "$1");
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw.replace(/\\n/g, "\n").replace(/\\"/g, '"');
  }
};

/** The top-level `status` / `message` of a JSON result, also when cut. */
const jsonField = (text: string | undefined, field: string): string | null => extractJsonString(text, field);

// ---------------------------------------------------------------------------
// Tavily
// ---------------------------------------------------------------------------

export type WebResult = { title?: string; url?: string; content?: string };

/**
 * `tavily-search` / `tavily-extract`: `Title: … / URL: … / Content: … /
 * Raw Content: …` blocks under a `Detailed Results:` heading. Content runs over
 * many lines until the next `Title:`; `Content: undefined` (extract) is dropped
 * in favour of `Raw Content`.
 */
export const parseTavilyResults = (result: string | undefined): WebResult[] | null => {
  if (!result || !/^Title: /m.test(result)) return null;
  const items: (WebResult & { raw?: string })[] = [];
  let field: "content" | "raw" | null = null;
  for (const line of result.split("\n")) {
    const title = /^Title: (.*)$/.exec(line);
    const url = /^URL: (.*)$/.exec(line);
    const content = /^Content: (.*)$/.exec(line);
    const raw = /^Raw Content: (.*)$/.exec(line);
    if (title) {
      items.push({ title: title[1].trim() });
      field = null;
    } else if (!items.length) {
      continue;
    } else if (url && !field) {
      items[items.length - 1].url = url[1].trim();
    } else if (content) {
      items[items.length - 1].content = content[1];
      field = "content";
    } else if (raw) {
      items[items.length - 1].raw = raw[1];
      field = "raw";
    } else if (field) {
      const item = items[items.length - 1];
      item[field] = `${item[field] ?? ""}\n${line}`;
    }
  }
  return items.map(({ raw, content, ...rest }) => {
    const body = content && content.trim() !== "undefined" ? content : raw;
    return { ...rest, content: body?.trim() || undefined };
  });
};

export type WebPage = { url: string; content?: string };

/**
 * `tavily-crawl` (`[1] URL: … / Content: …`) and `tavily-map` (URLs under
 * `Mapped Pages:`). Bare URL lines and `[n] URL:` lines are both accepted.
 */
export const parseTavilyPages = (result: string | undefined): { base?: string; pages: WebPage[] } | null => {
  if (!result || !/^(Crawl|Site Map) Results:/.test(result.trim())) return null;
  const base = /^Base URL: (.*)$/m.exec(result)?.[1]?.trim();
  const pages: WebPage[] = [];
  let inContent = false;
  for (const line of result.split("\n")) {
    const numbered = /^\[\d+\] URL: (.*)$/.exec(line);
    const bare = /^(?:- )?(https?:\/\/\S+)$/.exec(line.trim());
    const content = /^Content: (.*)$/.exec(line);
    if (numbered || (bare && !inContent)) {
      pages.push({ url: (numbered?.[1] ?? bare?.[1] ?? "").trim() });
      inContent = false;
    } else if (content && pages.length) {
      pages[pages.length - 1].content = content[1];
      inContent = true;
    } else if (inContent && pages.length) {
      const page = pages[pages.length - 1];
      page.content = `${page.content ?? ""}\n${line}`;
    }
  }
  return { base, pages: pages.map((page) => ({ ...page, content: page.content?.trim() || undefined })) };
};

/** Markdown / whitespace stripped for a one-glance snippet. */
export const plainSnippet = (text: string | undefined): string =>
  (text ?? "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#*_`>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();

// ---------------------------------------------------------------------------
// arXiv
// ---------------------------------------------------------------------------

export type Paper = {
  id?: string;
  title?: string;
  authors: string[];
  abstract?: string;
  categories: string[];
  published?: string;
  url: string | null;
};

const toPaper = (raw: Record<string, unknown>): Paper => {
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  const links = strings(raw.links);
  return {
    id: typeof raw.id === "string" ? raw.id : undefined,
    title: typeof raw.title === "string" ? raw.title : undefined,
    authors: strings(raw.authors),
    abstract:
      typeof raw.abstract === "string" ? raw.abstract : typeof raw.summary === "string" ? raw.summary : undefined,
    categories: strings(raw.categories),
    published: typeof raw.published === "string" ? raw.published.slice(0, 10) : undefined,
    url: arxivAbsUrl(raw.url ?? raw.pdf_url ?? links[0]),
  };
};

/** `search_papers` / `list_papers`: the `papers` array, salvaged if cut. */
export const parsePapers = (result: string | undefined): Paper[] | null => {
  const papers = salvageJsonArray(result, "papers");
  return papers ? papers.map(toPaper) : null;
};

/** "Ashish Vaswani, Noam Shazeer, Niki Parmar et al." */
export const authorLine = (authors: string[]): string =>
  authors.length > 3 ? `${authors.slice(0, 3).join(", ")} et al.` : authors.join(", ");

/** `download_paper`: status, message and the PDF link — never the gateway's file path. */
export const parseDownload = (
  result: string | undefined,
): { status: string; message: string; pdf: string | null } | null => {
  const status = jsonField(result, "status");
  if (!status) return null;
  const pdf = safeHttpUrl(jsonField(result, "pdf_uri"));
  return { status, message: jsonField(result, "message") ?? "", pdf };
};

/** `read_paper`: the paper as Markdown, decoded even when the JSON was cut. */
export const parsePaperContent = (result: string | undefined): { status: string; content: string | null } | null => {
  const status = jsonField(result, "status");
  if (!status) return null;
  return { status, content: extractJsonString(result, "content") };
};

// ---------------------------------------------------------------------------
// Meta (the muted note after the title)
// ---------------------------------------------------------------------------

export const mcpMeta = (name: string, args: ToolArgs | null, result: string | undefined): string | undefined => {
  const parts: string[] = [];
  switch (name) {
    case "tavily-search": {
      if (str(args, "query")) parts.push(quoted(clip(str(args, "query"))));
      const results = parseTavilyResults(result);
      if (results) parts.push(plural(results.length, "result"));
      break;
    }
    case "tavily-extract": {
      const urls = Array.isArray(args?.urls) ? (args?.urls as unknown[]).filter((u): u is string => typeof u === "string") : [];
      if (urls.length) parts.push(`${shortUrl(urls[0])}${urls.length > 1 ? ` +${urls.length - 1}` : ""}`);
      break;
    }
    case "tavily-crawl":
    case "tavily-map": {
      if (str(args, "url")) parts.push(shortUrl(str(args, "url")));
      const pages = parseTavilyPages(result);
      if (pages) parts.push(plural(pages.pages.length, "page"));
      break;
    }
    case "search_papers": {
      if (str(args, "query")) parts.push(clip(str(args, "query")));
      const papers = parsePapers(result);
      if (papers) parts.push(plural(papers.length, "result"));
      break;
    }
    case "list_papers": {
      const papers = parsePapers(result);
      if (papers) parts.push(plural(papers.length, "paper"));
      break;
    }
    case "download_paper":
    case "read_paper":
      if (str(args, "paper_id")) parts.push(str(args, "paper_id"));
      break;
    default:
      return undefined;
  }
  return parts.length ? parts.join(" · ") : undefined;
};
