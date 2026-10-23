// @vitest-environment happy-dom
// `tableRows` reads a rendered <table>, so this file needs a DOM.
import { describe, expect, it } from "vitest";

import {
  rowsToCsv,
  rowsToHtml,
  rowsToTsv,
  tableFileName,
  tableRows,
} from "@/shared/lib/table-export";

/**
 * Copy / CSV of a table in an answer. Pinned: the rows are the rendered text
 * (inline Markdown resolved, whitespace collapsed); the CSV opens in Excel with
 * Greek intact (BOM) and quotes only what must be quoted; a paste keeps a grid
 * (HTML) and stays plain text elsewhere (TSV); nothing in a cell can inject
 * markup into the copied HTML.
 */

const rows = [
  ["Όνομα", "Ποσό"],
  ["ΑΑΔΕ, Τμήμα Ε", "1.200"],
  ['Say "hi"', "2\t3"],
];

describe("tableRows", () => {
  it("reads every row as trimmed text, header included", () => {
    const table = document.createElement("table");
    table.innerHTML = `
      <thead><tr><th> Name </th><th>Total</th></tr></thead>
      <tbody><tr><td><strong>Alpha</strong>  one</td><td><code>12</code></td></tr></tbody>`;
    expect(tableRows(table)).toEqual([
      ["Name", "Total"],
      ["Alpha one", "12"],
    ]);
  });
});

describe("rowsToCsv", () => {
  it("starts with a BOM and ends rows with CRLF", () => {
    const csv = rowsToCsv([["a", "b"]]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1)).toBe("a,b\r\n");
  });

  it("quotes only fields holding a comma, quote, semicolon or line break", () => {
    const csv = rowsToCsv([...rows, ["x;y", "line\nbreak"]]).slice(1);
    expect(csv).toBe(
      'Όνομα,Ποσό\r\n"ΑΑΔΕ, Τμήμα Ε",1.200\r\n"Say ""hi""",2\t3\r\n"x;y","line\nbreak"\r\n',
    );
  });
});

describe("rowsToTsv", () => {
  it("joins cells with tabs, flattening tabs inside a cell", () => {
    expect(rowsToTsv(rows)).toBe('Όνομα\tΠοσό\nΑΑΔΕ, Τμήμα Ε\t1.200\nSay "hi"\t2 3');
  });
});

describe("rowsToHtml", () => {
  it("puts the first row in thead and escapes cell text", () => {
    expect(
      rowsToHtml([
        ["<b>", "a&b"],
        ['"x"', "y"],
      ]),
    ).toBe(
      "<table><thead><tr><th>&lt;b&gt;</th><th>a&amp;b</th></tr></thead>" +
        "<tbody><tr><td>&quot;x&quot;</td><td>y</td></tr></tbody></table>",
    );
  });
});

describe("tableFileName", () => {
  it("is table-YYYYMMDD-HHMM.csv in local time", () => {
    expect(tableFileName(new Date(2026, 9, 5, 7, 3))).toBe("table-20261005-0703.csv");
  });
});
