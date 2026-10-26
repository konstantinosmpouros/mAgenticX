/**
 * Just enough YAML colouring for the builder's read-only YAML view and the
 * help's example: keys, strings, numbers and booleans, comments, list dashes.
 *
 * A line tokenizer rather than highlight.js, so the colours are the theme's own
 * tokens in every theme, light or dark (the app's highlight.js stylesheet is a
 * dark one), and nothing else loads. It only colours; it never parses — what
 * it gets wrong is a colour, never the text.
 */

export type YamlTokenKind = "key" | "string" | "scalar" | "comment" | "punct" | "text";
export type YamlToken = { text: string; kind: YamlTokenKind };

const SCALAR = /^(true|false|null|~|yes|no|-?\d+(\.\d+)?)$/i;

/** Split a value into its text and a trailing comment (a `#` after a space, outside quotes). */
function splitComment(value: string): [string, string] {
  let quote: string | null = null;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#" && (i === 0 || /\s/.test(value[i - 1]))) {
      return [value.slice(0, i), value.slice(i)];
    }
  }
  return [value, ""];
}

function valueTokens(value: string): YamlToken[] {
  const [body, comment] = splitComment(value);
  const tokens: YamlToken[] = [];
  const trimmed = body.trim();
  if (trimmed) {
    const lead = body.slice(0, body.indexOf(trimmed));
    const tail = body.slice(body.indexOf(trimmed) + trimmed.length);
    if (lead) tokens.push({ text: lead, kind: "text" });
    const kind: YamlTokenKind =
      /^(["']).*\1$/.test(trimmed)
        ? "string"
        : SCALAR.test(trimmed)
          ? "scalar"
          : /^[|>][-+]?$/.test(trimmed) || /^[[{]/.test(trimmed)
            ? "punct"
            : "text";
    tokens.push({ text: trimmed, kind });
    if (tail) tokens.push({ text: tail, kind: "text" });
  } else if (body) {
    tokens.push({ text: body, kind: "text" });
  }
  if (comment) tokens.push({ text: comment, kind: "comment" });
  return tokens;
}

/** One line's tokens. Inside a block scalar (`prompt: |`), every line is plain text. */
export function tokenizeYamlLine(line: string, inBlock = false): YamlToken[] {
  if (inBlock) return [{ text: line, kind: "string" }];
  if (/^\s*#/.test(line)) return [{ text: line, kind: "comment" }];
  const tokens: YamlToken[] = [];
  const match = /^(\s*)(- )?(?:([A-Za-z0-9_.\-/]+|"[^"]*"|'[^']*')(:)(?=\s|$))?(.*)$/.exec(line);
  if (!match) return [{ text: line, kind: "text" }];
  const [, indent, dash, key, colon, rest] = match;
  if (indent) tokens.push({ text: indent, kind: "text" });
  if (dash) tokens.push({ text: dash, kind: "punct" });
  if (key) {
    tokens.push({ text: key, kind: "key" });
    tokens.push({ text: colon, kind: "punct" });
  }
  tokens.push(...valueTokens(rest));
  return tokens;
}

/** Every line's tokens, following block scalars (`key: |`) by their indentation. */
export function tokenizeYaml(text: string): YamlToken[][] {
  const lines = text.replace(/\n$/, "").split("\n");
  const out: YamlToken[][] = [];
  let blockIndent: number | null = null;
  for (const line of lines) {
    const indent = line.length - line.trimStart().length;
    if (blockIndent !== null && (line.trim() === "" || indent > blockIndent)) {
      out.push(tokenizeYamlLine(line, true));
      continue;
    }
    blockIndent = null;
    out.push(tokenizeYamlLine(line));
    if (/:\s*[|>][-+]?\s*(#.*)?$/.test(line)) blockIndent = indent;
  }
  return out;
}

export const YAML_TOKEN_CLASS: Record<YamlTokenKind, string> = {
  key: "text-primary",
  string: "text-[hsl(var(--success))]",
  scalar: "text-[hsl(var(--warning))]",
  comment: "italic text-muted-foreground",
  punct: "text-muted-foreground",
  text: "text-foreground",
};
