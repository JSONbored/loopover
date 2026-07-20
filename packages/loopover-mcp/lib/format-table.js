// Pure, dependency-free monospace table renderer shared by the stdio CLI's report-shaped commands
// (#2231). Kept in lib/ (not the bin) so it can be unit-tested in isolation: the bin auto-runs its
// CLI/MCP entrypoint on import, so importable helpers live here instead.
// Normalize either an array of row objects or an explicit { headers, rows } shape into a common
// { headers, rows } form. For an array of objects the column set is the union of keys in first-seen
// order, and each key doubles as its own header label.
function normalizeInput(input) {
    if (Array.isArray(input)) {
        const keys = [];
        for (const row of input) {
            for (const key of Object.keys(row ?? {}))
                if (!keys.includes(key))
                    keys.push(key);
        }
        return { headers: keys.map((key) => ({ key, label: key })), rows: input };
    }
    const headers = (input?.headers ?? []).map((header) => typeof header === "string" ? { key: header, label: header } : { key: header.key, label: header.label ?? header.key, align: header.align });
    return { headers, rows: input?.rows ?? [] };
}
function stringifyCell(value) {
    return value === undefined || value === null ? "" : String(value);
}
// A row is either an object keyed by column key or a positional array; read the matching cell.
function readCell(row, header, columnIndex) {
    if (Array.isArray(row))
        return row[columnIndex];
    return row?.[header.key];
}
function resolveAlign(header, opts) {
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
export function formatTable(input, opts = {}) {
    const { headers, rows } = normalizeInput(input);
    if (headers.length === 0)
        return "";
    const gap = " ".repeat(Math.max(1, opts.gap ?? 2));
    const aligns = headers.map((header) => resolveAlign(header, opts));
    // Precompute every cell's text so column widths and the rendered rows read the same strings.
    const bodyCells = rows.map((row) => headers.map((header, column) => stringifyCell(readCell(row, header, column))));
    // Every `cells`/`widths` array here has exactly `headers.length` entries (built via headers.map), so
    // indexing by a column index drawn from that same range is always in bounds.
    const widths = headers.map((header, column) => Math.max(header.label.length, ...bodyCells.map((cells) => cells[column].length), 0));
    // Trim trailing padding so a left-aligned final column never emits dangling spaces.
    const renderRow = (cells) => cells.map((text, column) => (aligns[column] === "right" ? text.padStart(widths[column]) : text.padEnd(widths[column]))).join(gap).replace(/\s+$/, "");
    return [renderRow(headers.map((header) => header.label)), ...bodyCells.map(renderRow)].join("\n");
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZm9ybWF0LXRhYmxlLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiZm9ybWF0LXRhYmxlLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLGtHQUFrRztBQUNsRyxtR0FBbUc7QUFDbkcseUVBQXlFO0FBV3pFLGdHQUFnRztBQUNoRyxvR0FBb0c7QUFDcEcsdURBQXVEO0FBQ3ZELFNBQVMsY0FBYyxDQUFDLEtBQW9DO0lBQzFELElBQUksS0FBSyxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDO1FBQ3pCLE1BQU0sSUFBSSxHQUFhLEVBQUUsQ0FBQztRQUMxQixLQUFLLE1BQU0sR0FBRyxJQUFJLEtBQUssRUFBRSxDQUFDO1lBQ3hCLEtBQUssTUFBTSxHQUFHLElBQUksTUFBTSxDQUFDLElBQUksQ0FBQyxHQUFHLElBQUksRUFBRSxDQUFDO2dCQUFFLElBQUksQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLEdBQUcsQ0FBQztvQkFBRSxJQUFJLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDO1FBQ3BGLENBQUM7UUFDRCxPQUFPLEVBQUUsT0FBTyxFQUFFLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxHQUFHLEVBQUUsRUFBRSxDQUFDLENBQUMsRUFBRSxHQUFHLEVBQUUsS0FBSyxFQUFFLEdBQUcsRUFBRSxDQUFDLENBQUMsRUFBRSxJQUFJLEVBQUUsS0FBSyxFQUFFLENBQUM7SUFDNUUsQ0FBQztJQUNELE1BQU0sT0FBTyxHQUFHLENBQUMsS0FBSyxFQUFFLE9BQU8sSUFBSSxFQUFFLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxNQUFNLEVBQUUsRUFBRSxDQUNwRCxPQUFPLE1BQU0sS0FBSyxRQUFRLENBQUMsQ0FBQyxDQUFDLEVBQUUsR0FBRyxFQUFFLE1BQU0sRUFBRSxLQUFLLEVBQUUsTUFBTSxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsR0FBRyxFQUFFLE1BQU0sQ0FBQyxHQUFHLEVBQUUsS0FBSyxFQUFFLE1BQU0s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