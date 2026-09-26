import type { TableResult } from "@/lib/results";

// Postgres numeric and bigint values arrive as strings; align them like numbers.
const NUMERIC = /^-?\d+(\.\d+)?$/;

function cellClass(value: unknown): string | undefined {
  if (value === null) return "null";
  if (typeof value === "number" || (typeof value === "string" && NUMERIC.test(value))) return "num";
  return undefined;
}

function display(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function ResultTable({ result }: { result: TableResult }) {
  if (result.columns.length === 0) return <p className="muted">No columns returned.</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {result.columns.map((column, i) => (
              <th key={i}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.length === 0 ? (
            <tr>
              <td colSpan={result.columns.length} className="muted">
                No rows.
              </td>
            </tr>
          ) : (
            result.rows.map((row, r) => (
              <tr key={r}>
                {row.map((value, c) => (
                  <td key={c} className={cellClass(value)}>
                    {display(value)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
      <p className="table-meta">
        {result.rowCount} row{result.rowCount === 1 ? "" : "s"}
        {result.truncated ? " shown (more exist)" : ""}
      </p>
    </div>
  );
}
