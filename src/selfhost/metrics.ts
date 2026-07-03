// Minimal Prometheus text-format metrics for the self-host runtime (#982 observability). A tiny in-process
// registry — counters (monotonic, incremented at the call site), gauges (sampled at scrape time via a
// callback, e.g. live queue depth), and histograms (latency distributions observed at the call site).
// Rendered at GET /metrics. No deps, no cardinality explosion: callers use a small fixed label set.
type Labels = Record<string, string>;
type GaugeSample = () => number | Promise<number>;
type MetricType = "counter" | "gauge" | "histogram";

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
const gauges = new Map<string, GaugeSample>();
const histograms = new Map<string, HistogramState>();
const DEFAULT_METRIC_META: readonly (readonly [string, MetricMeta])[] = [
  ["gittensory_queue_pending", { help: "Current in-process queue depth.", type: "gauge" }],
  ["gittensory_queue_dead", { help: "Current in-process dead queue depth.", type: "gauge" }],
  ["gittensory_queue_live_pending", { help: "Current live-work queue depth.", type: "gauge" }],
  ["gittensory_queue_maintenance_pending", { help: "Current maintenance-work queue depth.", type: "gauge" }],
  ["gittensory_queue_oldest_live_pending_age_seconds", { help: "Age in seconds of the oldest live pending job.", type: "gauge" }],
  ["gittensory_queue_oldest_maintenance_pending_age_seconds", { help: "Age in seconds of the oldest maintenance pending job.", type: "gauge" }],
  ["gittensory_host_load_avg1_per_core", { help: "One-minute host load average normalized by CPU core count.", type: "gauge" }],
  ["gittensory_uptime_seconds", { help: "Self-host process uptime in seconds.", type: "gauge" }],
  ["gittensory_http_requests_total", { help: "HTTP app requests by response status class.", type: "counter" }],
  ["gittensory_http_request_duration_seconds", { help: "HTTP app request duration in seconds.", type: "histogram" }],
  ["gittensory_webhook_dedup_total", { help: "Webhook deliveries deduplicated before enqueue.", type: "counter" }],
  ["gittensory_webhook_enqueue_total", { help: "Webhook enqueue outcomes by event and action.", type: "counter" }],
  ["gittensory_jobs_enqueued_total", { help: "Durable queue jobs enqueued.", type: "counter" }],
  ["gittensory_jobs_processed_total", { help: "Durable queue jobs processed successfully.", type: "counter" }],
  ["gittensory_jobs_failed_total", { help: "Durable queue job processing failures.", type: "counter" }],
  ["gittensory_jobs_dead_total", { help: "Durable queue jobs moved to dead status.", type: "counter" }],
  ["gittensory_jobs_rate_limited_total", { help: "Durable queue jobs rate-limited before processing.", type: "counter" }],
  ["gittensory_jobs_rate_limit_deferred_total", { help: "Durable queue jobs deferred by a rate-limit window.", type: "counter" }],
  ["gittensory_jobs_coalesced_total", { help: "Durable queue jobs coalesced with an existing queued item.", type: "counter" }],
  ["gittensory_jobs_recovered_total", { help: "Durable queue jobs recovered from stale in-flight state.", type: "counter" }],
  ["gittensory_jobs_maintenance_admission_deferred_total", { help: "Maintenance jobs deferred by admission control.", type: "counter" }],
  ["gittensory_jobs_enqueued_persisted_total", { help: "Persisted durable queue jobs enqueued.", type: "counter" }],
  ["gittensory_jobs_processed_persisted_total", { help: "Persisted durable queue jobs processed successfully.", type: "counter" }],
  ["gittensory_jobs_failed_persisted_total", { help: "Persisted durable queue job processing failures.", type: "counter" }],
  ["gittensory_jobs_dead_persisted_total", { help: "Persisted durable queue jobs moved to dead status.", type: "counter" }],
  ["gittensory_jobs_rate_limited_persisted_total", { help: "Persisted durable queue jobs rate-limited before processing.", type: "counter" }],
  ["gittensory_jobs_rate_limit_deferred_persisted_total", { help: "Persisted durable queue jobs deferred by a rate-limit window.", type: "counter" }],
  ["gittensory_jobs_coalesced_persisted_total", { help: "Persisted durable queue jobs coalesced with an existing queued item.", type: "counter" }],
  ["gittensory_jobs_recovered_persisted_total", { help: "Persisted durable queue jobs recovered from stale in-flight state.", type: "counter" }],
  ["gittensory_jobs_maintenance_admission_deferred_persisted_total", { help: "Persisted maintenance jobs deferred by admission control.", type: "counter" }],
  ["gittensory_jobs_rate_limit_admission_deferred_total", { help: "Jobs deferred by rate-limit admission checks.", type: "counter" }],
  ["gittensory_jobs_rate_limit_budget_deferred_total", { help: "Jobs deferred by rate-limit budget checks.", type: "counter" }],
  ["gittensory_jobs_rate_limited_by_type_total", { help: "Jobs rate-limited by job type.", type: "counter" }],
  ["gittensory_jobs_maintenance_admission_deferred_by_reason_total", { help: "Maintenance jobs deferred by reason.", type: "counter" }],
  ["gittensory_jobs_dead_letter_revived_total", { help: "Dead-letter jobs revived for retry.", type: "counter" }],
  ["gittensory_dlq_dead_lettered_total", { help: "Messages moved to a dead-letter queue.", type: "counter" }],
  ["gittensory_dlq_redriven_total", { help: "Dead-letter queue messages redriven into processing.", type: "counter" }],
  ["gittensory_github_response_cache_total", { help: "GitHub response cache outcomes by response class.", type: "counter" }],
  ["gittensory_github_graphql_cache_total", { help: "GitHub GraphQL cache outcomes by response class.", type: "counter" }],
  ["gittensory_github_rest_rate_limit_observations_total", { help: "Observed GitHub REST rate-limit remaining buckets.", type: "counter" }],
  ["gittensory_github_rest_rate_limit_responses_total", { help: "Observed GitHub REST rate-limit response statuses.", type: "counter" }],
  ["gittensory_redis_gh_response_cache_total", { help: "Redis-backed GitHub response cache outcomes.", type: "counter" }],
  ["gittensory_redis_token_cache_total", { help: "Redis-backed GitHub token cache outcomes.", type: "counter" }],
  ["gittensory_qdrant_queries_total", { help: "Qdrant vector query attempts.", type: "counter" }],
  ["gittensory_qdrant_upserts_total", { help: "Qdrant vector upserted item count.", type: "counter" }],
  ["gittensory_qdrant_errors_total", { help: "Qdrant vector operation errors.", type: "counter" }],
  ["gittensory_orb_events_exported_total", { help: "Orb events exported from the self-host runtime.", type: "counter" }],
  ["gittensory_orb_export_errors_total", { help: "Orb event export errors.", type: "counter" }],
  ["gittensory_orb_relay_drains_total", { help: "Orb relay drain outcomes.", type: "counter" }],
  ["gittensory_orb_webhook_total", { help: "Orb webhook outcomes.", type: "counter" }],
  ["gittensory_ai_requests_total", { help: "AI provider request outcomes.", type: "counter" }],
  ["gittensory_ai_cost_usd_total", { help: "Estimated AI provider cost in USD.", type: "counter" }],
  ["gittensory_ai_input_tokens_total", { help: "AI provider input tokens consumed.", type: "counter" }],
  ["gittensory_ai_output_tokens_total", { help: "AI provider output tokens produced.", type: "counter" }],
  ["gittensory_ai_total_tokens_total", { help: "AI provider total tokens observed.", type: "counter" }],
  ["gittensory_ai_provider_circuit_open_total", { help: "AI provider circuit-open events.", type: "counter" }],
  ["gittensory_ai_provider_failures_total", { help: "AI provider failures by provider.", type: "counter" }],
  ["gittensory_ai_review_cache_hit_total", { help: "AI review cache hits.", type: "counter" }],
  ["gittensory_ai_review_cache_miss_total", { help: "AI review cache misses.", type: "counter" }],
  ["gittensory_ai_review_cache_write_error_total", { help: "AI review cache write errors.", type: "counter" }],
  ["gittensory_ai_review_non_cacheable_total", { help: "AI reviews skipped by cacheability rules.", type: "counter" }],
  ["gittensory_ai_review_force_bypass_total", { help: "AI review cache force-bypass events.", type: "counter" }],
  ["gittensory_ai_review_inconclusive_total", { help: "AI review inconclusive outcomes.", type: "counter" }],
  ["gittensory_ai_review_onmerge_clamped_total", { help: "AI review on-merge mode clamp events.", type: "counter" }],
  ["gittensory_regate_ai_skipped_current_total", { help: "Regate requests skipped because AI state is current.", type: "counter" }],
  ["gittensory_public_surface_publish_skipped_current_total", { help: "Public surface publishes skipped because state is current.", type: "counter" }],
  ["gittensory_gate_decisions_total", { help: "Gate decisions by conclusion.", type: "counter" }],
  ["gittensory_reviews_published_total", { help: "Published review comments.", type: "counter" }],
  ["gittensory_github_branch_protection_permission_denied_total", { help: "GitHub branch-protection reads denied by permissions.", type: "counter" }],
  ["gittensory_github_pr_files_fetch_total", { help: "GitHub pull-request file fetch attempts.", type: "counter" }],
  ["gittensory_pr_state_cache_total", { help: "Pull-request state cache outcomes.", type: "counter" }],
];
const metricMeta = new Map<string, MetricMeta>(DEFAULT_METRIC_META);

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

/** Register Prometheus HELP/TYPE metadata for a metric name. */
export function registerMetricMeta(name: string, meta: MetricMeta): void {
  metricMeta.set(name, { help: meta.help, type: meta.type });
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
  const emittedMeta = new Set<string>();
  for (const [k, v] of counters) {
    pushMetricMeta(lines, emittedMeta, metricNameFromSeriesKey(k));
    lines.push(`${k} ${v}`);
  }
  for (const [name, sample] of gauges) {
    try {
      const value = await sample();
      pushMetricMeta(lines, emittedMeta, name);
      lines.push(`${name} ${value}`);
    } catch {
      /* a failing sampler must not break the scrape */
    }
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
  gauges.clear();
  histograms.clear();
  metricMeta.clear();
  for (const [name, meta] of DEFAULT_METRIC_META) metricMeta.set(name, meta);
}
