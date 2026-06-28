// Minimal Prometheus text-format metrics for the self-host runtime (#982 observability). A tiny in-process
// registry — counters (monotonic, incremented at the call site), gauges (sampled at scrape time via a
// callback, e.g. live queue depth), and histograms (latency distributions observed at the call site).
// Rendered at GET /metrics. No deps, no cardinality explosion: callers use a small fixed label set.
type Labels = Record<string, string>;
type GaugeSample = () => number | Promise<number>;

interface HistogramState {
  name: string;
  labels: Labels | undefined;
  buckets: number[]; // upper bounds (le), ascending
  counts: number[]; // cumulative count of observations <= buckets[i]
  sum: number;
  count: number;
}

const counters = new Map<string, number>();
const gauges = new Map<string, GaugeSample>();
const histograms = new Map<string, HistogramState>();

// These public counters are scraped without auth; redact repo labels at the counter call-site.
const PRIVATE_REPO_LABEL_METRICS = new Set([
  "gittensory_gate_decisions_total",
  "gittensory_reviews_published_total",
]);

function publicLabelsForMetric(name: string, labels?: Labels): Labels | undefined {
  if (!labels || !PRIVATE_REPO_LABEL_METRICS.has(name) || !("repo" in labels)) return labels;
  const publicLabels = { ...labels };
  delete publicLabels.repo;
  return Object.keys(publicLabels).length > 0 ? publicLabels : undefined;
}

// Request-latency buckets in seconds (Prometheus convention). Covers sub-ms health checks through
// multi-second webhook processing. Callers may pass their own buckets to observe().
export const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

function seriesKey(name: string, labels?: Labels): string {
  if (!labels || Object.keys(labels).length === 0) return name;
  const inner = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`)
    .join(",");
  return `${name}{${inner}}`;
}

/** Increment a monotonic counter (created on first use). */
export function incr(name: string, labels?: Labels, by = 1): void {
  const k = seriesKey(name, publicLabelsForMetric(name, labels));
  counters.set(k, (counters.get(k) ?? 0) + by);
}

/** Register a gauge sampled at scrape time (sync or async). Re-registering replaces the sampler. */
export function gauge(name: string, sample: GaugeSample): void {
  gauges.set(name, sample);
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
export async function renderMetrics(): Promise<string> {
  const lines: string[] = [];
  for (const [k, v] of counters) lines.push(`${k} ${v}`);
  for (const [name, sample] of gauges) {
    try {
      lines.push(`${name} ${await sample()}`);
    } catch {
      /* a failing sampler must not break the scrape */
    }
  }
  for (const h of histograms.values()) {
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

/** Test-only: clear all series. */
export function resetMetrics(): void {
  counters.clear();
  gauges.clear();
  histograms.clear();
}
