export const EXCLUDED_TABLES: Set<string>;
export const REDACTED_COLUMNS: Record<string, string[]>;

export type D1Row = Record<string, unknown>;

export type TableExport = {
  table: string;
  rowCount: number;
  redactedColumns: string[];
  checksum: string;
  rows: D1Row[];
};

export type ExportManifest = {
  tableCount: number;
  totalRows: number;
  tables: Array<{ table: string; rowCount: number; redactedColumns: string[]; checksum: string }>;
  [meta: string]: unknown;
};

export function isSafeTableName(name: unknown): boolean;
export function redactRow(table: string, row: D1Row): D1Row;
export function checksumRows(rows: D1Row[]): string;
export function filterRowsSince(rows: D1Row[], sinceColumn: string | undefined, sinceDate: string | undefined): D1Row[];
export function buildTableExport(table: string, rows: D1Row[], opts?: { sinceColumn?: string; sinceDate?: string }): TableExport | null;
export function buildExportManifest(tableExports: Array<TableExport | null>, meta?: Record<string, unknown>): ExportManifest;
