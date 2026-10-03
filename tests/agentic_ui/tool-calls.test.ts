import { describe, expect, it } from "vitest";

import {
  isRoutineSuccess,
  languageForPath,
  parseCommandOutput,
  parseGrep,
  parseNumberedFile,
  parsePastChats,
  parsePathList,
  toolMeta,
  toolTitle,
  toolTitleHint,
  undoDoubleEscaping,
} from "@/features/chat/lib/toolPresentation";
import { mcpToolTitle } from "@/features/chat/lib/mcpToolPresentation";

/**
 * How a tool step titles and parses itself in the chain of thought.
 *
 * The inputs below are the real output formats: deepagents' `ls`/`glob` return a
 * Python list repr, `read_file` is `cat -n` style with `N.1` continuations,
 * `grep` has three modes, `execute` appends an exit-code line, and our memory
 * search emits `- [header] text` lines. Every parser must return `null` for what
 * it does not recognise, so the step falls back to the generic JSON view rather
 * than rendering something wrong.
 */

describe("titles", () => {
  it.each([
    ["read_file", { file_path: "/conversation/input/image.png" }, "Read image.png"],
    ["ls", { path: "/conversation/input/" }, "List conversation/input"],
    ["ls", { path: "/" }, "List /"],
    ["glob", { pattern: "**/*.py" }, "Find **/*.py"],
    ["grep", { pattern: "TODO", path: "/skills" }, 'Search "TODO" in skills'],
    ["grep", { pattern: "TODO" }, 'Search "TODO"'],
    ["write_file", { file_path: "/conversation/output/csv_to_xlsx.py", content: "x" }, "Write csv_to_xlsx.py"],
    ["edit_file", { file_path: "/app.py", old_string: "a", new_string: "b" }, "Edit app.py"],
    ["execute", { command: "python script.py" }, "Run python script.py"],
    ["remember", { name: "project-goals", summary: "s", content: "c" }, 'Remembered "project-goals"'],
    ["forget", { name: "project-goals" }, 'Forgot "project-goals"'],
    ["search_past_conversations", { query: "budget" }, 'Searched past chats for "budget"'],
    ["view_image", { path: "/conversation/input/photo.jpg" }, "View photo.jpg"],
    ["create_skill", { name: "pdf-tools", description: "d", instructions: "i" }, 'Created skill "pdf-tools"'],
  ])("%s → %s", (name, args, title) => {
    expect(toolTitle(name, args)).toBe(title);
  });

  it("falls back to the static label while arguments are still streaming", () => {
    expect(toolTitle("read_file", '{"name": "read_file", "args": {"file_')).toBe("read_file");
    expect(toolTitle("view_image", null)).toBe("View image");
  });

  it("clips long commands and queries", () => {
    const title = toolTitle("execute", { command: "x".repeat(200) });
    expect(title.length).toBeLessThanOrEqual(64);
    expect(title.endsWith("…")).toBe(true);
  });

  it("hovers the full path the title shortened", () => {
    expect(toolTitleHint("read_file", { file_path: "/conversation/input/image.png" })).toBe(
      "/conversation/input/image.png",
    );
    expect(toolTitleHint("grep", { pattern: "x" })).toBeUndefined();
  });
});

describe("MCP tools: Server · Tool", () => {
  // The real names are bare; the catalog supplies the server id.
  it.each([
    ["tavily-search", "tavily", "Tavily · Search"],
    ["tavily-extract", "tavily", "Tavily · Extract"],
    ["tavily-crawl", "tavily", "Tavily · Crawl"],
    ["tavily-map", "tavily", "Tavily · Map"],
    ["search_papers", "arxiv", "arXiv · Search papers"],
    ["download_paper", "arxiv", "arXiv · Download paper"],
    ["list_papers", "arxiv", "arXiv · List papers"],
    ["read_paper", "arxiv", "arXiv · Read paper"],
    ["brave_web_search", "brave", "Brave · Web search"],
    ["get_docs", "context7-mcp-server", "Context7 · Get docs"],
  ])("%s on %s → %s", (name, serverId, title) => {
    expect(mcpToolTitle(name, serverId)).toBe(title);
    expect(toolTitle(name, { query: "anything" }, serverId)).toBe(title);
  });

  it("still reads a server/tool name when the catalog is not loaded", () => {
    expect(toolTitle("tavily/tavily-search", {})).toBe("Tavily · Search");
  });

  it("keeps an unlisted non-MCP tool's raw name", () => {
    expect(toolTitle("render_chart", {})).toBe("render_chart");
    expect(toolTitle("tavily-search", {})).toBe("tavily-search");
  });
});

describe("ls / glob", () => {
  it("reads the Python list repr", () => {
    expect(parsePathList("['/conversation/input/image.png', '/conversation/input/data/']")).toEqual({
      paths: ["/conversation/input/image.png", "/conversation/input/data/"],
    });
  });

  it("reads an empty directory", () => {
    expect(parsePathList("[]")).toEqual({ paths: [] });
  });

  it("splits off the truncation notice", () => {
    const parsed = parsePathList("['/a', '/b', 'Results truncated. Narrow the search.']");
    expect(parsed?.paths).toEqual(["/a", "/b"]);
    expect(parsed?.note).toContain("truncated");
  });

  it("rejects what is not a list", () => {
    expect(parsePathList("Error: path not found")).toBeNull();
    expect(parsePathList(undefined)).toBeNull();
  });

  it("counts items in the meta", () => {
    expect(toolMeta("ls", { path: "/" }, "['/a', '/b']")).toBe("2 items");
    expect(toolMeta("glob", { pattern: "*" }, "['/a']")).toBe("1 file");
  });
});

describe("grep", () => {
  it("files_with_matches (the default)", () => {
    expect(parseGrep("/a.py\n/b.py", undefined)).toEqual({ mode: "files", files: ["/a.py", "/b.py"] });
  });

  it("count", () => {
    const parsed = parseGrep("/a.py: 3\n/b.py: 1", "count");
    expect(parsed).toEqual({ mode: "count", counts: [{ path: "/a.py", count: 3 }, { path: "/b.py", count: 1 }] });
    expect(toolMeta("grep", { pattern: "x", output_mode: "count" }, "/a.py: 3\n/b.py: 1")).toBe("4 matches");
  });

  it("content", () => {
    const text = "/a.py:\n  12: import os\n  40: os.path\n/b.py:\n  3: os";
    const parsed = parseGrep(text, "content");
    expect(parsed?.mode).toBe("content");
    expect(parsed && parsed.mode === "content" ? parsed.files[0].lines : []).toEqual([
      { line: "12", text: "import os" },
      { line: "40", text: "os.path" },
    ]);
    expect(toolMeta("grep", { pattern: "os", output_mode: "content" }, text)).toBe("3 matches");
  });

  it("no matches", () => {
    expect(parseGrep("No matches found", undefined)).toEqual({ mode: "files", files: [] });
  });
});

describe("read_file text", () => {
  it("strips cat -n numbers and records the range", () => {
    const parsed = parseNumberedFile("    10\tfirst\n    11\tsecond");
    expect(parsed).toEqual({ code: "first\nsecond", first: 10, last: 11 });
    expect(toolMeta("read_file", { file_path: "/x.py" }, "    10\tfirst\n    11\tsecond")).toBe("lines 10–11");
  });

  it("rejoins a long line split into continuation chunks", () => {
    expect(parseNumberedFile("     1\tabc\n   1.1\tdef\n     2\tg")?.code).toBe("abcdef\ng");
  });

  it("keeps a trailing notice apart from the code", () => {
    const parsed = parseNumberedFile("     1\ta\n\n[Output truncated — read with offset]");
    expect(parsed?.code).toBe("a");
    expect(parsed?.note).toContain("truncated");
  });

  it("rejects an image block or an error", () => {
    expect(parseNumberedFile('[{"type": "image", "preview_base64": "AAAA"}]')).toBeNull();
    expect(parseNumberedFile("Error: file not found")).toBeNull();
  });
});

describe("execute", () => {
  it("splits the exit code off the output", () => {
    expect(parseCommandOutput("hello\n[Command succeeded with exit code 0]")).toEqual({ output: "hello", exitCode: 0 });
    expect(toolMeta("execute", { command: "false" }, "\n[Command failed with exit code 1]")).toBe("exit 1");
  });

  it("keeps output without an exit line as-is", () => {
    expect(parseCommandOutput("just text")).toEqual({ output: "just text" });
  });
});

describe("search_past_conversations", () => {
  it("parses each hit", () => {
    const text =
      "Relevant past messages from this user's earlier conversations:\n" +
      "- [Budget plan · User · created 2026-09-01] What did we decide?\n" +
      "- [Trip · Assistant · created 2026-08-02, updated 2026-08-03] Book the train.";
    expect(parsePastChats(text)).toEqual([
      { header: "Budget plan · User · created 2026-09-01", snippet: "What did we decide?" },
      { header: "Trip · Assistant · created 2026-08-02, updated 2026-08-03", snippet: "Book the train." },
    ]);
  });

  it("reads 'nothing found' and rejects anything else", () => {
    expect(parsePastChats("No relevant past messages found.")).toEqual([]);
    expect(parsePastChats("Memory search is temporarily unavailable right now.")).toBeNull();
  });
});

describe("routine success messages are hidden, anything else is shown", () => {
  it.each([
    ["write_file", "Updated file /conversation/output/x.py", true],
    ["edit_file", "Successfully replaced 1 instance(s) of the string in '/a.py'", true],
    ["remember", "Saved memory 'goals'. It will be available in your future conversations with this user.", true],
    ["forget", "Forgot memory 'goals'. It is gone permanently.", true],
    ["create_skill", "Created skill 'pdf' and enabled it for you. It is not loaded in this conversation", true],
    ["remember", "Could not save: both 'summary' and 'content' are required.", false],
    ["forget", "No memory named 'goals' — nothing to forget.", false],
    ["create_skill", "Created skill 'pdf' in the user's skill pool, but could not enable it for you automatically.", false],
  ])("%s: %s", (name, result, hidden) => {
    expect(isRoutineSuccess(name, result)).toBe(hidden);
  });
});

describe("syntax highlighting by extension", () => {
  it.each([
    ["/a/script.py", "python"],
    ["/a/data.csv", "csv"],
    ["/a/Dockerfile", "dockerfile"],
    ["/a/notes.md", "markdown"],
    ["/a/blob.bin", "text"],
  ])("%s → %s", (path, language) => {
    expect(languageForPath(path)).toBe(language);
  });
});

describe("double-escaped line breaks (mirrors harness/tools/text_args.py)", () => {
  it("restores them in one-line text", () => {
    expect(undoDoubleEscaping("# Title\\n\\nBody\\n- item")).toBe("# Title\n\nBody\n- item");
  });

  it("leaves text with real line breaks alone", () => {
    const text = "Line one\nUse \\n to break a line.";
    expect(undoDoubleEscaping(text)).toBe(text);
  });
});
