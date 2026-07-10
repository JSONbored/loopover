/** RFC-4180-style CSV cell escaping for client-side ledger exports (#2198). */
export function escapeCsvCell(value: string): string {
  const needsFormulaGuard = /^[=+\-@]/.test(value);
  const guarded = needsFormulaGuard ? `'${value}` : value;
  const needsQuotes = /[",\n\r]/.test(guarded);
  const escaped = guarded.replace(/"/g, '""');
  return needsQuotes ? `"${escaped}"` : escaped;
}

/** Serialize typed rows to a CSV string (no trailing newline requirement). */
export function toCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => row.map(escapeCsvCell).join(",")).join("\n");
}

/** Trigger a browser download for a generated CSV blob. */
export function downloadCsvText(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export type AnalyticsLedgerCsvInput = {
  metrics: ReadonlyArray<{ label: string; value: string; delta: string }>;
  weeklyValueReport?: {
    metrics: ReadonlyArray<{ id: string; label: string; value: number; detail: string }>;
  };
  usageSummary?: {
    byEvent: ReadonlyArray<{ eventName: string; count: number }>;
    bySurface: ReadonlyArray<{ surface: string; count: number }>;
  };
};

/** Flatten the loaded operator-dashboard payload into exportable ledger rows. */
export function operatorDashboardToCsvRows(data: AnalyticsLedgerCsvInput): string[][] {
  const rows: string[][] = [["section", "key", "value", "detail"]];

  for (const metric of data.metrics) {
    rows.push(["metric", metric.label, metric.value, metric.delta]);
  }

  for (const metric of data.weeklyValueReport?.metrics ?? []) {
    rows.push(["weekly_value", metric.label, String(metric.value), metric.detail]);
  }

  for (const row of data.usageSummary?.byEvent ?? []) {
    rows.push(["usage_event", row.eventName, String(row.count), ""]);
  }

  for (const row of data.usageSummary?.bySurface ?? []) {
    rows.push(["usage_surface", row.surface, String(row.count), ""]);
  }

  return rows;
}

export function exportOperatorDashboardCsv(data: AnalyticsLedgerCsvInput): void {
  const day = new Date().toISOString().slice(0, 10);
  downloadCsvText(`gittensory-analytics-${day}.csv`, toCsv(operatorDashboardToCsvRows(data)));
}
