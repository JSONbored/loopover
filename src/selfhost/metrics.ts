// Minimal Prometheus text-format metrics for the self-host runtime (#982 observability). A tiny in-process
// registry — counters (monotonic, incremented at the call site) and gauges (sampled at scrape time via a
// callback, e.g. live queue depth). Rendered at GET /metrics. No deps, no cardinality explosion: callers use
// a small fixed label set.
type Labels = Record<string, string>;
type GaugeSample = () => number | Promise<number>;

const counters = new Map<string, number>();
const gauges = new Map<string, GaugeSample>();

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
  const k = seriesKey(name, labels);
  counters.set(k, (counters.get(k) ?? 0) + by);
}

/** Register a gauge sampled at scrape time (sync or async). Re-registering replaces the sampler. */
export function gauge(name: string, sample: GaugeSample): void {
  gauges.set(name, sample);
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
  return `${lines.join("\n")}\n`;
}

/** Test-only: clear all series. */
export function resetMetrics(): void {
  counters.clear();
  gauges.clear();
}
