/**
 * Copy / download of a table the agent wrote in an answer (a rendered Markdown
 * table). The rows are read from the rendered DOM, so what the user gets is
 * exactly what they see — inline Markdown already resolved to text.
 */

import { triggerBrowserDownload } from "./download";

/** Every row of the table, header included, as trimmed cell texts. */
export function tableRows(table: HTMLTableElement): string[][] {
  return Array.from(table.rows).map((row) =>
    Array.from(row.cells).map((cell) => (cell.textContent ?? "").replace(/\s+/g, " ").trim()),
  );
}

/**
 * CSV that Excel opens correctly: a UTF-8 BOM (without it Excel reads Greek and
 * other non-ASCII text as mojibake), comma-separated, CRLF line ends, a field
 * quoted only when it holds a quote, comma, semicolon or line break.
 */
export function rowsToCsv(rows: string[][]): string {
  const escape = (value: string) =>
    /[",;\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  const BOM = String.fromCharCode(0xfeff);
  return `${BOM}${rows.map((row) => row.map(escape).join(",")).join("\r\n")}\r\n`;
}

/** Tab-separated text: pastes as a grid into Excel and as plain text anywhere else. */
export function rowsToTsv(rows: string[][]): string {
  return rows.map((row) => row.map((cell) => cell.replace(/\t/g, " ")).join("\t")).join("\n");
}

/** A minimal HTML table, so a paste into Word / Outlook / Docs keeps it a table. */
export function rowsToHtml(rows: string[][]): string {
  const escape = (value: string) =>
    value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const [head, ...body] = rows;
  const cells = (row: string[], tag: "th" | "td") =>
    row.map((cell) => `<${tag}>${escape(cell)}</${tag}>`).join("");
  const thead = head ? `<thead><tr>${cells(head, "th")}</tr></thead>` : "";
  const tbody = body.map((row) => `<tr>${cells(row, "td")}</tr>`).join("");
  return `<table>${thead}<tbody>${tbody}</tbody></table>`;
}

/** `table-YYYYMMDD-HHMM.csv`, local time. */
export function tableFileName(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `table-${stamp}.csv`;
}

/**
 * Put the table on the clipboard as HTML (Word / Outlook keep the grid) plus
 * TSV (Excel, plain editors). Falls back to TSV text where `ClipboardItem` is
 * missing. Resolves false when the clipboard is unavailable or denied.
 */
export async function copyTableRows(rows: string[][]): Promise<boolean> {
  const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
  if (!clipboard) return false;
  const tsv = rowsToTsv(rows);
  try {
    if (typeof ClipboardItem !== "undefined" && typeof clipboard.write === "function") {
      await clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([rowsToHtml(rows)], { type: "text/html" }),
          "text/plain": new Blob([tsv], { type: "text/plain" }),
        }),
      ]);
    } else {
      await clipboard.writeText(tsv);
    }
    return true;
  } catch {
    return false;
  }
}

/** Save the rows as a CSV file. */
export function downloadTableCsv(rows: string[][], fileName: string = tableFileName()): void {
  triggerBrowserDownload(new Blob([rowsToCsv(rows)], { type: "text/csv;charset=utf-8" }), fileName);
}
