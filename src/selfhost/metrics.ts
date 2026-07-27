// Minimal Prometheus text-format metrics for the self-host runtime (#982 observability). A tiny in-process
// registry — counters (monotonic, incremented at the call site), gauges (sampled at scrape time via a
// callback, e.g. live queue depth), and histograms (latency distributions observed at the call site).
// Rendered at GET /metrics. No deps, no cardinality explosion: callers use a small fixed label set.
type Labels = Record<string, string>;
type GaugeSample = () => number | Promise<number>;
type GaugeVectorSample = () => VectorSample[] | Promise<VectorSample[]>;
type MetricType = "counter" | "gauge" | "histogram";

/** One labeled series in a {@link gaugeVector}'s result. */
export type VectorSample = { labels: Labels; value: number };

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
// A gauge whose LABEL SET varies scrape-to-scrape (e.g. the current top-N repos by backlog depth), rather than
// a fixed set registered once at startup -- see gaugeVector(). Kept as a SEPARATE registry from `gauges`
// (single-value samplers) rather than widening GaugeSample's return type: every existing gauge() call site
// returns a plain number, and threading an alternate array-of-labeled-values shape through that same map would
// force every reader (including renderMetrics' gauges loop) to branch on which shape a given entry holds.
const gaugeVectors = new Map<string, GaugeVectorSample>();
const histograms = new Map<string, HistogramState>();
export const DEFAULT_METRIC_META: readonly (readonly [string, MetricMeta])[] = [
  ["loopover_queue_pending", { help: "Current in-process queue depth.", type: "gauge" }],
  ["loopover_queue_dead", { help: "Current in-process dead queue depth.", type: "gauge" }],
  ["loopover_dlq_dead_lettered_recent", { help: "DLQ messages dead-lettered within the recent trailing window, sampled at scrape.", type: "gauge" }],
  ["loopover_queue_processing", { help: "Jobs currently claimed and mid-flight.", type: "gauge" }],
  ["loopover_queue_runnable_now", { help: "Pending jobs, any priority, currently due (run_after<=now).", type: "gauge" }],
  ["loopover_queue_live_pending", { help: "Current live-work queue depth.", type: "gauge" }],
  ["loopover_queue_live_runnable_now", { help: "Live (foreground) pending jobs currently due (run_after<=now).", type: "gauge" }],
  ["loopover_queue_maintenance_pending", { help: "Current maintenance-work queue depth.", type: "gauge" }],
  ["loopover_queue_oldest_live_pending_age_seconds", { help: "Age in seconds of the oldest live pending job.", type: "gauge" }],
  ["loopover_queue_oldest_live_runnable_age_seconds", { help: "Age in seconds of the oldest live pending job that is currently due.", type: "gauge" }],
  ["loopover_queue_oldest_maintenance_pending_age_seconds", { help: "Age in seconds of the oldest maintenance pending job.", type: "gauge" }],
  ["loopover_queue_backlog_convergence_pending", { help: "Pending+processing agent-regate-pr jobs tagged foreground_lane=backlog.", type: "gauge" }],
  ["loopover_queue_fresh_intake_pending", { help: "Pending+processing github-webhook jobs tagged foreground_lane=fresh.", type: "gauge" }],
  ["loopover_queue_backlog_by_repo", { help: "Top-N repos by backlog-convergence pending depth, this scrape.", type: "gauge" }],
  ["loopover_jobs_claimed_by_lane_total", { help: "Foreground jobs claimed via the backlog-vs-fresh-intake fairness lane.", type: "counter" }],
  ["loopover_github_rest_rate_limit_remaining", { help: "Newest observed GitHub REST rate-limit remaining count, by key scope.", type: "gauge" }],
  ["loopover_host_load_avg1_per_core", { help: "One-minute host load average normalized by CPU core count.", type: "gauge" }],
  ["loopover_clock_skew_seconds", { help: "Clock skew in seconds between this process and GitHub's server time (positive = ahead), sampled from a GitHub response Date header -- the App-JWT mint response locally, or the broker's own token-exchange response in brokered self-host mode (#9156). NaN (not 0, a real reachable skew value) until the first successful sample.", type: "gauge" }],
  ["loopover_clock_skew_sample_age_seconds", { help: "Seconds since the last successful clock-skew sample (loopover_clock_skew_seconds); ages from process start when no sample has landed yet (#9128), so a stale/never-sampled reading is always distinguishable from a fresh one -- alert on this exceeding a threshold, not on an exact sentinel value.", type: "gauge" }],
  ["loopover_uptime_seconds", { help: "Self-host process uptime in seconds.", type: "gauge" }],
  ["loopover_backup_acknowledged", { help: "1 when SQLite backup is acknowledged or Postgres is in use; 0 when the boot backup advisory would fire.", type: "gauge" }],
  ["loopover_config_dir_empty_acknowledged", { help: "1 when LOOPOVER_REPO_CONFIG_DIR is unset, has entries, or is acknowledged; 0 when it's configured but the mounted directory is empty.", type: "gauge" }],
  ["loopover_http_requests_total", { help: "HTTP app requests by response status class.", type: "counter" }],
  ["loopover_http_request_duration_seconds", { help: "HTTP app request duration in seconds.", type: "histogram" }],
  ["loopover_webhook_dedup_total", { help: "Webhook deliveries deduplicated before enqueue.", type: "counter" }],
  ["loopover_webhook_enqueue_total", { help: "Webhook enqueue outcomes by event and action.", type: "counter" }],
  ["loopover_jobs_enqueued_total", { help: "Durable queue jobs enqueued.", type: "counter" }],
  ["loopover_jobs_processed_total", { help: "Durable queue jobs processed successfully.", type: "counter" }],
  ["loopover_jobs_failed_total", { help: "Durable queue job processing failures.", type: "counter" }],
  ["loopover_jobs_dead_total", { help: "Durable queue jobs moved to dead status.", type: "counter" }],
  ["loopover_jobs_rate_limited_total", { help: "Durable queue jobs rate-limited before processing.", type: "counter" }],
  ["loopover_jobs_rate_limit_deferred_total", { help: "Durable queue jobs deferred by a rate-limit window.", type: "counter" }],
  ["loopover_jobs_coalesced_total", { help: "Durable queue jobs coalesced with an existing queued item.", type: "counter" }],
  ["loopover_jobs_recovered_total", { help: "Durable queue jobs recovered from stale in-flight state.", type: "counter" }],
  ["loopover_jobs_maintenance_admission_deferred_total", { help: "Maintenance jobs deferred by admission control.", type: "counter" }],
  ["loopover_jobs_enqueued_persisted_total", { help: "Persisted durable queue jobs enqueued.", type: "counter" }],
  ["loopover_jobs_processed_persisted_total", { help: "Persisted durable queue jobs processed successfully.", type: "counter" }],
  ["loopover_jobs_failed_persisted_total", { help: "Persisted durable queue job processing failures.", type: "counter" }],
  ["loopover_jobs_dead_persisted_total", { help: "Persisted durable queue jobs moved to dead status.", type: "counter" }],
  ["loopover_jobs_rate_limited_persisted_total", { help: "Persisted durable queue jobs rate-limited before processing.", type: "counter" }],
  ["loopover_jobs_rate_limit_deferred_persisted_total", { help: "Persisted durable queue jobs deferred by a rate-limit window.", type: "counter" }],
  ["loopover_jobs_coalesced_persisted_total", { help: "Persisted durable queue jobs coalesced with an existing queued item.", type: "counter" }],
  ["loopover_jobs_recovered_persisted_total", { help: "Persisted durable queue jobs recovered from stale in-flight state.", type: "counter" }],
  ["loopover_jobs_maintenance_admission_deferred_persisted_total", { help: "Persisted maintenance jobs deferred by admission control.", type: "counter" }],
  ["loopover_jobs_rate_limit_admission_deferred_total", { help: "Jobs deferred by rate-limit admission checks.", type: "counter" }],
  ["loopover_jobs_rate_limit_budget_deferred_total", { help: "Jobs deferred by rate-limit budget checks.", type: "counter" }],
  ["loopover_jobs_rate_limited_by_type_total", { help: "Jobs rate-limited by job type.", type: "counter" }],
  ["loopover_jobs_maintenance_admission_deferred_by_reason_total", { help: "Maintenance jobs deferred by reason.", type: "counter" }],
  ["loopover_jobs_installation_concurrency_deferred_total", { help: "Background jobs deferred by per-installation GitHub-fetch concurrency admission.", type: "counter" }],
  ["loopover_jobs_installation_concurrency_deferred_by_reason_total", { help: "Per-installation GitHub-fetch concurrency deferrals by reason and job type.", type: "counter" }],
  ["loopover_jobs_dead_letter_revived_total", { help: "Dead-letter jobs revived for retry.", type: "counter" }],
  ["loopover_jobs_foreground_liveness_released_total", { help: "Foreground-priority jobs force-released from a stale deferral by the liveness sweep.", type: "counter" }],
  ["loopover_jobs_foreground_liveness_released_by_reason_total", { help: "Foreground liveness releases by reason (age vs rate_limit_cleared).", type: "counter" }],
  ["loopover_dlq_dead_lettered_total", { help: "Messages moved to a dead-letter queue.", type: "counter" }],
  ["loopover_dlq_redriven_total", { help: "Dead-letter queue messages redriven into processing.", type: "counter" }],
  ["loopover_github_response_cache_total", { help: "GitHub response cache outcomes by response class.", type: "counter" }],
  ["loopover_github_graphql_cache_total", { help: "GitHub GraphQL cache outcomes by response class.", type: "counter" }],
  ["loopover_github_rest_rate_limit_observations_total", { help: "Observed GitHub REST rate-limit remaining buckets.", type: "counter" }],
  ["loopover_github_rest_rate_limit_responses_total", { help: "Observed GitHub REST rate-limit response statuses.", type: "counter" }],
  ["loopover_redis_gh_response_cache_total", { help: "Redis-backed GitHub response cache outcomes.", type: "counter" }],
  ["loopover_redis_gh_response_cache_hit_ratio", { help: "Redis GitHub response cache hit ratio (hits / (hits + misses)) at scrape time.", type: "gauge" }],
  ["loopover_redis_token_cache_total", { help: "Redis-backed GitHub token cache outcomes.", type: "counter" }],
  ["loopover_redis_webhook_dedup_cache_total", { help: "Redis-backed webhook-dedup cache outcomes.", type: "counter" }],
  ["loopover_qdrant_queries_total", { help: "Qdrant vector query attempts.", type: "counter" }],
  ["loopover_qdrant_upserts_total", { help: "Qdrant vector upserted item count.", type: "counter" }],
  ["loopover_qdrant_errors_total", { help: "Qdrant vector operation errors.", type: "counter" }],
  ["loopover_rag_pipeline_errors_total", { help: "RAG index-population pipeline errors (repo/path indexing), by op.", type: "counter" }],
  ["loopover_orb_events_exported_total", { help: "Orb events exported from the self-host runtime.", type: "counter" }],
  ["loopover_orb_export_errors_total", { help: "Orb event export errors.", type: "counter" }],
  ["loopover_orb_installed_repos_sync_failures_total", { help: "Brokered installed-repos sync failures (broker/GitHub errors during the cron sync).", type: "counter" }],
  ["loopover_orb_relay_drains_total", { help: "Orb relay drain outcomes.", type: "counter" }],
  ["loopover_orb_relay_drain_skipped_total", { help: "Pull-mode orb relay drain ticks skipped because the previous tick was still in flight.", type: "counter" }],
  ["loopover_orb_relay_register_consecutive_failures", { help: "Current consecutive orb relay registration failure streak, reset to 0 on any success.", type: "gauge" }],
  ["loopover_orb_relay_drain_consecutive_failures", { help: "Current consecutive pull-mode orb relay drain failure streak (drain threw), reset to 0 on any completed drain tick; always 0 in push mode.", type: "gauge" }],
  ["loopover_orb_relay_drain_seconds_since_last", { help: "Seconds since the pull-mode orb relay drain loop last completed successfully, or since process boot if it never has; -1 in push mode, where there is no drain loop.", type: "gauge" }],
  ["loopover_orb_webhook_total", { help: "Orb webhook outcomes.", type: "counter" }],
  ["loopover_orb_config_push_received_total", { help: "Config-push relay rows received and logged by the pull-drain loop (#7523).", type: "counter" }],
  ["loopover_ai_requests_total", { help: "AI provider request outcomes.", type: "counter" }],
  ["loopover_ai_cost_usd_total", { help: "Estimated AI provider cost in USD.", type: "counter" }],
  ["loopover_ai_input_tokens_total", { help: "AI provider input tokens consumed.", type: "counter" }],
  ["loopover_ai_output_tokens_total", { help: "AI provider output tokens produced.", type: "counter" }],
  ["loopover_ai_total_tokens_total", { help: "AI provider total tokens observed.", type: "counter" }],
  ["loopover_ai_provider_circuit_open_total", { help: "AI provider circuit-open events.", type: "counter" }],
  ["loopover_ai_provider_failures_total", { help: "AI provider failures by provider.", type: "counter" }],
  ["loopover_ai_provider_request_duration_seconds", { help: "AI provider request duration in seconds, by provider and request kind.", type: "histogram" }],
  ["loopover_ai_provider_request_errors_total", { help: "AI provider request errors, by provider and request kind (excludes expected embedding-routing fallbacks).", type: "counter" }],
  ["loopover_ai_review_cache_hit_total", { help: "AI review cache hits.", type: "counter" }],
  ["loopover_ai_review_cache_miss_total", { help: "AI review cache misses.", type: "counter" }],
  ["loopover_ai_review_cache_write_error_total", { help: "AI review cache write errors.", type: "counter" }],
  ["loopover_ai_slop_cache_hit_total", { help: "AI slop advisory cache hits.", type: "counter" }],
  ["loopover_ai_slop_cache_miss_total", { help: "AI slop advisory cache misses.", type: "counter" }],
  ["loopover_ai_slop_cache_write_error_total", { help: "AI slop advisory cache write errors.", type: "counter" }],
  ["loopover_ai_review_non_cacheable_total", { help: "AI reviews skipped by cacheability rules.", type: "counter" }],
  ["loopover_ai_review_force_bypass_total", { help: "AI review cache force-bypass events.", type: "counter" }],
  ["loopover_ai_review_inconclusive_total", { help: "AI review inconclusive outcomes.", type: "counter" }],
  ["loopover_ai_review_onmerge_clamped_total", { help: "AI review on-merge mode clamp events.", type: "counter" }],
  ["loopover_ai_review_model_fallback_total", { help: "AI review model fallback attempts by primary and fallback model.", type: "counter" }],
  ["loopover_regate_ai_skipped_current_total", { help: "Regate requests skipped because AI state is current.", type: "counter" }],
  ["loopover_public_surface_publish_skipped_current_total", { help: "Public surface publishes skipped because state is current.", type: "counter" }],
  ["loopover_gate_decisions_total", { help: "Gate decisions by conclusion.", type: "counter" }],
  ["loopover_precision_breaker_downgrades_total", { help: "Would-merge/would-close actions downgraded to a human hold by an accuracy circuit-breaker, by breaker direction.", type: "counter" }],
  ["loopover_agent_disposition_total", { help: "Final agent disposition per PR pass (merge/close/hold), by repo, action class, blocker-code class, and autonomy level.", type: "counter" }],
  ["loopover_merge_train_deferred_total", { help: "Merge-train FIFO gate deferrals (an older still-viable sibling held a merge), by repo and mode (audit/enforce).", type: "counter" }],
  ["loopover_reviews_published_total", { help: "Published review comments.", type: "counter" }],
  ["loopover_review_end_to_end_latency_seconds", { help: "Real end-to-end review latency in seconds, from the PR's current head SHA becoming ready for review (open + non-draft) to this pass's comment publish -- distinct from a single queue job's own claim-to-completion latency_ms, this spans every queueing/deferral wait in between.", type: "histogram" }],
  ["loopover_github_branch_protection_permission_denied_total", { help: "GitHub branch-protection reads denied by permissions.", type: "counter" }],
  ["loopover_github_pull_request_files_fetch_total", { help: "GitHub pull-request file fetch attempts.", type: "counter" }],
  ["loopover_pr_state_cache_total", { help: "Pull-request state cache outcomes.", type: "counter" }],
  ["loopover_ci_state_cache_total", { help: "CI-state snapshot cache outcomes.", type: "counter" }],
  ["loopover_ops_anomaly_total", { help: "Ops anomaly scan detections (review burst / review failure burst), by repo and kind.", type: "counter" }],
  ["loopover_d1_database_size_bytes", { help: "Cloudflare D1 database file size in bytes, from the opt-in Management API size/row-count probe (#3810); -1 when the probe is disabled or has never completed a successful sample.", type: "gauge" }],
  ["loopover_d1_table_row_count", { help: "Row count for a monitored D1 table, from the same probe as loopover_d1_database_size_bytes, labeled by table.", type: "gauge" }],
  ["loopover_signal_snapshots_rows_per_key", { help: "signal_snapshots row count divided by its distinct (signal_type, target_key) count, scoped to the latest-only-dedup signal types dedupeSignalSnapshots converges to ~1 row per key; -1 when the probe is disabled or has never completed a successful sample.", type: "gauge" }],
  ["loopover_d1_probe_errors_total", { help: "D1 size/row-count Management API probe failures, by part (database_info/table_row_count).", type: "counter" }],
  ["loopover_agent_action_permission_denied_total", { help: "Agent actions denied for missing a required GitHub App write permission, by action class.", type: "counter" }],
  ["loopover_agent_action_permission_denied_suppressed_total", { help: "Repeat permission denials suppressed within the cooldown window (still counted here, but not re-audited), by action class.", type: "counter" }],
  ["loopover_ai_review_frozen_reuse_total", { help: "AI review passes that reused a frozen (maintainer-gated) prior verdict instead of re-running.", type: "counter" }],
  ["loopover_ai_review_one_shot_reuse_total", { help: "AI review passes that reused a one-shot prior verdict instead of re-running.", type: "counter" }],
  ["loopover_ai_review_paused_reuse_total", { help: "AI review passes that reused a prior verdict because the repo is paused.", type: "counter" }],
  ["loopover_ai_review_tiebreak_order_unstable_total", { help: "Dual-reviewer tiebreak passes where reviewer order was not stable, by combine mode.", type: "counter" }],
  ["loopover_ai_review_verdict_flip_escalated_total", { help: "AI review verdict-flip escalations (#9016): a PR's fresh AI-judgment verdict oscillated past the flip threshold and was held for a human instead of trusting the newest roll.", type: "counter" }],
  ["loopover_grounding_cache_hit_total", { help: "Review grounding-context cache hits.", type: "counter" }],
  ["loopover_grounding_cache_miss_total", { help: "Review grounding-context cache misses.", type: "counter" }],
  ["loopover_impact_map_cache_hit_total", { help: "Impact-map cache hits.", type: "counter" }],
  ["loopover_impact_map_cache_miss_total", { help: "Impact-map cache misses.", type: "counter" }],
  ["loopover_installation_health_broker_probe_total", { help: "Installation-health broker probes, by result (ok/failed/mismatched_installation).", type: "counter" }],
  ["loopover_jobs_maintenance_admission_granted_under_pressure_total", { help: "Maintenance jobs admitted despite backpressure via the trickle-admission allowance.", type: "counter" }],
  ["loopover_jobs_maintenance_trickle_admitted_by_type_total", { help: "Maintenance jobs admitted via trickle admission, by job type.", type: "counter" }],
  ["loopover_linked_issue_satisfaction_cache_hit_total", { help: "Linked-issue satisfaction assessment cache hits.", type: "counter" }],
  ["loopover_linked_issue_satisfaction_cache_miss_total", { help: "Linked-issue satisfaction assessment cache misses.", type: "counter" }],
  ["loopover_linked_issue_satisfaction_cache_write_error_total", { help: "Linked-issue satisfaction assessment cache write errors.", type: "counter" }],
  ["loopover_active_review_reconciliation_terminalized_total", { help: "Orphaned active_review_tracking rows terminalized after a live GitHub check confirmed the PR is closed, by repo.", type: "counter" }],
  ["loopover_open_pr_reconciliation_missing_total", { help: "Open PRs found missing from local tracking during reconciliation, by repo.", type: "counter" }],
  ["loopover_orb_relay_malformed_events_total", { help: "Orb relay batch entries dropped for missing/mistyped required fields (deliveryId/eventName/rawBody).", type: "counter" }],
  ["loopover_orb_relay_multiple_live_enrollments_total", { help: "Forwarded orb events where more than one LIVE enrollment existed for the installation (a blue/green swap, or a secret rotated but not yet revoked) -- the winner is still elected deterministically, but the overlap is no longer silent (#9150).", type: "counter" }],
  ["loopover_orb_relay_register_total", { help: "Orb relay registration attempts, by mode and result (registered/recovered/failed).", type: "counter" }],
  ["loopover_pr_outcomes_total", { help: "Recorded PR gate outcomes, by decision.", type: "counter" }],
  ["loopover_close_audit_holdouts_total", { help: "Would-auto-close PRs diverted to human adjudication by the close-audit holdout (#8831).", type: "counter" }],
  ["loopover_public_origin_acknowledged", { help: "1 when the configured public origin is acknowledged as reachable; 0 otherwise.", type: "gauge" }],
  ["loopover_repo_culture_profile_cache_hit_total", { help: "Repo-culture-profile cache hits.", type: "counter" }],
  ["loopover_repo_culture_profile_cache_miss_total", { help: "Repo-culture-profile cache misses.", type: "counter" }],
  ["loopover_review_memory_cache_hit_total", { help: "Review-memory cache hits.", type: "counter" }],
  ["loopover_review_memory_cache_miss_total", { help: "Review-memory cache misses.", type: "counter" }],
  ["loopover_review_memory_suppressed_total", { help: "Review-memory entries suppressed from surfacing, by repo.", type: "counter" }],
  ["loopover_rees_enrich_requests_total", { help: "REES /v1/enrich call outcomes, by status (ok/empty/http_error/timeout/exception/skipped_auth_rejected).", type: "counter" }],
  ["loopover_rees_enrich_request_duration_seconds", { help: "REES /v1/enrich call duration in seconds, for calls that were actually attempted (excludes the auth-rejected circuit-breaker skip).", type: "histogram" }],
  ["loopover_metrics_sampler_errors_total", { help: "Scrape-time gauge sampler failures, by metric name -- a failing sampler previously emitted no series at all, silently. Any occurrence means that metric's value is currently invisible to Prometheus this scrape (see the sentinel gauges' own -1-on-failure convention).", type: "counter" }],
  ["loopover_review_source_fresh", { help: "1 when a review/ops/reputation source table has a row inside its own consumer's window, 0 when stale -- labeled by table and window_days. review_targets was silently orphaned by the 2026-06-22 convergence cutover for months before anyone noticed; this makes the next such orphaning loud instead.", type: "gauge" }],
  ["loopover_private_manifest_warnings_total", { help: "Private-manifest layer warnings (a malformed shared/global/repo config layer dropped during load), counted one per warning rather than one per load -- a sustained run means a mount is repeatedly serving truncated or invalid config (#9065).", type: "counter" }],
];
const metricMeta = new Map<string, MetricMeta>(DEFAULT_METRIC_META);

// These public counters are scraped without auth on the shared CLOUD worker, so redact repo labels at the
// counter call-site there. Self-hosted instances can opt out for established per-repo counters, but metrics
// with labels derived from private queue internals stay redacted because /metrics may be exposed by an
// operator's reverse proxy before application/session authentication.
let selfHostedMetricsMode = false;

/** Call ONCE at boot (self-host entrypoint only) to stop redacting `repo` from PRIVATE_REPO_LABEL_METRICS.
 *  Never called on the shared cloud worker, so its default (false, i.e. redact) stays byte-identical there. */
export function setSelfHostedMetricsMode(isSelfHosted: boolean): void {
  selfHostedMetricsMode = isSelfHosted;
}

// #9142: self-host mode used to serve the RAW repo label unchanged on PRIVATE_REPO_LABEL_METRICS -- /metrics
// is commonly scraped by an operator's reverse proxy before any application auth, and every self-hosted
// instance calls setSelfHostedMetricsMode(true) unconditionally at boot (server.ts), so every self-host
// deployment shipped raw private repo names on an effectively-unauthenticated endpoint by default. The
// pseudonym scheme below (stable per-repo redacted-N label, the SAME one ALWAYS_REDACT_REPO_LABEL_METRICS
// already uses) is now the default instead -- an operator's own dashboards still get a stable per-repo series
// to group by, just not the real name. An operator who has verified /metrics never leaves their private
// network and wants real repo names can opt back in with LOOPOVER_METRICS_REPO_LABELS=raw.
let rawSelfHostedRepoLabels = false;

/** Call ONCE at boot (self-host entrypoint only, alongside setSelfHostedMetricsMode) to opt back into raw
 *  (non-pseudonymized) repo labels on PRIVATE_REPO_LABEL_METRICS -- an explicit operator choice, never the
 *  default. Never called on the shared cloud worker. */
export function setSelfHostedRawRepoLabels(allowRaw: boolean): void {
  rawSelfHostedRepoLabels = allowRaw;
}

const PRIVATE_REPO_LABEL_METRICS = new Set([
  "loopover_gate_decisions_total",
  "loopover_reviews_published_total",
  "loopover_ops_anomaly_total",
]);
const ALWAYS_REDACT_REPO_LABEL_METRICS = new Set([
  "loopover_agent_disposition_total",
  "loopover_queue_backlog_by_repo",
  "loopover_merge_train_deferred_total",
]);
const redactedRepoLabels = new Map<string, string>();

function redactedRepoLabel(repo: string): string {
  const existing = redactedRepoLabels.get(repo);
  if (existing) return existing;
  const label = `redacted-${redactedRepoLabels.size + 1}`;
  redactedRepoLabels.set(repo, label);
  return label;
}

function publicLabelsForMetric(name: string, labels?: Labels): Labels | undefined {
  if (!labels || !("repo" in labels)) return labels;
  if (ALWAYS_REDACT_REPO_LABEL_METRICS.has(name)) return { ...labels, repo: redactedRepoLabel(labels.repo) };
  if (!PRIVATE_REPO_LABEL_METRICS.has(name)) return labels;
  // #9142: self-host mode defaults to the SAME pseudonym scheme as ALWAYS_REDACT_REPO_LABEL_METRICS (not the
  // cloud path's outright strip below -- a self-hosted operator legitimately wants a stable per-repo series
  // on their OWN metrics), unless the operator explicitly opted into raw labels.
  if (selfHostedMetricsMode) return rawSelfHostedRepoLabels ? labels : { ...labels, repo: redactedRepoLabel(labels.repo) };
  const publicLabels = { ...labels };
  delete publicLabels.repo;
  return Object.keys(publicLabels).length > 0 ? publicLabels : undefined;
}

// Request-latency buckets in seconds (Prometheus convention). Covers sub-ms health checks through
// multi-second webhook processing. Callers may pass their own buckets to observe().
export const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

// End-to-end review-latency buckets in seconds, minute-scale (unlike DEFAULT_BUCKETS' sub-10s request-latency
// range) -- covers the 1-5 minute target through well past the ~15-20 minute latency this metric exists to
// diagnose, with headroom for real outliers (deferred-to-CI-completion passes, backlog convergence).
export const REVIEW_LATENCY_BUCKETS = [10, 30, 60, 120, 180, 300, 600, 900, 1200, 1800, 3600, 7200];

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

/** Read a counter's current value (0 when the series has never been incremented). */
export function counterValue(name: string, labels?: Labels): number {
  const k = seriesKey(name, publicLabelsForMetric(name, labels));
  const value = counters.get(k);
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Hit ratio for cache tuning dashboards — 0 when there are no hit or miss samples yet. */
export function hitRatio(hits: number, misses: number): number {
  const total = hits + misses;
  if (total <= 0 || !Number.isFinite(total)) return 0;
  return hits / total;
}

/** Register a gauge sampled at scrape time (sync or async). Re-registering replaces the sampler. */
export function gauge(name: string, sample: GaugeSample): void {
  gauges.set(name, sample);
}

/** Register a gauge whose complete set of labeled series is recomputed fresh at EVERY scrape (sync or async
 *  sampler returning an array of `{ labels, value }`) -- for a dynamic, bounded-N breakdown (e.g. the top-10
 *  repos by backlog depth) where the label VALUES themselves change over time, not just the numbers. Because
 *  each scrape asks the sampler for the complete current set rather than reading back stale per-label state,
 *  a repo that drops out of the top-10 simply stops appearing on the next scrape -- no manual
 *  registration/deregistration bookkeeping, and no risk of a stale label lingering forever. Re-registering
 *  replaces the sampler, same as gauge(). */
export function gaugeVector(name: string, sample: GaugeVectorSample): void {
  gaugeVectors.set(name, sample);
}

/** Observe a value into a histogram (created on first use). `buckets` must be ascending upper bounds.
 *  #9142: labels are routed through publicLabelsForMetric (the same redaction incr()/gaugeVector() already
 *  apply) BEFORE being used as the series key or stored on the histogram -- previously this was the one
 *  metric-recording path that bypassed redaction entirely, including the ALWAYS_REDACT set. No histogram
 *  carries a `repo` label today, so this changes nothing observable yet; it closes the gap before one does. */
export function observe(name: string, value: number, labels?: Labels, buckets: number[] = DEFAULT_BUCKETS): void {
  const publicLabels = publicLabelsForMetric(name, labels);
  const k = seriesKey(name, publicLabels);
  let h = histograms.get(k);
  if (!h) {
    h = { name, labels: publicLabels, buckets, counts: new Array(buckets.length).fill(0), sum: 0, count: 0 };
    histograms.set(k, h);
  }
  // Cumulative bucketing: bump every bucket whose upper bound is >= the value.
  for (let i = 0; i < h.buckets.length; i++) {
    if (value <= h.buckets[i]!) h.counts[i]!++;
  }
  h.sum += value;
  h.count += 1;
}

/** Render the registry in Prometheus text exposition format. Counters render LAST (#9139): a gauge/
 *  gaugeVector sampler failure below increments loopover_metrics_sampler_errors_total AS PART OF the same
 *  render call, so counters must be read after those loops run, not before -- otherwise a THIS-scrape
 *  failure would only ever show up starting with the NEXT scrape's output, one full interval late. */
export async function renderMetrics(): Promise<string> {
  const lines: string[] = [];
  const emittedMeta = new Set<string>();
  for (const [name, sample] of gauges) {
    try {
      const value = await sample();
      pushMetricMeta(lines, emittedMeta, name);
      lines.push(`${name} ${value}`);
    } catch {
      // #9139: a throwing sampler previously emitted NO series at all -- indistinguishable in Grafana from
      // "idle"/"no data", and every alert rule reading it simply evaluated over an empty set (INACTIVE, not
      // FIRING) at exactly the DB-incident moment it exists to catch (loopover_queue_pending and friends are
      // all live DB reads -- see server.ts). Counting the failure AND still emitting a -1 sentinel series --
      // the SAME "impossible for a healthy gauge, so its absence is itself visible" convention
      // loopover_clock_skew_sample_age_seconds / loopover_d1_database_size_bytes already use for "never
      // sampled" -- turns a silently-empty scrape into an actionable, alertable signal.
      incr("loopover_metrics_sampler_errors_total", { metric: name });
      pushMetricMeta(lines, emittedMeta, name);
      lines.push(`${name} -1`);
    }
  }
  for (const [name, sample] of gaugeVectors) {
    try {
      const values = await sample();
      // An empty result is a valid scrape (e.g. no backlog-convergence work queued anywhere right now) -- emit
      // HELP/TYPE with zero series rather than skipping the metric name entirely, so a dashboard panel querying
      // it sees "no data" (not present) rather than a stale metric name lingering with no TYPE line at all.
      pushMetricMeta(lines, emittedMeta, name);
      for (const { labels, value } of values) {
        lines.push(`${seriesKey(name, publicLabelsForMetric(name, labels))} ${value}`);
      }
    } catch {
      // #9139: same failure-visibility fix as the plain-gauge loop above, but a gaugeVector's label SET is
      // unknown at failure time (that's the whole point of it), so there's no single value to sentinel --
      // counting the failure is still the actionable half; the metric name simply emits zero series this
      // scrape, same as its own pre-existing "legitimately empty" case just above.
      incr("loopover_metrics_sampler_errors_total", { metric: name });
      pushMetricMeta(lines, emittedMeta, name);
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
  // Rendered last (#9139) -- see this function's own header comment.
  for (const [k, v] of counters) {
    pushMetricMeta(lines, emittedMeta, metricNameFromSeriesKey(k));
    lines.push(`${k} ${v}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Test-only: clear all series and restore built-in metric metadata. */
export function resetMetrics(): void {
  counters.clear();
  gauges.clear();
  gaugeVectors.clear();
  histograms.clear();
  metricMeta.clear();
  redactedRepoLabels.clear();
  for (const [name, meta] of DEFAULT_METRIC_META) metricMeta.set(name, meta);
}
