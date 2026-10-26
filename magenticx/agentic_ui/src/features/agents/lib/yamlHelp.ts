/**
 * What "How to write an agent.yaml" says, kept apart from how it is drawn
 * (components/builder/YamlHelp): the example, the field reference and the
 * mapping from an issue's path to the field it is about, so the import
 * result's "What's this?" opens the help at the right row.
 *
 * The rules mirror the agents service's (agentRules.ts, `user_agents.py`); the
 * models and built-in tools are not listed here at all — the help reads them
 * live from the catalogs, so it can't fall behind the server.
 */
import {
  FILE_EXTENSIONS,
  MAX_DESCRIPTION_CHARS,
  MAX_FILES,
  MAX_NAME_CHARS,
  MAX_PATH_DEPTH,
  MAX_SUBAGENT_DEPTH,
  MAX_SUBAGENT_NAME_CHARS,
} from "./agentRules";

export const EXAMPLE_AGENT_YAML = `# agent.yaml: a market researcher with a three-level team.
name: Market Researcher          # required, at most ${MAX_NAME_CHARS} characters
slug: market-researcher          # optional: built from the name; fixed once created
description: Scans filings and news and writes a short, sourced brief.
icon: Telescope                  # a Lucide icon name
model: openai:gpt-5              # or {main: openai:gpt-5}
memory: true                     # remember lasting facts between conversations

# The main instructions: written here, or a file sent along (./AGENT.md).
prompt: |
  You are Market Researcher. Given a company, you gather recent filings
  and news, have every claim checked, and write a one-page brief.

tools:                           # MCP tools; the built-in ones are always on
  - server_id: web
    tool_name: search
skills:                          # names from your skill pool (remove if not in yours)
  - company-briefs

subagents:
  - name: researcher             # lowercase words joined by hyphens
    description: Finds recent filings and news about one company.
    prompt: |
      You research one company. Return the facts you find, each with its source.
    tools:                       # some of the agent's tools; leave out to get them all
      - server_id: web
        tool_name: search
    subagents:
      - name: fact-checker
        description: Checks one claim against a second, independent source.
        prompt: Check the claim you are given against a second source and say if it holds.
        model: openai:gpt-4o-mini   # its own model; leave out to use the one above
        subagents:
          - name: source-checker   # the third level: the deepest a team goes
            description: Judges whether a source is reliable and current.
            prompt: Rate the source you are given and say why.
  - name: writer
    description: Turns checked findings into a one-page brief.
    prompt: Write a clear one-page brief from the findings you are given.

hitl:                            # ask before these run (true) or not (false)
  write_file: false
  search: true
`;

/** A field of the reference: its anchor, whether it must be there, and what it means. */
export type HelpField = {
  id: string;
  /** As written in the YAML. */
  label: string;
  required: boolean;
  meaning: string;
  rules: string[];
  /** Where the live list goes (the models; the built-in tools). */
  live?: "models" | "builtins";
};

export const HELP_FIELDS: HelpField[] = [
  {
    id: "name",
    label: "name",
    required: true,
    meaning: "The agent's name, as the chat and Agents show it.",
    rules: [`At most ${MAX_NAME_CHARS} characters.`, "Needs at least one Latin letter or digit, for the slug."],
  },
  {
    id: "slug",
    label: "slug",
    required: false,
    meaning: "Its identifier. Built from the name when left out.",
    rules: [
      "Lowercase words joined by hyphens (market-researcher).",
      "Fixed once the agent is created; can't be a platform agent's.",
    ],
  },
  {
    id: "description",
    label: "description",
    required: false,
    meaning: "One or two lines on what it is for, shown on its card.",
    rules: [`At most ${MAX_DESCRIPTION_CHARS} characters.`],
  },
  {
    id: "icon",
    label: "icon",
    required: false,
    meaning: "A Lucide icon name (Telescope, Scale, Bot…). Bot when left out.",
    rules: [],
  },
  {
    id: "prompt",
    label: "prompt",
    required: true,
    meaning: "The main instructions: who it is, what it does, how it answers.",
    rules: [
      "Written inline (use | for several lines), or ./AGENT.md sent along with the YAML.",
      "Inline text is saved as AGENT.md.",
    ],
  },
  {
    id: "model",
    label: "model",
    required: false,
    meaning: "The model it runs on: model: openai:gpt-5, or model: {main: openai:gpt-5}.",
    rules: ["One of the models below; the default when left out."],
    live: "models",
  },
  {
    id: "memory",
    label: "memory",
    required: false,
    meaning: "true or false: whether it remembers lasting facts between conversations. On by default.",
    rules: [],
  },
  {
    id: "tools",
    label: "tools",
    required: false,
    meaning: "MCP tools, one per item: - {server_id: web, tool_name: search}.",
    rules: [
      "Each must be offered by your MCP gateway.",
      "The built-in tools below are always on; don't list them.",
    ],
    live: "builtins",
  },
  {
    id: "skills",
    label: "skills",
    required: false,
    meaning: "Skills from your skill pool, by name.",
    rules: ["Each must already be in your pool."],
  },
  {
    id: "subagents",
    label: "subagents",
    required: false,
    meaning: "Its team: helpers it can hand work to, each with the fields below, and teams of their own.",
    rules: [`At most ${MAX_SUBAGENT_DEPTH} levels below the agent.`],
  },
  {
    id: "subagents.name",
    label: "subagents[].name",
    required: true,
    meaning: "How its agent calls it, and what the chat shows.",
    rules: [
      `Lowercase words joined by hyphens (fact-checker), at most ${MAX_SUBAGENT_NAME_CHARS} characters.`,
      "Unique among its siblings; not repeated further down the same branch.",
    ],
  },
  {
    id: "subagents.description",
    label: "subagents[].description",
    required: true,
    meaning: "When to use it: its agent reads this to decide when to hand it work.",
    rules: ["At most 1,000 characters."],
  },
  {
    id: "subagents.prompt",
    label: "subagents[].prompt",
    required: true,
    meaning: "Its instructions, inline or a file (./subagents/researcher.md).",
    rules: ["Inline text is saved as subagents/<name>.md (subagents/<parent>--<name>.md deeper down)."],
  },
  {
    id: "subagents.model",
    label: "subagents[].model",
    required: false,
    meaning: "Its own model. Left out, it uses the model of the agent above it.",
    rules: [],
  },
  {
    id: "subagents.tools",
    label: "subagents[].tools",
    required: false,
    meaning: "Some of the tools of the agent above it. Left out, it gets all of them.",
    rules: ["Only tools its parent has."],
  },
  {
    id: "subagents.subagents",
    label: "subagents[].subagents",
    required: false,
    meaning: "Its own team, written the same way.",
    rules: [`The ${MAX_SUBAGENT_DEPTH}rd level is the last.`],
  },
  {
    id: "hitl",
    label: "hitl",
    required: false,
    meaning: "Whether a tool asks you before it runs: tool name → true or false. Where it's left out, the platform's default holds.",
    rules: [
      "Only tools the agent has: built-in ones, or its MCP tools by tool name.",
      "execute always asks; ask_user can't be gated (it is itself a question).",
      "These are the agent's defaults; you can change them for yourself on its page.",
    ],
  },
  {
    id: "id",
    label: "id · version · type",
    required: false,
    meaning: "Filled in for you (id from the slug, version 1.0.0, type deep_agent).",
    rules: [],
  },
];

export const TEAM_RULES = [
  `At most ${MAX_SUBAGENT_DEPTH} levels below the main agent.`,
  "Sibling names are unique, and a name can't repeat further down its branch.",
  "Names are lowercase words joined by hyphens.",
  "Every sub-agent needs a description: that is how its agent decides to use it.",
  "A sub-agent's tools are a subset of its parent's; left out, it inherits them all.",
  "A sub-agent's model, left out, is its parent's.",
];

export const FILE_RULES = [
  "Prompts can be written inline, or point at .md files uploaded with the YAML or inside a .zip.",
  "The layout: AGENT.md for the agent, subagents/<name>.md for each sub-agent (subagents/<parent>--<name>.md deeper down).",
  `At most ${MAX_FILES} files, 256 KiB each, 1 MiB in all; ${FILE_EXTENSIONS.join(" ")} only; folders at most ${MAX_PATH_DEPTH} deep.`,
  "Don't include agent.yaml twice — one manifest per agent (in a .zip, at its top or in one folder).",
];

export const COMMON_ERRORS: Array<{ message: string; fix: string; field?: string }> = [
  {
    message: "The YAML doesn't parse (line 12, column 3): …",
    fix: "Look at that line: indent with spaces, not tabs, and put quotes around a value that holds a colon.",
  },
  {
    message: "'openai:…' is not a model agents can use here.",
    fix: "Use one of the models listed under model.",
    field: "model",
  },
  {
    message: "Lists tools the agent does not have: …",
    fix: "A sub-agent's tools must be among its parent's. Add the tool to the parent, or remove it here.",
    field: "subagents.tools",
  },
  {
    message: "Sub-agent '… > …' is 4 levels below the agent; at most 3 are allowed.",
    fix: "Move it up a level, or fold its work into its parent.",
    field: "subagents",
  },
  {
    message: "A sub-agent needs a description: it is how its agent decides to use it.",
    fix: "Add a description line saying when to use it.",
    field: "subagents.description",
  },
  {
    message: "The prompt points at '…', which is not among the uploaded files.",
    fix: "Upload that file with the YAML (or put it in the .zip), or write the prompt inline.",
    field: "prompt",
  },
  {
    message: "Sub-agent name '…' must be lowercase words joined by hyphens.",
    fix: "Rename it: Fact Checker → fact-checker.",
    field: "subagents.name",
  },
  {
    message: "Skill '…' is not in your skill pool.",
    fix: "Add the skill to your pool first, or remove it from skills.",
    field: "skills",
  },
  {
    message: "…/… isn't offered by the MCP gateway.",
    fix: "Check the server and tool names, or remove the tool.",
    field: "tools",
  },
];

const SUB_HELP = new Set(["name", "description", "prompt", "model", "tools", "subagents"]);

/**
 * The help row an issue's path is about (`subagents.0.tools` → `subagents.tools`,
 * `model.main` → `model`), or "errors" for one about the YAML as a whole.
 */
export function helpFieldFor(path: string): string {
  if (!path) return "errors";
  if (/^files\[/.test(path) || path === "files") return "files";
  const parts = path.split(".");
  if (parts[0] === "subagents") {
    let at = 0;
    while (parts[at] === "subagents" && /^\d+$/.test(parts[at + 1] ?? "")) at += 2;
    const field = parts[at];
    return field && SUB_HELP.has(field) ? `subagents.${field}` : "subagents";
  }
  if (parts[0] === "hitl") return "hitl";
  if (parts[0] === "version" || parts[0] === "type") return "id";
  return HELP_FIELDS.some((f) => f.id === parts[0]) ? parts[0] : "errors";
}

/** A help row's element id, for links into it. */
export const helpAnchor = (id: string) => `yaml-help-${id.replace(/[^a-z0-9]+/gi, "-")}`;
