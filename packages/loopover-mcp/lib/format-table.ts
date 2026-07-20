// Pure, dependency-free monospace table renderer shared by the stdio CLI's report-shaped commands
// (#2231). Kept in lib/ (not the bin) so it can be unit-tested in isolation: the bin auto-runs its
// CLI/MCP entrypoint on import, so importable helpers live here instead.

export type TableHeader = { key: string; label?: string; align?: "left" | "right" };
export type TableRowObject = Record<string, unknown>;
export type TableRow = TableRowObject | unknown[] | null | undefined;
export type TableInput = TableRow[] | { headers?: (string | TableHeader)[]; rows?: TableRow[] };
export type FormatTableOptions = { align?: Record<string, "left" | "right">; gap?: number };

type NormalizedHeader = { key: string; label: string; align?: "left" | "right" | undefined };
type Normalized = { headers: NormalizedHeader[]; rows: TableRow[] };

// Normalize either an array of row objects or an explicit { headers, rows } shape into a common
// { headers, rows } form. For an array of objects the column set is the union of keys in first-seen
// order, and each key doubles as its own header label.
function normalizeInput(input: TableInput | undefined | null): Normalized {
  if (Array.isArray(input)) {
    const keys: string[] = [];
    for (const row of input) {
      for (const key of Object.keys(row ?? {})) if (!keys.includes(key)) keys.push(key);
    }
    return { headers: keys.map((key) => ({ key, label: key })), rows: input };
  }
  const headers = (input?.headers ?? []).map((header) =>
    typeof header === "string" ? { key: header, label: header } : { key: header.key, label: header.label ?? header.key, align: header.align },
  );
  return { headers, rows: input?.rows ?? [] };
}

function stringifyCell(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

// A row is either an object keyed by column key or a positional array; read the matching cell.
function readCell(row: TableRow, header: NormalizedHeader, columnIndex: number): unknown {
  if (Array.isArray(row)) return row[columnIndex];
  return (row as TableRowObject | undefined)?.[header.key];
}

function resolveAlign(header: NormalizedHeader, opts: FormatTableOptions): "left" | "right" {
  const fromOpts = opts.align && (opts.align[header.key] ?? opts.align[header.label]);
  return header.align ?? fromOpts ?? "left";
}

/**
 * Render tabular data as an aligned, monospace plain-text table (header row + one line per row).
 * Accepts an array of row objects, or `{ headers, rows }` with string/`{ key, label, align }`
 * headers and object/array rows. `opts.align` maps a column key/label to `"left"`|`"right"`;
 * `opts.gap` sets the space count between columns (default 2). Pure — no I/O, no dependencies.
 * Returns "" when there are no columns.
 */
export function formatTable(input?: TableInput | null, opts: FormatTableOptions = {}): string {
  const { headers, rows } = normalizeInput(input);
  if (headers.length === 0) return "";
  const gap = " ".repeat(Math.max(1, opts.gap ?? 2));
  const aligns = headers.map((header) => resolveAlign(header, opts));
  // Precompute every cell's text so column widths and the rendered rows read the same strings.
  const bodyCells = rows.map((row) => headers.map((header, column) => stringifyCell(readCell(row, header, column))));
  // Every `cells`/`widths` array here has exactly `headers.length` entries (built via headers.map), so
  // indexing by a column index drawn from that same range is always in bounds.
  const widths = headers.map((header, column) =>
    Math.max(header.label.length, ...bodyCells.map((cells) => cells[column]!.length), 0),
  );
  // Trim trailing padding so a left-aligned final column never emits dangling spaces.
  const renderRow = (cells: string[]) =>
    cells.map((text, column) => (aligns[column] === "right" ? text.padStart(widths[column]!) : text.padEnd(widths[column]!))).join(gap).replace(/\s+$/, "");
  return [renderRow(headers.map((header) => header.label)), ...bodyCells.map(renderRow)].join("\n");
}
