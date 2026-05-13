import * as React from "react";
import ExcelJS from "exceljs";

type ExcelPreviewProps = {
  blob: Blob;
};

type ColumnView = {
  index: number;
  label: string;
  width: number;
  position: number;
};

type RowView = {
  index: number;
  height: number;
  position: number;
};

type MergeRange = {
  masterAddress: string;
  top: number;
  left: number;
  bottom: number;
  right: number;
};

type CellView = {
  key: string;
  address: string;
  value: string;
  row: number;
  column: number;
  rowSpan: number;
  colSpan: number;
  style: React.CSSProperties;
};

type SheetView = {
  name: string;
  columns: ColumnView[];
  rows: RowView[];
  cells: CellView[];
};

const MAX_ROWS = 500;
const MAX_COLUMNS = 80;
const ROW_HEADER_WIDTH = 46;
const COLUMN_HEADER_HEIGHT = 24;
const DEFAULT_ROW_HEIGHT = 24;
const DEFAULT_COLUMN_WIDTH = 64;

const INDEXED_COLORS: Record<number, string> = {
  0: "#000000",
  1: "#ffffff",
  2: "#ff0000",
  3: "#00ff00",
  4: "#0000ff",
  5: "#ffff00",
  6: "#ff00ff",
  7: "#00ffff",
  8: "#000000",
  9: "#ffffff",
  10: "#ff0000",
  11: "#00ff00",
  12: "#0000ff",
  13: "#ffff00",
  14: "#ff00ff",
  15: "#00ffff",
  16: "#800000",
  17: "#008000",
  18: "#000080",
  19: "#808000",
  20: "#800080",
  21: "#008080",
  22: "#c0c0c0",
  23: "#808080",
};

export function excelColumnName(index: number) {
  let name = "";
  let next = index;
  while (next > 0) {
    const remainder = (next - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    next = Math.floor((next - 1) / 26);
  }
  return name;
}

export function excelColumnWidthToPixels(width?: number) {
  if (!width || Number.isNaN(width)) return DEFAULT_COLUMN_WIDTH;
  return Math.max(18, Math.min(Math.round(width * 7 + 5), 420));
}

export function excelRowHeightToPixels(height?: number) {
  if (!height || Number.isNaN(height)) return DEFAULT_ROW_HEIGHT;
  return Math.max(18, Math.min(Math.round(height * (96 / 72)), 220));
}

function colorToCss(color: Partial<ExcelJS.Color> | undefined) {
  if (!color) return undefined;
  if ("argb" in color && color.argb) {
    const raw = color.argb.length === 8 ? color.argb.slice(2) : color.argb;
    return `#${raw}`;
  }
  if ("indexed" in color && typeof color.indexed === "number") {
    return INDEXED_COLORS[color.indexed];
  }
  return undefined;
}

function parseCellAddress(address: string) {
  const match = /^([A-Z]+)(\d+)$/i.exec(address);
  if (!match) return null;
  const letters = match[1].toUpperCase();
  const row = Number.parseInt(match[2], 10);
  let column = 0;
  for (const char of letters) {
    column = column * 26 + char.charCodeAt(0) - 64;
  }
  return { row, column };
}

function parseRangeAddress(range: string): MergeRange | null {
  const [start, end = start] = range.split(":");
  const startCell = parseCellAddress(start);
  const endCell = parseCellAddress(end);
  if (!startCell || !endCell) return null;
  return {
    masterAddress: `${excelColumnName(startCell.column)}${startCell.row}`,
    top: Math.min(startCell.row, endCell.row),
    left: Math.min(startCell.column, endCell.column),
    bottom: Math.max(startCell.row, endCell.row),
    right: Math.max(startCell.column, endCell.column),
  };
}

function valueToText(cell: ExcelJS.Cell): string {
  if (cell.text) return cell.text;
  const value = cell.value;
  if (value == null) return "";
  if (value instanceof Date) return value.toLocaleDateString();
  if (typeof value === "object") {
    if ("text" in value && typeof value.text === "string") return value.text;
    if ("result" in value) return String(value.result ?? "");
    if ("richText" in value && Array.isArray(value.richText)) {
      return value.richText.map((part) => part.text).join("");
    }
    if ("hyperlink" in value && "text" in value) return String(value.text ?? value.hyperlink ?? "");
    return "";
  }
  return String(value);
}

function borderStyle(border: Partial<ExcelJS.Border> | undefined) {
  if (!border?.style) return undefined;
  const color = colorToCss(border.color) ?? "#b7b7b7";
  const width = ["medium", "thick", "double"].includes(border.style) ? 2 : 1;
  const style = border.style === "dotted" || border.style === "dashDot" || border.style === "dashDotDot"
    ? "dotted"
    : border.style === "dashed"
      ? "dashed"
      : "solid";
  return `${width}px ${style} ${color}`;
}

function horizontalAlign(value: ExcelJS.Alignment["horizontal"]): React.CSSProperties["textAlign"] {
  if (value === "centerContinuous" || value === "distributed") return "center";
  if (value === "right") return "right";
  if (value === "center") return "center";
  return "left";
}

function verticalAlign(value: ExcelJS.Alignment["vertical"]): React.CSSProperties["alignItems"] {
  if (value === "middle" || value === "distributed") return "center";
  if (value === "bottom") return "flex-end";
  return "flex-start";
}

function isNumericCell(cell: ExcelJS.Cell) {
  const value = cell.value;
  if (typeof value === "number") return true;
  return Boolean(value && typeof value === "object" && "result" in value && typeof value.result === "number");
}

function cellStyle(cell: ExcelJS.Cell): React.CSSProperties {
  const style: React.CSSProperties = {};
  const font = cell.font;
  const fill = cell.fill;
  const alignment = cell.alignment;
  const border = cell.border;

  if (font?.bold) style.fontWeight = 700;
  if (font?.italic) style.fontStyle = "italic";
  if (font?.underline) style.textDecoration = "underline";
  if (font?.size) style.fontSize = `${font.size}pt`;
  if (font?.name) style.fontFamily = `"${font.name}", Calibri, Arial, sans-serif`;
  style.color = colorToCss(font?.color) ?? "#111827";

  if (fill?.type === "pattern" && "fgColor" in fill) {
    style.backgroundColor = colorToCss(fill.fgColor) ?? undefined;
  }

  const inferredHorizontal = alignment?.horizontal ?? (isNumericCell(cell) ? "right" : undefined);
  style.textAlign = horizontalAlign(inferredHorizontal);
  style.alignItems = verticalAlign(alignment?.vertical);
  style.justifyContent = inferredHorizontal === "center" || inferredHorizontal === "centerContinuous"
    ? "center"
    : inferredHorizontal === "right"
      ? "flex-end"
      : "flex-start";
  style.whiteSpace = alignment?.wrapText ? "pre-wrap" : "pre";

  const top = borderStyle(border?.top);
  const right = borderStyle(border?.right);
  const bottom = borderStyle(border?.bottom);
  const left = borderStyle(border?.left);
  if (top) style.borderTop = top;
  if (right) style.borderRight = right;
  if (bottom) style.borderBottom = bottom;
  if (left) style.borderLeft = left;

  return style;
}

function rangesFromWorksheet(sheet: ExcelJS.Worksheet): MergeRange[] {
  const ranges = new Map<string, MergeRange>();
  const worksheet = sheet as unknown as {
    _merges?: Map<string, { model?: Partial<MergeRange>; range?: string }> | Record<string, { model?: Partial<MergeRange>; range?: string }>;
    model?: { merges?: string[] };
  };

  const addRange = (range: MergeRange | null) => {
    if (range) ranges.set(range.masterAddress, range);
  };

  if (worksheet.model?.merges) {
    worksheet.model.merges.forEach((range) => addRange(parseRangeAddress(range)));
  }

  if (worksheet._merges instanceof Map) {
    worksheet._merges.forEach((range) => {
      const model = range.model;
      if (model?.top && model.left && model.bottom && model.right) {
        addRange({
          masterAddress: `${excelColumnName(model.left)}${model.top}`,
          top: model.top,
          left: model.left,
          bottom: model.bottom,
          right: model.right,
        });
      } else if (range.range) {
        addRange(parseRangeAddress(range.range));
      }
    });
  } else if (worksheet._merges) {
    Object.entries(worksheet._merges).forEach(([address, range]) => {
      const model = range.model;
      if (model?.top && model.left && model.bottom && model.right) {
        addRange({
          masterAddress: `${excelColumnName(model.left)}${model.top}`,
          top: model.top,
          left: model.left,
          bottom: model.bottom,
          right: model.right,
        });
      } else {
        addRange(parseRangeAddress(range.range ?? address));
      }
    });
  }

  return Array.from(ranges.values());
}

function visibleSpan(start: number, end: number, visibleIndexes: Set<number>) {
  let span = 0;
  for (let index = start; index <= end; index += 1) {
    if (visibleIndexes.has(index)) span += 1;
  }
  return Math.max(1, span);
}

async function readWorkbook(blob: Blob): Promise<SheetView[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await blob.arrayBuffer());

  return workbook.worksheets.map((sheet) => {
    const mergeRanges = rangesFromWorksheet(sheet);
    const mergeMaxRow = Math.max(0, ...mergeRanges.map((range) => range.bottom));
    const mergeMaxColumn = Math.max(0, ...mergeRanges.map((range) => range.right));
    let rowCount = Math.max(sheet.rowCount, sheet.actualRowCount, mergeMaxRow);
    let columnCount = Math.max(sheet.columnCount, sheet.actualColumnCount, mergeMaxColumn);

    for (let rowIndex = 1; rowIndex <= sheet.rowCount; rowIndex += 1) {
      columnCount = Math.max(columnCount, sheet.getRow(rowIndex).cellCount);
    }

    rowCount = Math.min(rowCount, MAX_ROWS);
    columnCount = Math.min(columnCount, MAX_COLUMNS);

    const columns: ColumnView[] = [];
    for (let columnIndex = 1; columnIndex <= columnCount; columnIndex += 1) {
      const column = sheet.getColumn(columnIndex);
      if (column.hidden) continue;
      columns.push({
        index: columnIndex,
        label: excelColumnName(columnIndex),
        width: excelColumnWidthToPixels(column.width),
        position: columns.length,
      });
    }

    const rows: RowView[] = [];
    for (let rowIndex = 1; rowIndex <= rowCount; rowIndex += 1) {
      const row = sheet.getRow(rowIndex);
      if (row.hidden) continue;
      rows.push({
        index: rowIndex,
        height: excelRowHeightToPixels(row.height),
        position: rows.length,
      });
    }

    const visibleRows = new Set(rows.map((row) => row.index));
    const visibleColumns = new Set(columns.map((column) => column.index));
    const rowPositions = new Map(rows.map((row) => [row.index, row.position]));
    const columnPositions = new Map(columns.map((column) => [column.index, column.position]));
    const mergesByCell = new Map<string, MergeRange>();
    const coveredCells = new Set<string>();

    mergeRanges.forEach((range) => {
      for (let rowIndex = range.top; rowIndex <= range.bottom; rowIndex += 1) {
        for (let columnIndex = range.left; columnIndex <= range.right; columnIndex += 1) {
          const address = `${excelColumnName(columnIndex)}${rowIndex}`;
          mergesByCell.set(address, range);
          if (address !== range.masterAddress) coveredCells.add(address);
        }
      }
    });

    const cells: CellView[] = [];
    rows.forEach((row) => {
      columns.forEach((column) => {
        const address = `${column.label}${row.index}`;
        if (coveredCells.has(address)) return;

        const merge = mergesByCell.get(address);
        const cell = sheet.getCell(row.index, column.index);
        const rowSpan = merge ? visibleSpan(merge.top, merge.bottom, visibleRows) : 1;
        const colSpan = merge ? visibleSpan(merge.left, merge.right, visibleColumns) : 1;
        const rowPosition = rowPositions.get(row.index) ?? row.position;
        const columnPosition = columnPositions.get(column.index) ?? column.position;

        cells.push({
          key: address,
          address,
          value: valueToText(cell),
          row: rowPosition,
          column: columnPosition,
          rowSpan,
          colSpan,
          style: cellStyle(cell),
        });
      });
    });

    return { name: sheet.name, columns, rows, cells };
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
  const gridTemplateColumns = `${ROW_HEADER_WIDTH}px ${activeSheet.columns.map((column) => `${column.width}px`).join(" ")}`;
  const gridTemplateRows = `${COLUMN_HEADER_HEIGHT}px ${activeSheet.rows.map((row) => `${row.height}px`).join(" ")}`;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-[1.4rem] border border-white/10 bg-[#f3f3f3] text-[#111827]">
      <div className="min-h-0 flex-1 overflow-auto bg-[#f7f7f7]">
        <div
          className="grid w-max min-w-full"
          style={{ gridTemplateColumns, gridTemplateRows }}
        >
          <div
            className="sticky left-0 top-0 z-30 border-b border-r border-[#c8c8c8] bg-[#e9ecef]"
            style={{ gridColumn: 1, gridRow: 1 }}
          />
          {activeSheet.columns.map((column) => (
            <div
              key={`column-${column.index}`}
              className="sticky top-0 z-20 flex items-center justify-center border-b border-r border-[#c8c8c8] bg-[#e9ecef] text-[11px] font-medium text-[#4b5563]"
              style={{ gridColumn: column.position + 2, gridRow: 1 }}
            >
              {column.label}
            </div>
          ))}
          {activeSheet.rows.map((row) => (
            <div
              key={`row-${row.index}`}
              className="sticky left-0 z-10 flex items-center justify-end border-b border-r border-[#c8c8c8] bg-[#e9ecef] px-2 text-[11px] font-normal text-[#4b5563]"
              style={{ gridColumn: 1, gridRow: row.position + 2 }}
            >
              {row.index}
            </div>
          ))}
          {activeSheet.cells.map((cell) => (
            <div
              key={cell.key}
              className="flex min-h-0 min-w-0 overflow-hidden border-b border-r border-[#d9d9d9] bg-white px-1.5 py-0.5 text-[11pt] leading-tight"
              style={{
                gridColumn: `${cell.column + 2} / span ${cell.colSpan}`,
                gridRow: `${cell.row + 2} / span ${cell.rowSpan}`,
                ...cell.style,
              }}
              title={cell.value}
            >
              <span className="min-w-0 overflow-hidden">{cell.value}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="flex min-h-10 items-center gap-1 overflow-x-auto border-t border-[#c8c8c8] bg-[#ececec] px-3 py-1.5">
        {sheets.map((sheet, index) => (
          <button
            key={sheet.name}
            type="button"
            className={`whitespace-nowrap rounded-t-md border px-3 py-1.5 text-xs transition-colors ${
              index === activeIndex
                ? "border-[#b7b7b7] border-b-white bg-white text-[#107c41]"
                : "border-transparent bg-transparent text-[#4b5563] hover:bg-white/70"
            }`}
            onClick={() => setActiveIndex(index)}
          >
            {sheet.name}
          </button>
        ))}
      </div>
    </div>
  );
}
