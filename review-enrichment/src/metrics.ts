// Minimal Prometheus text-format metrics for REES (#5367 observability). A tiny in-process registry —
// counters (monotonic, incremented at the call site) and histograms (latency distributions observed at the
// call site) — rendered at GET /metrics. Deliberately smaller than the main app's src/selfhost/metrics.ts:
// REES is a separate deployable (own package, own build, sometimes deployed standalone on Railway) and has no
// gauges, dynamic label-set gauges, or per-repo redaction needs today, so those pieces aren't duplicated here.
type Labels = Record<string, string>;
type MetricType = "counter" | "histogram";

export type MetricMeta = {
  help: string;
  type: MetricType;
};

interface HistogramState {
  name: string;
  labels: Labels | undefined;
  buckets: number[]; // upper bounds (le), ascending
  counts: number[]; // cumulative count of observations <= buckets[i]
  sum: number;
  count: number;
}

const counters = new Map<string, number>();
const histograms = new Map<string, HistogramState>();

export const DEFAULT_METRIC_META: readonly (readonly [string, MetricMeta])[] = [
  ["rees_enrich_requests_total", { help: "REES /v1/enrich call outcomes, by status (ok/unauthorized/service_not_configured/bad_request/error).", type: "counter" }],
  ["rees_enrich_request_duration_seconds", { help: "REES /v1/enrich request handling duration in seconds.", type: "histogram" }],
  ["rees_analyzer_runs_total", { help: "REES analyzer run outcomes, by analyzer name and status (ok/degraded/timeout/capped/skipped).", type: "counter" }],
  ["rees_analyzer_duration_seconds", { help: "REES per-analyzer execution duration in seconds, for analyzers that actually ran (ok/degraded/timeout).", type: "histogram" }],
];
const metricMeta = new Map<string, MetricMeta>(DEFAULT_METRIC_META);

// Request-latency buckets in seconds (Prometheus convention). Covers sub-ms analyzer checks through a
// multi-second full /v1/enrich pass under the "deep" profile.
export const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

function seriesKey(name: string, labels?: Labels): string {
  if (!labels || Object.keys(labels).length === 0) return name;
  const inner = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`)
    .join(",");
  return `${name}{${inner}}`;
}

function metricNameFromSeriesKey(key: string): string {
  const labelsStart = key.indexOf("{");
  return labelsStart === -1 ? key : key.slice(0, labelsStart);
}

function escapeHelpText(help: string): string {
  return help.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

function pushMetricMeta(lines: string[], emitted: Set<string>, name: string): void {
  if (emitted.has(name)) return;
  const meta = metricMeta.get(name);
  if (!meta) return;
  lines.push(`# HELP ${name} ${escapeHelpText(meta.help)}`);
  lines.push(`# TYPE ${name} ${meta.type}`);
  emitted.add(name);
}

/** Increment a monotonic counter (created on first use). */
export function incr(name: string, labels?: Labels, by = 1): void {
  const k = seriesKey(name, labels);
  counters.set(k, (counters.get(k) ?? 0) + by);
}

/** Read a counter's current value (0 when the series has never been incremented). Test/introspection only. */
export function counterValue(name: string, labels?: Labels): number {
  const k = seriesKey(name, labels);
  const value = counters.get(k);
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Observe a value into a histogram (created on first use). `buckets` must be ascending upper bounds. */
export function observe(name: string, value: number, labels?: Labels, buckets: number[] = DEFAULT_BUCKETS): void {
  const k = seriesKey(name, labels);
  let h = histograms.get(k);
  if (!h) {
    h = { name, labels, buckets, counts: new Array(buckets.length).fill(0), sum: 0, count: 0 };
    histograms.set(k, h);
  }
  // Cumulative bucketing: bump every bucket whose upper bound is >= the value.
  for (let i = 0; i < h.buckets.length; i++) {
    if (value <= h.buckets[i]!) h.counts[i]!++;
  }
  h.sum += value;
  h.count += 1;
}

/** Render the registry in Prometheus text exposition format. */
export function renderMetrics(): string {
  const lines: string[] = [];
  const emittedMeta = new Set<string>();
  for (const [k, v] of counters) {
    pushMetricMeta(lines, emittedMeta, metricNameFromSeriesKey(k));
    lines.push(`${k} ${v}`);
  }
  for (const h of histograms.values()) {
    pushMetricMeta(lines, emittedMeta, h.name);
    for (let i = 0; i < h.buckets.length; i++) {
      lines.push(`${seriesKey(`${h.name}_bucket`, { ...h.labels, le: String(h.buckets[i]) })} ${h.counts[i]}`);
    }
    // The +Inf bucket equals the total observation count (Prometheus requires it).
    lines.push(`${seriesKey(`${h.name}_bucket`, { ...h.labels, le: "+Inf" })} ${h.count}`);
    lines.push(`${seriesKey(`${h.name}_sum`, h.labels)} ${h.sum}`);
    lines.push(`${seriesKey(`${h.name}_count`, h.labels)} ${h.count}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Test-only: clear all series and restore built-in metric metadata. */
export function resetMetrics(): void {
  counters.clear();
  histograms.clear();
  metricMeta.clear();
  for (const [name, meta] of DEFAULT_METRIC_META) metricMeta.set(name, meta);
}
