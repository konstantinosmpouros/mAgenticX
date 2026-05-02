import * as React from "react";
import ExcelJS from "exceljs";

type ExcelPreviewProps = {
  blob: Blob;
};

type CellView = {
  key: string;
  value: string;
  style: React.CSSProperties;
};

type SheetView = {
  name: string;
  rows: CellView[][];
};

const MAX_ROWS = 500;
const MAX_COLUMNS = 80;
const DARK_TEXT_FALLBACK = "#f5f5f5";
const MIN_CONTRAST_CHANNEL_SUM = 220;

function colorToCss(color: Partial<ExcelJS.Color> | undefined) {
  if (!color) return undefined;
  if ("argb" in color && color.argb) {
    const raw = color.argb.replace(/^FF/i, "");
    return `#${raw}`;
  }
  return undefined;
}

function isTooDarkForSurface(color: string | undefined) {
  if (!color?.startsWith("#")) return false;
  const hex = color.slice(1);
  if (hex.length !== 6) return false;
  const red = Number.parseInt(hex.slice(0, 2), 16);
  const green = Number.parseInt(hex.slice(2, 4), 16);
  const blue = Number.parseInt(hex.slice(4, 6), 16);
  return red + green + blue < MIN_CONTRAST_CHANNEL_SUM;
}

function valueToText(value: ExcelJS.CellValue): string {
  if (value == null) return "";
  if (value instanceof Date) return value.toLocaleString();
  if (typeof value === "object") {
    if ("text" in value && typeof value.text === "string") return value.text;
    if ("result" in value) return String(value.result ?? "");
    if ("richText" in value && Array.isArray(value.richText)) {
      return value.richText.map((part) => part.text).join("");
    }
    if ("hyperlink" in value && "text" in value) return String(value.text ?? value.hyperlink ?? "");
    return JSON.stringify(value);
  }
  return String(value);
}

function cellStyle(cell: ExcelJS.Cell): React.CSSProperties {
  const style: React.CSSProperties = {};
  const font = cell.font;
  const fill = cell.fill;
  const alignment = cell.alignment;

  if (font?.bold) style.fontWeight = 700;
  if (font?.italic) style.fontStyle = "italic";
  if (font?.underline) style.textDecoration = "underline";
  if (font?.size) style.fontSize = `${font.size}px`;
  if (font?.color) style.color = colorToCss(font.color);
  if (alignment?.horizontal) style.textAlign = alignment.horizontal as React.CSSProperties["textAlign"];
  if (alignment?.vertical) style.verticalAlign = alignment.vertical;
  if (alignment?.wrapText) style.whiteSpace = "pre-wrap";

  if (fill?.type === "pattern" && "fgColor" in fill) {
    style.backgroundColor = colorToCss(fill.fgColor);
  }

  if (!style.color || isTooDarkForSurface(style.color)) {
    style.color = DARK_TEXT_FALLBACK;
  }

  return style;
}

async function readWorkbook(blob: Blob): Promise<SheetView[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await blob.arrayBuffer());

  return workbook.worksheets.map((sheet) => {
    const rowCount = Math.min(sheet.actualRowCount || sheet.rowCount, MAX_ROWS);
    const columnCount = Math.min(sheet.actualColumnCount || sheet.columnCount, MAX_COLUMNS);
    const rows: CellView[][] = [];

    for (let rowIndex = 1; rowIndex <= rowCount; rowIndex += 1) {
      const row = sheet.getRow(rowIndex);
      const cells: CellView[] = [];
      for (let columnIndex = 1; columnIndex <= columnCount; columnIndex += 1) {
        const cell = row.getCell(columnIndex);
        const width = sheet.getColumn(columnIndex).width;
        cells.push({
          key: `${rowIndex}-${columnIndex}`,
          value: valueToText(cell.value),
          style: {
            minWidth: width ? `${Math.max(70, Math.min(width * 8, 280))}px` : undefined,
            ...cellStyle(cell),
          },
        });
      }
      rows.push(cells);
    }

    return { name: sheet.name, rows };
  });
}

export function ExcelPreview({ blob }: ExcelPreviewProps) {
  const [sheets, setSheets] = React.useState<SheetView[]>([]);
  const [activeIndex, setActiveIndex] = React.useState(0);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setSheets([]);
    setActiveIndex(0);
    setError(null);

    void readWorkbook(blob)
      .then((nextSheets) => {
        if (!cancelled) setSheets(nextSheets);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to read workbook.");
      });

    return () => {
      cancelled = true;
    };
  }, [blob]);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center rounded-[1.4rem] border border-white/10 bg-[#171717] p-6 text-sm text-red-200">
        {error}
      </div>
    );
  }

  if (!sheets.length) {
    return (
      <div className="flex h-full items-center justify-center rounded-[1.4rem] border border-white/10 bg-[#171717] p-6 text-sm text-white/65">
        Reading workbook...
      </div>
    );
  }

  const activeSheet = sheets[Math.min(activeIndex, sheets.length - 1)];

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-[1.4rem] border border-white/10 bg-[#171717]">
      <div className="flex min-h-11 items-center gap-2 overflow-x-auto border-b border-white/10 px-3 py-2">
        {sheets.map((sheet, index) => (
          <button
            key={sheet.name}
            type="button"
            className={`whitespace-nowrap rounded-md px-3 py-1.5 text-xs transition-colors ${
              index === activeIndex ? "bg-primary text-primary-foreground" : "bg-white/[0.05] text-white/70 hover:bg-white/[0.08]"
            }`}
            onClick={() => setActiveIndex(index)}
          >
            {sheet.name}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="border-collapse text-left text-xs text-white/85">
          <tbody>
            {activeSheet.rows.map((row, rowIndex) => (
              <tr key={`xlsx-row-${rowIndex}`}>
                <th className="sticky left-0 z-10 border border-white/10 bg-[#222] px-2 py-1 text-right font-normal text-white/40">
                  {rowIndex + 1}
                </th>
                {row.map((cell) => (
                  <td
                    key={cell.key}
                    className="max-w-[24rem] whitespace-pre-wrap border border-white/10 px-2.5 py-1.5 align-top"
                    style={cell.style}
                  >
                    {cell.value}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
