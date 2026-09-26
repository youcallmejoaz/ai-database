import type pg from "pg";

/** A query result in the compact shape sent to both Claude and the UI. */
export interface TableResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  note?: string;
}

const MAX_CELL_CHARS = 500;

/** Make a single cell JSON-friendly and short enough to show. */
export function cell(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? String(value) : value.toISOString();
  if (Buffer.isBuffer(value)) return `<binary, ${value.length} bytes>`;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    return value.length > MAX_CELL_CHARS ? `${value.slice(0, MAX_CELL_CHARS)}… (${value.length} chars)` : value;
  }
  if (typeof value === "object") {
    const json = JSON.stringify(value);
    return json.length > MAX_CELL_CHARS ? `${json.slice(0, MAX_CELL_CHARS)}… (${json.length} chars)` : value;
  }
  return value;
}

/**
 * Build a TableResult from array-mode rows, stopping early if the rows exceed
 * `maxRows` or the serialized size exceeds `maxBytes`.
 */
export function toTableResult(
  fields: pg.FieldDef[],
  rawRows: unknown[][],
  opts: { maxRows: number; maxBytes: number; moreRowsExist?: boolean },
): TableResult {
  const columns = fields.map((f) => f.name);
  const rows: unknown[][] = [];
  let bytes = JSON.stringify(columns).length;
  let truncated = Boolean(opts.moreRowsExist) || rawRows.length > opts.maxRows;
  for (const raw of rawRows.slice(0, opts.maxRows)) {
    const row = raw.map(cell);
    bytes += JSON.stringify(row).length + 1;
    if (bytes > opts.maxBytes) {
      truncated = true;
      break;
    }
    rows.push(row);
  }
  const result: TableResult = { columns, rows, rowCount: rows.length, truncated };
  if (truncated) {
    result.note = `Only the first ${rows.length} rows are shown. Add filters, aggregates or a LIMIT to narrow the result.`;
  }
  return result;
}
